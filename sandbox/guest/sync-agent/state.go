package main

import (
	"encoding/json"
	"log"
	"os"
	"sync"
)

// SyncState tracks the last-synced content hash per path. It answers two
// questions: "is this local FS event an echo of a remote write?" and "does
// this incoming write conflict with a concurrent local edit?"
type SyncState struct {
	mu       sync.Mutex
	lastSync map[string]string // rel path → hash at last successful sync
	fw       *FrameWriter
}

func NewSyncState(fw *FrameWriter) *SyncState {
	return &SyncState{lastSync: map[string]string{}, fw: fw}
}

func (ss *SyncState) MarkSynced(rel, hash string) {
	ss.mu.Lock()
	ss.lastSync[rel] = hash
	ss.mu.Unlock()
}

func (ss *SyncState) MarkDeleted(rel string) {
	ss.mu.Lock()
	delete(ss.lastSync, rel)
	ss.mu.Unlock()
}

func (ss *SyncState) LastHash(rel string) (string, bool) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	h, ok := ss.lastSync[rel]
	return h, ok
}

// IsEcho reports whether the file at abs currently matches the last-synced
// hash for rel — i.e. the local FS event was caused by applying a remote op.
func (ss *SyncState) IsEcho(rel, abs string) bool {
	last, ok := ss.LastHash(rel)
	if !ok {
		return false
	}
	h, err := hashFile(abs)
	return err == nil && h == last
}

// ResolveIncoming implements last-writer-wins for an incoming PUT against a
// possible concurrent local edit. Returns (winner, conflict).
func (ss *SyncState) ResolveIncoming(meta PutMeta, abs string) (string, bool) {
	info, err := os.Stat(abs)
	if err != nil {
		return "remote", false // no local file → no conflict
	}
	localHash, err := hashFile(abs)
	if err != nil {
		return "remote", false
	}
	if localHash == meta.Hash {
		return "remote", false // same content, harmless
	}
	last, _ := ss.LastHash(meta.Path)
	if localHash == last {
		return "remote", false // local unchanged since last sync → clean update
	}
	// Concurrent edit: LWW by mtime, tie → greater hash.
	localM := info.ModTime().UnixMilli()
	winner := "remote"
	if localM > meta.MtimeMs || (localM == meta.MtimeMs && localHash > meta.Hash) {
		winner = "local"
	}
	log.Printf("CONFLICT %s: local mtime=%d remote mtime=%d → %s wins", meta.Path, localM, meta.MtimeMs, winner)
	ev, _ := json.Marshal(map[string]any{"events": []map[string]any{{
		"op": "conflict", "path": meta.Path, "winner": winner,
		"localMtimeMs": localM, "remoteMtimeMs": meta.MtimeMs,
	}}})
	ss.fw.Send(TypeEvent, ev)
	return winner, true
}
