package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type PutMeta struct {
	Xfer    uint32 `json:"xfer"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	MtimeMs int64  `json:"mtimeMs"`
	Hash    string `json:"hash"`
}

type incoming struct {
	meta     PutMeta
	tmp      *os.File
	tmpPath  string
	received int64
	chunks   int
}

// incomingTree is a streaming unpacker for a TREE_PUT archive: entries are
// [u32le header-len][JSON header {path,size,mode,mtimeMs,hash}][raw bytes],
// delivered in order via FILE_CHUNK frames under one xfer id.
type incomingTree struct {
	xfer     uint32
	size     int64 // total archive bytes announced
	received int64
	chunks   int
	buf      []byte // unconsumed carry-over (partial header or entry tail)
	cur      *PutMeta
	curFile  *os.File
	curPath  string // tmp path of current entry
	curLeft  int64
	skipping bool // current entry discarded (LWW local-win / bad path)
	skipped  []string
}

// Receiver applies host→guest file operations.
type Receiver struct {
	mu     sync.Mutex
	root   string
	fw     *FrameWriter
	xfers  map[uint32]*incoming
	trees  map[uint32]*incomingTree
	sync   *SyncState
	verify bool // re-hash received files (console); TCP+frame-CRC skips it
}

func NewReceiver(root string, fw *FrameWriter, ss *SyncState) *Receiver {
	return &Receiver{root: root, fw: fw, xfers: map[uint32]*incoming{},
		trees: map[uint32]*incomingTree{}, sync: ss, verify: true}
}

// NewReceiverNoVerify skips the sha256 read-back pass on completed files.
// Used on the data plane: every frame is CRC32-checked on top of TCP
// checksums, and the extra full pass over each file costs real time on the
// emulated CPU.
func NewReceiverNoVerify(root string, fw *FrameWriter, ss *SyncState) *Receiver {
	return &Receiver{root: root, fw: fw, xfers: map[uint32]*incoming{},
		trees: map[uint32]*incomingTree{}, sync: ss, verify: false}
}

func (rc *Receiver) ack(seq uint32, extra map[string]any) {
	m := map[string]any{"ack": seq}
	for k, v := range extra {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	rc.fw.Send(TypeAck, b)
}

func (rc *Receiver) nak(seq uint32, err string, extra map[string]any) {
	m := map[string]any{"ack": seq, "error": err}
	for k, v := range extra {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	rc.fw.Send(TypeNak, b)
}

func (rc *Receiver) HandlePut(f *Frame) {
	var meta PutMeta
	if err := json.Unmarshal(f.Payload, &meta); err != nil {
		rc.nak(f.Seq, "bad FILE_PUT json", nil)
		return
	}
	abs, ok := safeJoin(rc.root, meta.Path)
	if !ok {
		rc.nak(f.Seq, "illegal path", map[string]any{"xfer": meta.Xfer})
		return
	}
	// Conflict check: local content changed since last sync → LWW.
	if winner, conflict := rc.sync.ResolveIncoming(meta, abs); conflict && winner == "local" {
		rc.nak(f.Seq, "conflict: local wins", map[string]any{"xfer": meta.Xfer, "conflict": true})
		return
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		rc.nak(f.Seq, err.Error(), map[string]any{"xfer": meta.Xfer})
		return
	}
	tmpDir := filepath.Join(rc.root, tmpDirName)
	os.MkdirAll(tmpDir, 0700)
	tmp, err := os.CreateTemp(tmpDir, "put-*")
	if err != nil {
		rc.nak(f.Seq, err.Error(), map[string]any{"xfer": meta.Xfer})
		return
	}
	rc.mu.Lock()
	rc.xfers[meta.Xfer] = &incoming{meta: meta, tmp: tmp, tmpPath: tmp.Name()}
	rc.mu.Unlock()
	if meta.Size == 0 {
		rc.finish(f.Seq, rc.xfers[meta.Xfer])
		return
	}
	rc.ack(f.Seq, map[string]any{"xfer": meta.Xfer})
}

func (rc *Receiver) HandleChunk(f *Frame) {
	if len(f.Payload) < 12 {
		rc.nak(f.Seq, "short chunk", nil)
		return
	}
	xfer := binary.LittleEndian.Uint32(f.Payload[0:4])
	offset := int64(binary.LittleEndian.Uint64(f.Payload[4:12]))
	data := f.Payload[12:]
	rc.mu.Lock()
	in := rc.xfers[xfer]
	tr := rc.trees[xfer]
	rc.mu.Unlock()
	if tr != nil {
		rc.handleTreeChunk(f.Seq, tr, offset, data)
		return
	}
	if in == nil {
		rc.nak(f.Seq, "unknown xfer", map[string]any{"xfer": xfer})
		return
	}
	if _, err := in.tmp.WriteAt(data, offset); err != nil {
		rc.abort(f.Seq, in, err.Error())
		return
	}
	in.received += int64(len(data))
	in.chunks++
	if in.received >= in.meta.Size {
		rc.finish(f.Seq, in)
	} else if in.chunks%16 == 0 {
		rc.ack(f.Seq, map[string]any{"xfer": xfer, "received": in.received})
	}
}

func (rc *Receiver) finish(seq uint32, in *incoming) {
	in.tmp.Close()
	if rc.verify {
		h, err := hashFile(in.tmpPath)
		if err != nil || h != in.meta.Hash {
			rc.abort(seq, in, fmt.Sprintf("hash mismatch: got %s want %s", h, in.meta.Hash))
			return
		}
	}
	abs, _ := safeJoin(rc.root, in.meta.Path)
	os.Chmod(in.tmpPath, os.FileMode(in.meta.Mode))
	mt := time.UnixMilli(in.meta.MtimeMs)
	os.Chtimes(in.tmpPath, mt, mt)
	if err := os.Rename(in.tmpPath, abs); err != nil {
		rc.abort(seq, in, err.Error())
		return
	}
	rc.sync.MarkSynced(in.meta.Path, in.meta.Hash)
	rc.mu.Lock()
	delete(rc.xfers, in.meta.Xfer)
	rc.mu.Unlock()
	rc.ack(seq, map[string]any{"xfer": in.meta.Xfer, "done": true})
}

func (rc *Receiver) abort(seq uint32, in *incoming, msg string) {
	log.Printf("xfer %d (%s) aborted: %s", in.meta.Xfer, in.meta.Path, msg)
	in.tmp.Close()
	os.Remove(in.tmpPath)
	rc.mu.Lock()
	delete(rc.xfers, in.meta.Xfer)
	rc.mu.Unlock()
	rc.nak(seq, msg, map[string]any{"xfer": in.meta.Xfer})
}

// HandleTreePut announces a batched small-file archive (see PROTOCOL.md).
func (rc *Receiver) HandleTreePut(f *Frame) {
	var meta struct {
		Xfer  uint32 `json:"xfer"`
		Size  int64  `json:"size"`
		Count int    `json:"count"`
	}
	if err := json.Unmarshal(f.Payload, &meta); err != nil {
		rc.nak(f.Seq, "bad TREE_PUT json", nil)
		return
	}
	tr := &incomingTree{xfer: meta.Xfer, size: meta.Size}
	rc.mu.Lock()
	rc.trees[meta.Xfer] = tr
	rc.mu.Unlock()
	if meta.Size == 0 {
		rc.finishTree(f.Seq, tr)
	}
	// no ready-ack: the host streams chunks immediately (TCP ordering)
}

func (rc *Receiver) handleTreeChunk(seq uint32, tr *incomingTree, offset int64, data []byte) {
	if offset != tr.received {
		rc.abortTree(seq, tr, fmt.Sprintf("out-of-order tree chunk: got %d want %d", offset, tr.received))
		return
	}
	tr.received += int64(len(data))
	tr.chunks++
	if err := rc.unpack(tr, data); err != nil {
		rc.abortTree(seq, tr, err.Error())
		return
	}
	if tr.received >= tr.size {
		rc.finishTree(seq, tr)
	} else if tr.chunks%16 == 0 {
		rc.ack(seq, map[string]any{"xfer": tr.xfer, "received": tr.received})
	}
}

// unpack consumes archive bytes: per entry a u32le header length, a JSON
// header, then exactly header.size raw bytes.
func (rc *Receiver) unpack(tr *incomingTree, data []byte) error {
	tr.buf = append(tr.buf, data...)
	for {
		if tr.cur == nil {
			if len(tr.buf) < 4 {
				return nil
			}
			hlen := int(binary.LittleEndian.Uint32(tr.buf[0:4]))
			if hlen <= 0 || hlen > 64*1024 {
				return fmt.Errorf("bad tree entry header length %d", hlen)
			}
			if len(tr.buf) < 4+hlen {
				return nil
			}
			var meta PutMeta
			if err := json.Unmarshal(tr.buf[4:4+hlen], &meta); err != nil {
				return fmt.Errorf("bad tree entry header: %v", err)
			}
			tr.buf = tr.buf[4+hlen:]
			tr.cur = &meta
			tr.curLeft = meta.Size
			tr.skipping = false
			abs, ok := safeJoin(rc.root, meta.Path)
			if !ok || ignoredRel(meta.Path) {
				tr.skipping = true
				tr.skipped = append(tr.skipped, meta.Path)
			} else if winner, conflict := rc.sync.ResolveIncoming(meta, abs); conflict && winner == "local" {
				tr.skipping = true
				tr.skipped = append(tr.skipped, meta.Path)
			} else {
				if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
					return err
				}
				// direct write, no temp+rename: per-entry VFS ops on the
				// emulated CPU are the cost floor (~4 ms each), and the
				// workspace disk is not canonical — an aborted hydrate is
				// simply re-run from the host on the next boot
				f, err := os.OpenFile(abs, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(meta.Mode))
				if err != nil {
					return err
				}
				tr.curFile = f
				tr.curPath = abs
			}
		}
		// stream current entry's bytes
		n := int64(len(tr.buf))
		if n > tr.curLeft {
			n = tr.curLeft
		}
		if n > 0 {
			if !tr.skipping {
				if _, err := tr.curFile.Write(tr.buf[:n]); err != nil {
					return err
				}
			}
			tr.buf = tr.buf[n:]
			tr.curLeft -= n
		}
		if tr.curLeft > 0 {
			return nil // need more data for this entry
		}
		// entry complete
		if !tr.skipping {
			meta := tr.cur
			tr.curFile.Close()
			mt := time.UnixMilli(meta.MtimeMs)
			os.Chtimes(tr.curPath, mt, mt) // keep LWW mtime semantics
			rc.sync.MarkSynced(meta.Path, meta.Hash)
		}
		tr.cur = nil
		tr.curFile = nil
	}
}

func (rc *Receiver) finishTree(seq uint32, tr *incomingTree) {
	if len(tr.buf) > 0 || tr.cur != nil {
		rc.abortTree(seq, tr, fmt.Sprintf("truncated archive: %d trailing bytes", len(tr.buf)))
		return
	}
	rc.mu.Lock()
	delete(rc.trees, tr.xfer)
	rc.mu.Unlock()
	rc.ack(seq, map[string]any{"xfer": tr.xfer, "done": true, "skipped": tr.skipped})
}

func (rc *Receiver) abortTree(seq uint32, tr *incomingTree, msg string) {
	log.Printf("tree xfer %d aborted: %s", tr.xfer, msg)
	if tr.curFile != nil {
		tr.curFile.Close()
		os.Remove(tr.curPath)
	}
	rc.mu.Lock()
	delete(rc.trees, tr.xfer)
	rc.mu.Unlock()
	rc.nak(seq, msg, map[string]any{"xfer": tr.xfer})
}

func (rc *Receiver) HandleDel(f *Frame) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(f.Payload, &req); err != nil {
		rc.nak(f.Seq, "bad FILE_DEL json", nil)
		return
	}
	abs, ok := safeJoin(rc.root, req.Path)
	if !ok {
		rc.nak(f.Seq, "illegal path", nil)
		return
	}
	if err := os.RemoveAll(abs); err != nil {
		rc.nak(f.Seq, err.Error(), nil)
		return
	}
	rc.sync.MarkDeleted(req.Path)
	rc.ack(f.Seq, nil)
}

// Sender pushes guest→host file operations with windowed chunks.
type Sender struct {
	root     string
	fw       *FrameWriter
	nextXfer uint32
	window   chan struct{} // counting semaphore for in-flight chunks
	mu       sync.Mutex
	acks     map[uint32]chan *Frame // xfer → done/nak notification
	sync     *SyncState
}

func NewSender(root string, fw *FrameWriter, ss *SyncState) *Sender {
	return NewSenderWithBase(root, fw, ss, 0)
}

// NewSenderWithBase sets the starting xfer id. Senders on different channels
// need disjoint id ranges: console starts at 0, the data plane at 0x40000000,
// and the host allocates its own ids from 0x80000000 up.
func NewSenderWithBase(root string, fw *FrameWriter, ss *SyncState, base uint32) *Sender {
	return &Sender{
		root:     root,
		fw:       fw,
		nextXfer: base,
		window:   make(chan struct{}, 32),
		acks:     map[uint32]chan *Frame{},
		sync:     ss,
	}
}

// HandleAck routes ACK/NAK frames carrying an "xfer" field to the waiting
// transfer, and releases window slots for cumulative chunk acks.
func (s *Sender) HandleAck(f *Frame) bool {
	var a struct {
		Xfer     *uint32 `json:"xfer"`
		Done     bool    `json:"done"`
		Error    string  `json:"error"`
		Received *int64  `json:"received"`
	}
	if json.Unmarshal(f.Payload, &a) != nil || a.Xfer == nil {
		return false
	}
	if a.Received != nil && !a.Done && a.Error == "" {
		// cumulative progress ack → free up to 16 window slots
		for i := 0; i < 16; i++ {
			select {
			case <-s.window:
			default:
			}
		}
		return true
	}
	s.mu.Lock()
	ch := s.acks[*a.Xfer]
	s.mu.Unlock()
	if ch != nil {
		ch <- f
		return true
	}
	return false
}

func (s *Sender) PushFile(rel string) error {
	abs, ok := safeJoin(s.root, rel)
	if !ok {
		return fmt.Errorf("illegal path %q", rel)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	hash, err := hashFile(abs)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.nextXfer++
	xfer := s.nextXfer
	done := make(chan *Frame, 4)
	s.acks[xfer] = done
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.acks, xfer)
		s.mu.Unlock()
	}()

	meta := PutMeta{Xfer: xfer, Path: rel, Size: info.Size(),
		Mode: uint32(info.Mode().Perm()), MtimeMs: info.ModTime().UnixMilli(), Hash: hash}
	b, _ := json.Marshal(meta)
	if _, err := s.fw.Send(TypeFilePut, b); err != nil {
		return err
	}
	// wait for ready-ack (or immediate done for empty files)
	select {
	case f := <-done:
		if f.Type == TypeNak {
			return fmt.Errorf("put rejected: %s", string(f.Payload))
		}
		var a struct {
			Done bool `json:"done"`
		}
		json.Unmarshal(f.Payload, &a)
		if a.Done {
			s.sync.MarkSynced(rel, hash)
			return nil
		}
	case <-time.After(30 * time.Second):
		return fmt.Errorf("timeout waiting for PUT ack on %s", rel)
	}

	src, err := os.Open(abs)
	if err != nil {
		return err
	}
	defer src.Close()
	buf := make([]byte, ChunkSize)
	var offset int64
	for offset < meta.Size {
		n, rerr := src.ReadAt(buf, offset)
		if n > 0 {
			payload := make([]byte, 12+n)
			binary.LittleEndian.PutUint32(payload[0:4], xfer)
			binary.LittleEndian.PutUint64(payload[4:12], uint64(offset))
			copy(payload[12:], buf[:n])
			s.window <- struct{}{}
			if _, err := s.fw.Send(TypeFileChunk, payload); err != nil {
				return err
			}
			offset += int64(n)
		}
		if rerr != nil {
			break
		}
	}
	select {
	case f := <-done:
		// transfer finished; drain any window slots this transfer holds
		for {
			select {
			case <-s.window:
				continue
			default:
			}
			break
		}
		if f.Type == TypeNak {
			return fmt.Errorf("transfer failed: %s", string(f.Payload))
		}
		s.sync.MarkSynced(rel, hash)
		return nil
	case <-time.After(60 * time.Second):
		return fmt.Errorf("timeout waiting for final ack on %s", rel)
	}
}

func (s *Sender) PushDelete(rel string) error {
	b, _ := json.Marshal(map[string]string{"path": rel})
	_, err := s.fw.Send(TypeFileDel, b)
	s.sync.MarkDeleted(rel)
	return err
}
