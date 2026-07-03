package main

import (
	"bufio"
	"encoding/json"
	"log"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// dataPlaneCfg is advertised by the host over the console (HELLO / hello-ACK
// payloads). The guest dials ip:port through virtio-net; the host's wisp
// relay bridges that stream in-process. token gates the channel per boot.
type dataPlaneCfg struct {
	IP    string `json:"ip"`
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// DataPlane maintains the TCP sync channel: dial with retry, token HELLO,
// frame session sharing SyncState with the console session, liveness pings,
// re-dial on drop or on a new advert (host restart ⇒ new token).
type DataPlane struct {
	mu     sync.Mutex
	root   string
	ss     *SyncState
	cfg    *dataPlaneCfg
	gen    int
	conn   net.Conn
	sender *Sender
}

func NewDataPlane(root string, ss *SyncState) *DataPlane {
	return &DataPlane{root: root, ss: ss}
}

// Update adopts a (possibly new) advert. A changed advert supersedes the
// current session: the old connection is closed and a fresh dial loop starts.
func (dp *DataPlane) Update(cfg dataPlaneCfg) {
	dp.mu.Lock()
	if dp.cfg != nil && *dp.cfg == cfg {
		dp.mu.Unlock()
		return
	}
	dp.cfg = &cfg
	dp.gen++
	gen := dp.gen
	if dp.conn != nil {
		dp.conn.Close()
		dp.conn = nil
	}
	dp.mu.Unlock()
	log.Printf("data plane: advert %s:%d (gen %d)", cfg.IP, cfg.Port, gen)
	go dp.loop(cfg, gen)
}

func (dp *DataPlane) Shutdown() {
	dp.mu.Lock()
	dp.gen++ // invalidate all loops
	if dp.conn != nil {
		dp.conn.Close()
		dp.conn = nil
	}
	dp.mu.Unlock()
}

// Sender returns the active data-channel sender, or nil when disconnected.
func (dp *DataPlane) Sender() *Sender {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	return dp.sender
}

func (dp *DataPlane) stale(gen int) bool {
	dp.mu.Lock()
	defer dp.mu.Unlock()
	return dp.gen != gen
}

func (dp *DataPlane) loop(cfg dataPlaneCfg, gen int) {
	addr := net.JoinHostPort(cfg.IP, strconv.Itoa(cfg.Port))
	for {
		if dp.stale(gen) {
			return
		}
		conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		dp.mu.Lock()
		if dp.gen != gen {
			dp.mu.Unlock()
			conn.Close()
			return
		}
		dp.conn = conn
		dp.mu.Unlock()
		dp.session(conn, cfg, gen)
		dp.mu.Lock()
		if dp.conn == conn {
			dp.conn = nil
		}
		dp.mu.Unlock()
		time.Sleep(time.Second)
	}
}

func (dp *DataPlane) session(conn net.Conn, cfg dataPlaneCfg, gen int) {
	defer conn.Close()
	fw := NewFrameWriter(conn)
	hello, _ := json.Marshal(map[string]any{
		"version": 1, "role": "guest", "channel": "data",
		"token": cfg.Token, "root": dp.root,
	})
	if _, err := fw.Send(TypeHello, hello); err != nil {
		return
	}
	recv := NewReceiverNoVerify(dp.root, fw, dp.ss)
	// disjoint xfer-id base: the console sender starts at 0, the host at
	// 0x80000000 — collisions would cross wires in per-xfer routing maps
	send := NewSenderWithBase(dp.root, fw, dp.ss, 0x40000000)

	dp.mu.Lock()
	dp.sender = send
	dp.mu.Unlock()
	defer func() {
		dp.mu.Lock()
		if dp.sender == send {
			dp.sender = nil
		}
		dp.mu.Unlock()
	}()
	log.Printf("data plane: connected to %s:%d", cfg.IP, cfg.Port)

	// liveness: ping every 15s; a snapshot restore leaves this TCP session
	// half-dead (host side is gone), so silence >45s forces a re-dial
	var lastRx atomic.Int64
	lastRx.Store(time.Now().UnixMilli())
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				fw.Send(TypePing, nil)
				if time.Now().UnixMilli()-lastRx.Load() > 45000 {
					log.Printf("data plane: no traffic for 45s — reconnecting")
					conn.Close()
					return
				}
			case <-stop:
				return
			}
		}
	}()

	r := bufio.NewReaderSize(conn, 256*1024)
	for {
		f, err := ReadFrame(r)
		if err != nil {
			log.Printf("data plane: session ended: %v", err)
			return
		}
		if dp.stale(gen) {
			return
		}
		lastRx.Store(time.Now().UnixMilli())
		switch f.Type {
		case TypeAck, TypeNak:
			send.HandleAck(f) // non-xfer acks (hello/ping replies) need nothing
		case TypeFilePut:
			recv.HandlePut(f)
		case TypeTreePut:
			recv.HandleTreePut(f)
		case TypeFileChunk:
			recv.HandleChunk(f)
		case TypeFileDel:
			recv.HandleDel(f)
		case TypePing:
			recv.ack(f.Seq, nil)
		case TypeManifest:
			recv.ack(f.Seq, nil) // manifests travel on the console today
		default:
			log.Printf("data plane: unknown frame type %d", f.Type)
		}
	}
}
