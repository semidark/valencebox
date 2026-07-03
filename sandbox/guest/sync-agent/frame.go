package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"sync"
)

const (
	TypeHello     = 1
	TypeManifest  = 2
	TypeFilePut   = 3
	TypeFileChunk = 4
	TypeFileDel   = 5
	TypeAck       = 6
	TypeNak       = 7
	TypeEvent     = 8
	TypePing      = 9
	TypeTreePut   = 10 // batched small-file archive; body streams as chunks

	MaxPayload = 262144
	ChunkSize  = 48 * 1024
)

var magic = [4]byte{'V', '8', '6', 'S'}

type Frame struct {
	Type    byte
	Seq     uint32
	Payload []byte
}

// ReadFrame reads one frame, resynchronizing on the magic if the stream is
// corrupted. Returns io.EOF only when the underlying reader is closed.
func ReadFrame(r *bufio.Reader) (*Frame, error) {
	// hunt for magic
	matched := 0
	for matched < 4 {
		b, err := r.ReadByte()
		if err != nil {
			return nil, err
		}
		if b == magic[matched] {
			matched++
		} else if b == magic[0] {
			matched = 1
		} else {
			matched = 0
		}
	}
	var hdr [9]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	typ := hdr[0]
	seq := binary.LittleEndian.Uint32(hdr[1:5])
	plen := binary.LittleEndian.Uint32(hdr[5:9])
	if plen > MaxPayload {
		return nil, fmt.Errorf("payload too large: %d", plen)
	}
	payload := make([]byte, plen)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	var crcb [4]byte
	if _, err := io.ReadFull(r, crcb[:]); err != nil {
		return nil, err
	}
	crc := crc32.NewIEEE()
	crc.Write(hdr[:])
	crc.Write(payload)
	if crc.Sum32() != binary.LittleEndian.Uint32(crcb[:]) {
		return nil, fmt.Errorf("crc mismatch on frame type %d seq %d", typ, seq)
	}
	return &Frame{Type: typ, Seq: seq, Payload: payload}, nil
}

// FrameWriter serializes concurrent frame writes and assigns sequence numbers.
type FrameWriter struct {
	mu  sync.Mutex
	w   io.Writer
	seq uint32
}

func NewFrameWriter(w io.Writer) *FrameWriter { return &FrameWriter{w: w} }

func (fw *FrameWriter) Send(typ byte, payload []byte) (uint32, error) {
	if len(payload) > MaxPayload {
		// an oversized frame would be silently discarded by the host parser
		return 0, fmt.Errorf("payload too large: %d", len(payload))
	}
	fw.mu.Lock()
	defer fw.mu.Unlock()
	fw.seq++
	seq := fw.seq
	var hdr [9]byte
	hdr[0] = typ
	binary.LittleEndian.PutUint32(hdr[1:5], seq)
	binary.LittleEndian.PutUint32(hdr[5:9], uint32(len(payload)))
	crc := crc32.NewIEEE()
	crc.Write(hdr[:])
	crc.Write(payload)
	var crcb [4]byte
	binary.LittleEndian.PutUint32(crcb[:], crc.Sum32())
	buf := make([]byte, 0, 4+9+len(payload)+4)
	buf = append(buf, magic[:]...)
	buf = append(buf, hdr[:]...)
	buf = append(buf, payload...)
	buf = append(buf, crcb[:]...)
	if _, err := fw.w.Write(buf); err != nil {
		return seq, err
	}
	return seq, nil
}
