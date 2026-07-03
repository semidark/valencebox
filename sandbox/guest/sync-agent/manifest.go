package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type FileMeta struct {
	Hash    string `json:"hash"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	MtimeMs int64  `json:"mtimeMs"`
}

type Manifest struct {
	Files map[string]FileMeta `json:"files"`
}

const tmpDirName = ".sync-tmp"

// ignoredRel: paths never synced, at any depth. Mirrors src/main/manifest.ts.
func ignoredRel(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		switch seg {
		case tmpDirName, ".git", "node_modules", "lost+found", ".DS_Store":
			return true
		}
	}
	return false
}

func hashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func buildManifest(root string, ss *SyncState) (*Manifest, error) {
	m := &Manifest{Files: map[string]FileMeta{}}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped, not fatal
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil || rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if ignoredRel(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // symlinks/devices skipped per protocol
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		h, herr := ss.hashCachedStat(rel, p, info.Size(), info.ModTime().UnixMilli())
		if herr != nil {
			return nil
		}
		m.Files[rel] = FileMeta{
			Hash:    h,
			Size:    info.Size(),
			Mode:    uint32(info.Mode().Perm()),
			MtimeMs: info.ModTime().UnixMilli(),
		}
		return nil
	})
	return m, err
}

// A whole-workspace manifest can exceed MaxPayload, so it is sent as
// multiple MANIFEST frames that the host merges. Mirrors splitManifest in
// src/main/manifest.ts (same batch limit and per-entry size estimate).
const manifestBatchLimit = 160 * 1024

func marshalManifestBatches(m *Manifest) [][]byte {
	var batches [][]byte
	cur := &Manifest{Files: map[string]FileMeta{}}
	curLen := 0
	for rel, meta := range m.Files {
		entLen := len(rel) + 160
		if curLen > 0 && curLen+entLen > manifestBatchLimit {
			b, _ := json.Marshal(cur)
			batches = append(batches, b)
			cur = &Manifest{Files: map[string]FileMeta{}}
			curLen = 0
		}
		cur.Files[rel] = meta
		curLen += entLen
	}
	b, _ := json.Marshal(cur)
	return append(batches, b)
}

// safeJoin resolves a protocol-relative path under root, rejecting escapes.
func safeJoin(root, rel string) (string, bool) {
	if rel == "" || strings.HasPrefix(rel, "/") {
		return "", false
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.Join(root, clean), true
}
