package main

import (
	"encoding/json"
	"log"
	"os"
	"sync"
)

// statHash is a content hash keyed by the (size, mtime) it was computed
// from, so a stat that still matches proves the content hasn't changed
// without re-reading it.
type statHash struct {
	hash    string
	size    int64
	mtimeMs int64
}

// SyncState tracks the last-synced content hash per path. It answers two
// questions: "is this local FS event an echo of a remote write?" and "does
// this incoming write conflict with a concurrent local edit?"
type SyncState struct {
	mu        sync.Mutex
	lastSync  map[string]string   // rel path → hash at last successful sync
	statCache map[string]statHash // rel path → hash cache, invalidated by stat
	fw        *FrameWriter
}

func NewSyncState(fw *FrameWriter) *SyncState {
	return &SyncState{lastSync: map[string]string{}, statCache: map[string]statHash{}, fw: fw}
}

func (ss *SyncState) MarkSynced(rel, hash string) {
	ss.mu.Lock()
	ss.lastSync[rel] = hash
	ss.mu.Unlock()
}

func (ss *SyncState) MarkDeleted(rel string) {
	ss.mu.Lock()
	delete(ss.lastSync, rel)
	delete(ss.statCache, rel)
	ss.mu.Unlock()
}

// HashCached hashes the file at abs, reusing a previously computed hash if
// the file's size and mtime haven't changed since. A full-workspace re-hash
// (guest startup, host reconnect after VM restore) is the common case where
// almost nothing actually changed, so this turns it from O(bytes read) into
// O(stat calls) for the unchanged majority.
func (ss *SyncState) HashCached(rel, abs string) (string, error) {
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	return ss.hashCachedStat(rel, abs, info.Size(), info.ModTime().UnixMilli())
}

// hashCachedStat is HashCached's core, for callers that already stat'd the
// file (e.g. a directory walk) and would otherwise pay for a redundant stat.
func (ss *SyncState) hashCachedStat(rel, abs string, size, mtimeMs int64) (string, error) {
	ss.mu.Lock()
	c, ok := ss.statCache[rel]
	ss.mu.Unlock()
	if ok && c.size == size && c.mtimeMs == mtimeMs {
		return c.hash, nil
	}

	h, err := hashFile(abs)
	if err != nil {
		return "", err
	}
	ss.mu.Lock()
	ss.statCache[rel] = statHash{hash: h, size: size, mtimeMs: mtimeMs}
	ss.mu.Unlock()
	return h, nil
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
