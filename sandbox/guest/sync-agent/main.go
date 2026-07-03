package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"log"
	"os"
	"time"
)

var (
	flagRoot = flag.String("root", "/workspace", "sync root directory")
	flagDev  = flag.String("dev", "/dev/hvc0", "virtio-console device")
)

func main() {
	flag.Parse()
	log.SetPrefix("sync-agent: ")
	log.SetFlags(log.Ltime)

	for {
		if err := run(); err != nil {
			log.Printf("session ended: %v — reopening in 2s", err)
			time.Sleep(2 * time.Second)
		}
	}
}

func run() error {
	dev, err := os.OpenFile(*flagDev, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer dev.Close()
	if err := setRaw(dev); err != nil {
		log.Printf("warning: could not set %s raw: %v", *flagDev, err)
	}

	fw := NewFrameWriter(dev)
	ss := NewSyncState(fw)
	recv := NewReceiver(*flagRoot, fw, ss)
	send := NewSender(*flagRoot, fw, ss)

	hello, _ := json.Marshal(map[string]any{"version": 1, "role": "guest", "root": *flagRoot})
	fw.Send(TypeHello, hello)

	pushQueue := make(chan map[string]string, 64)
	go func() {
		for ops := range pushQueue {
			for rel, op := range ops {
				abs, ok := safeJoin(*flagRoot, rel)
				if !ok {
					continue
				}
				switch op {
				case "put":
					if ss.IsEcho(rel, abs) {
						continue // our own applied write bounced back from inotify
					}
					if err := send.PushFile(rel); err != nil {
						log.Printf("push %s: %v", rel, err)
					}
				case "del":
					if _, wasKnown := ss.LastHash(rel); !wasKnown {
						// deletion of something never synced — still forward it
					}
					if err := send.PushDelete(rel); err != nil {
						log.Printf("push del %s: %v", rel, err)
					}
				}
			}
		}
	}()

	if _, err := NewWatcher(*flagRoot, func(ops map[string]string) { pushQueue <- ops }); err != nil {
		log.Printf("inotify unavailable: %v", err)
	}

	r := bufio.NewReaderSize(dev, 256*1024)
	for {
		f, err := ReadFrame(r)
		if err != nil {
			return err
		}
		switch f.Type {
		case TypeHello:
			recv.ack(f.Seq, map[string]any{"role": "guest"})
			// host (re)connected: it will drive manifest exchange; send ours
			if m, merr := buildManifest(*flagRoot); merr == nil {
				b, _ := json.Marshal(m)
				fw.Send(TypeManifest, b)
			}
		case TypePing:
			recv.ack(f.Seq, nil)
		case TypeManifest:
			// host manifest: adopt as lastSync baseline for entries that match
			var m Manifest
			if json.Unmarshal(f.Payload, &m) == nil {
				for rel, meta := range m.Files {
					if abs, ok := safeJoin(*flagRoot, rel); ok {
						if h, herr := hashFile(abs); herr == nil && h == meta.Hash {
							ss.MarkSynced(rel, h)
						}
					}
				}
			}
			recv.ack(f.Seq, nil)
		case TypeFilePut:
			recv.HandlePut(f)
		case TypeFileChunk:
			recv.HandleChunk(f)
		case TypeFileDel:
			recv.HandleDel(f)
		case TypeAck, TypeNak:
			if !send.HandleAck(f) {
				// non-transfer ack (hello/ping replies) — nothing to do
			}
		case TypeEvent:
			log.Printf("event from host: %s", string(f.Payload))
		default:
			log.Printf("unknown frame type %d", f.Type)
		}
	}
}
