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
	dplane := NewDataPlane(*flagRoot, ss)
	defer dplane.Shutdown()

	hello, _ := json.Marshal(map[string]any{"version": 1, "role": "guest", "root": *flagRoot})
	fw.Send(TypeHello, hello)

	// prefer the TCP data plane for pushes; console is the fallback (and the
	// retry path if a push dies mid-transfer on a dropping connection)
	pushVia := func(op func(s *Sender) error) error {
		if ds := dplane.Sender(); ds != nil {
			if err := op(ds); err == nil {
				return nil
			} else {
				log.Printf("data-plane push failed, retrying over console: %v", err)
			}
		}
		return op(send)
	}

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
					if err := pushVia(func(s *Sender) error { return s.PushFile(rel) }); err != nil {
						log.Printf("push %s: %v", rel, err)
					}
				case "del":
					// forwarded even if never synced — the host no-ops on unknown paths
					if err := pushVia(func(s *Sender) error { return s.PushDelete(rel) }); err != nil {
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
			// the host HELLO may advertise the TCP data plane
			var hh struct {
				DataPlane *dataPlaneCfg `json:"dataPlane"`
			}
			if json.Unmarshal(f.Payload, &hh) == nil && hh.DataPlane != nil {
				dplane.Update(*hh.DataPlane)
			}
			// host (re)connected: it will drive manifest exchange; send ours
			// (chunked — a big workspace manifest exceeds one frame)
			if m, merr := buildManifest(*flagRoot, ss); merr == nil {
				for _, b := range marshalManifestBatches(m) {
					fw.Send(TypeManifest, b)
				}
			}
		case TypePing:
			recv.ack(f.Seq, nil)
		case TypeManifest:
			// host manifest: adopt as lastSync baseline for entries that match
			var m Manifest
			if json.Unmarshal(f.Payload, &m) == nil {
				for rel, meta := range m.Files {
					if abs, ok := safeJoin(*flagRoot, rel); ok {
						if h, herr := ss.HashCached(rel, abs); herr == nil && h == meta.Hash {
							ss.MarkSynced(rel, h)
						}
					}
				}
			}
			recv.ack(f.Seq, nil)
		case TypeFilePut:
			recv.HandlePut(f)
		case TypeTreePut:
			recv.HandleTreePut(f)
		case TypeFileChunk:
			recv.HandleChunk(f)
		case TypeFileDel:
			recv.HandleDel(f)
		case TypeAck, TypeNak:
			if !send.HandleAck(f) {
				// non-transfer ack: the reply to our HELLO may carry the
				// data-plane advert (cold-boot path)
				var ha struct {
					DataPlane *dataPlaneCfg `json:"dataPlane"`
				}
				if json.Unmarshal(f.Payload, &ha) == nil && ha.DataPlane != nil {
					dplane.Update(*ha.DataPlane)
				}
			}
		case TypeEvent:
			log.Printf("event from host: %s", string(f.Payload))
		default:
			log.Printf("unknown frame type %d", f.Type)
		}
	}
}
