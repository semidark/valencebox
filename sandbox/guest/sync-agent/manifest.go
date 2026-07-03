package main

import (
	"crypto/sha256"
	"encoding/hex"
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

func buildManifest(root string) (*Manifest, error) {
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
		if strings.HasPrefix(rel, tmpDirName) || rel == "lost+found" {
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
		h, herr := hashFile(p)
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
