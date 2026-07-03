package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Watcher runs recursive inotify on root, debounces events, and hands
// batched put/del operations to the flush callback.
type Watcher struct {
	root    string
	fd      int
	wds     map[int]string // wd → absolute dir path
	mu      sync.Mutex
	pending map[string]string // rel path → "put"|"del"
	timer   *time.Timer
	flush   func(ops map[string]string)
}

const watchMask = syscall.IN_CLOSE_WRITE | syscall.IN_CREATE | syscall.IN_DELETE |
	syscall.IN_MOVED_TO | syscall.IN_MOVED_FROM | syscall.IN_DELETE_SELF

func NewWatcher(root string, flush func(map[string]string)) (*Watcher, error) {
	fd, err := syscall.InotifyInit1(0)
	if err != nil {
		return nil, err
	}
	w := &Watcher{root: root, fd: fd, wds: map[int]string{}, pending: map[string]string{}, flush: flush}
	if err := w.watchTree(root); err != nil {
		return nil, err
	}
	go w.loop()
	return w, nil
}

func (w *Watcher) watchTree(dir string) error {
	return filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		base := filepath.Base(p)
		if base == tmpDirName || base == "lost+found" {
			return filepath.SkipDir
		}
		wd, werr := syscall.InotifyAddWatch(w.fd, p, watchMask)
		if werr == nil {
			w.mu.Lock()
			w.wds[wd] = p
			w.mu.Unlock()
		}
		return nil
	})
}

func (w *Watcher) loop() {
	buf := make([]byte, 64*1024)
	for {
		n, err := syscall.Read(w.fd, buf)
		if err != nil {
			log.Printf("inotify read error: %v", err)
			return
		}
		off := 0
		for off < n {
			raw := (*syscall.InotifyEvent)(unsafe.Pointer(&buf[off]))
			nameLen := int(raw.Len)
			name := ""
			if nameLen > 0 {
				nb := buf[off+syscall.SizeofInotifyEvent : off+syscall.SizeofInotifyEvent+nameLen]
				name = strings.TrimRight(string(nb), "\x00")
			}
			w.handle(int(raw.Wd), raw.Mask, name)
			off += syscall.SizeofInotifyEvent + nameLen
		}
	}
}

func (w *Watcher) handle(wd int, mask uint32, name string) {
	w.mu.Lock()
	dir, ok := w.wds[wd]
	w.mu.Unlock()
	if !ok || name == "" || name == tmpDirName {
		return
	}
	abs := filepath.Join(dir, name)
	rel, err := filepath.Rel(w.root, abs)
	if err != nil || strings.HasPrefix(rel, tmpDirName) {
		return
	}
	rel = filepath.ToSlash(rel)

	isDir := mask&syscall.IN_ISDIR != 0
	switch {
	case isDir && mask&(syscall.IN_CREATE|syscall.IN_MOVED_TO) != 0:
		// new directory: watch it and enqueue its (recursively created) files
		w.watchTree(abs)
		filepath.WalkDir(abs, func(p string, d os.DirEntry, err error) error {
			if err == nil && d.Type().IsRegular() {
				if r, rerr := filepath.Rel(w.root, p); rerr == nil {
					w.enqueue(filepath.ToSlash(r), "put")
				}
			}
			return nil
		})
	case isDir && mask&(syscall.IN_DELETE|syscall.IN_MOVED_FROM) != 0:
		w.enqueue(rel, "del")
	case mask&(syscall.IN_CLOSE_WRITE|syscall.IN_MOVED_TO) != 0:
		w.enqueue(rel, "put")
	case mask&(syscall.IN_DELETE|syscall.IN_MOVED_FROM) != 0:
		w.enqueue(rel, "del")
	}
}

func (w *Watcher) enqueue(rel, op string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending[rel] = op
	if w.timer == nil {
		w.timer = time.AfterFunc(300*time.Millisecond, w.doFlush)
	} else {
		w.timer.Reset(300 * time.Millisecond)
	}
}

func (w *Watcher) doFlush() {
	w.mu.Lock()
	ops := w.pending
	w.pending = map[string]string{}
	w.timer = nil
	w.mu.Unlock()
	if len(ops) > 0 {
		w.flush(ops)
	}
}
