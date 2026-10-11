// valencebox-mux: guest-side daemon for the strict-network mux tunnel.
//
// Speaks the framing protocol in docs/mux-protocol.md over the virtio-serial
// port named "mux" (/dev/virtio-ports/mux):
//   frame = [u32BE len][u8 type][u32BE streamId][payload]
//
// Role: bridges guest loopback TCP services to the host.
//  - Listens on 127.0.0.1:<proxy_port> (egress proxy relay) and
//    127.0.0.1:<share_port> (WebDAV share relay). Each accepted connection
//    opens a mux stream with target "proxy" / "share".
//  - Accepts host-initiated OPEN "fwd:<port>" streams and dials
//    127.0.0.1:<port> (e.g. SSH debug access).
//
// Flow control mirrors the host: each stream starts with MUX_WINDOW bytes of
// send credit; credit is granted back in MUX_CREDIT_BATCH chunks, only for
// bytes actually written into the destination socket.
//
// IMPORTANT: the virtio port and every socket are opened NON-BLOCKING and
// driven with poll(). Blocking reads on virtio-serial stall for seconds under
// load (see docs/NET-CONTAINMENT.md benchmarks).
//
// Zero external crates: poll/getsockopt/shutdown come from extern "C"
// declarations (libc is linked by std anyway); sockets use std with
// set_nonblocking, so the image build needs no network.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;

// ---- libc externs (no crates) ----

mod sys {
    use std::os::raw::c_int;

    pub const POLLIN: i16 = 0x001;
    pub const POLLOUT: i16 = 0x004;
    pub const POLLERR: i16 = 0x008;
    pub const POLLHUP: i16 = 0x010;
    pub const POLLRDHUP: i16 = 0x2000;

    pub const SHUT_WR: c_int = 1;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct PollFd {
        pub fd: c_int,
        pub events: i16,
        pub revents: i16,
    }

    pub type NfdsT = u64;

    unsafe extern "C" {
        pub fn poll(fds: *mut PollFd, nfds: NfdsT, timeout: c_int) -> c_int;
        pub fn shutdown(fd: c_int, how: c_int) -> c_int;
    }
}

// ---- protocol constants (mirror src/main/mux-channel.ts) ----

const FRAME_HEADER_SIZE: usize = 9;
const MAX_FRAME_PAYLOAD: usize = 256 * 1024;

const MT_HELLO: u8 = 1;
const MT_OPEN: u8 = 2;
const MT_OPEN_OK: u8 = 3;
const MT_OPEN_FAIL: u8 = 4;
const MT_DATA: u8 = 5;
const MT_FIN: u8 = 6;
const MT_RESET: u8 = 7;
const MT_CREDIT: u8 = 8;
const MT_PING: u8 = 9;
const MT_PONG: u8 = 10;

const MUX_WINDOW: u32 = 256 * 1024;
const MUX_CREDIT_BATCH: u32 = 64 * 1024;
const DATA_FRAME_CHUNK: usize = 64 * 1024;

const DEFAULT_PROXY_PORT: u32 = 3128;
const DEFAULT_SHARE_PORT: u32 = 8081;

const MUX_DEVICE: &str = "/dev/virtio-ports/mux";

// ---- frame queue to the mux port ----

struct OutQueue {
    buf: Vec<u8>,
    pos: usize,
}

impl OutQueue {
    fn new() -> Self {
        OutQueue { buf: Vec::new(), pos: 0 }
    }
    fn push_frame(&mut self, typ: u8, id: u32, payload: &[u8]) {
        let start = self.buf.len();
        self.buf.resize(start + FRAME_HEADER_SIZE + payload.len(), 0);
        self.buf[start..start + 4].copy_from_slice(&((payload.len() as u32).to_be_bytes()));
        self.buf[start + 4] = typ;
        self.buf[start + 5..start + 9].copy_from_slice(&id.to_be_bytes());
        self.buf[start + 9..].copy_from_slice(payload);
    }
    fn is_empty(&self) -> bool {
        self.pos >= self.buf.len()
    }
    /// Write out as much as the fd accepts; compact when fully drained.
    fn flush(&mut self, fd: RawFd) -> io::Result<()> {
        while self.pos < self.buf.len() {
            // SAFETY: fd is a valid open file descriptor for the loop lifetime.
            match unsafe { unsafe_write(fd, &self.buf[self.pos..]) } {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "mux write zero")),
                Ok(n) => self.pos += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(e) => return Err(e),
            }
        }
        self.buf.clear();
        self.pos = 0;
        if self.buf.capacity() > 4 * 1024 * 1024 {
            self.buf.shrink_to_fit();
        }
        Ok(())
    }
}

/// write(2) on a raw fd (needed for the mux File fd mid-loop).
unsafe fn unsafe_write(fd: RawFd, buf: &[u8]) -> io::Result<usize> {
    let f = std::mem::ManuallyDrop::new(unsafe { File::from_raw_fd(fd) });
    let r = (&*f).write(buf);
    std::mem::forget(f);
    r
}

/// read(2) on a raw fd.
unsafe fn unsafe_read(fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    let f = std::mem::ManuallyDrop::new(unsafe { File::from_raw_fd(fd) });
    let r = (&*f).read(buf);
    std::mem::forget(f);
    r
}

/// Holds the mux transport alive for the process lifetime (fd stays valid).
enum MuxHolder {
    Port(File),
    Tcp(TcpStream),
}

// ---- stream state ----

struct Stream {
    sock: TcpStream,
    /// Bytes received from the host, pending write into `sock`.
    out_buf: Vec<u8>,
    /// Host-granted send credit (bytes we may send in DATA frames).
    credit: u32,
    /// Bytes from `sock` already credited back to the host.
    unacked: u32,
    /// Total bytes received from the host for this stream.
    received: u64,
    /// Waiting for OPEN_OK (no reads until the peer accepts).
    awaiting_ok: bool,
    /// Host half-closed (FIN received); stop writing to sock once drained.
    fin_from_host: bool,
    /// We sent FIN (sock EOF).
    fin_sent: bool,
}

impl Stream {
    fn shutdown_write(&self) {
        unsafe {
            sys::shutdown(self.sock.as_raw_fd(), sys::SHUT_WR);
        }
    }
}

fn main() {
    let code = run();
    std::process::exit(code);
}

fn run() -> i32 {
    // Port precedence: kernel cmdline > env (dev/test) > default.
    let proxy_port = cmdline_u32("valencebox.proxy_port")
        .or_else(|| std::env::var("VALENCEBOX_PROXY_PORT").ok()?.parse().ok())
        .unwrap_or(DEFAULT_PROXY_PORT);
    let share_port = cmdline_u32("valencebox.share_port")
        .or_else(|| std::env::var("VALENCEBOX_SHARE_PORT").ok()?.parse().ok())
        .unwrap_or(DEFAULT_SHARE_PORT);

    // Dev/test affordance: VALENCEBOX_MUX_TCP=host:port connects to a TCP peer
    // instead of the virtio port, so the daemon can be integration-tested on a
    // build host against src/main/mux-channel.ts. Never set inside the VM.
    let mux_stream: Option<TcpStream> = match std::env::var("VALENCEBOX_MUX_TCP") {
        Ok(addr) => {
            let (host, port) = addr.rsplit_once(':').expect("VALENCEBOX_MUX_TCP must be host:port");
            let s = TcpStream::connect((host, port.parse::<u16>().expect("bad port"))).expect("mux TCP connect");
            s.set_nonblocking(true).expect("set_nonblocking");
            Some(s)
        }
        Err(_) => None,
    };

    let mux_holder: MuxHolder = match mux_stream {
        Some(s) => MuxHolder::Tcp(s),
        None => match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(0o4000 | 0o2000000) // O_NONBLOCK | O_CLOEXEC
            .open(MUX_DEVICE)
        {
            Ok(f) => MuxHolder::Port(f),
            Err(e) => {
                eprintln!("valencebox-mux: cannot open {MUX_DEVICE}: {e}");
                return 1;
            }
        },
    };
    let mux_fd = match &mux_holder {
        MuxHolder::Tcp(s) => s.as_raw_fd(),
        MuxHolder::Port(f) => f.as_raw_fd(),
    };

    let proxy_listener = match TcpListener::bind(("127.0.0.1", proxy_port as u16)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("valencebox-mux: cannot bind 127.0.0.1:{proxy_port}: {e}");
            return 1;
        }
    };
    let share_listener = match TcpListener::bind(("127.0.0.1", share_port as u16)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("valencebox-mux: cannot bind 127.0.0.1:{share_port}: {e}");
            return 1;
        }
    };
    for l in [&proxy_listener, &share_listener] {
        if let Err(e) = l.set_nonblocking(true) {
            eprintln!("valencebox-mux: set_nonblocking: {e}");
            return 1;
        }
    }

    let mut out = OutQueue::new();
    let mut in_buf: Vec<u8> = Vec::with_capacity(256 * 1024);
    // Guest streams use even ids.
    let mut next_id: u32 = 2;
    let mut streams: HashMap<u32, Stream> = HashMap::new();
    // Listener fd → mux target opened on accept.
    let mut relay_targets: HashMap<RawFd, &'static str> = HashMap::new();
    relay_targets.insert(proxy_listener.as_raw_fd(), "proxy");
    relay_targets.insert(share_listener.as_raw_fd(), "share");

    out.push_frame(MT_HELLO, 0, b"1");
    eprintln!(
        "valencebox-mux: started (proxy relay 127.0.0.1:{proxy_port}, share relay 127.0.0.1:{share_port})"
    );

    let mut mux_read_buf = vec![0u8; 256 * 1024];
    let mut sock_read_buf = vec![0u8; 64 * 1024];
    loop {
        // ---- build poll set ----
        let mut pollfds: Vec<sys::PollFd> = Vec::with_capacity(4 + streams.len());
        let mut mux_events = sys::POLLIN;
        if !out.is_empty() {
            mux_events |= sys::POLLOUT;
        }
        pollfds.push(sys::PollFd { fd: mux_fd, events: mux_events, revents: 0 });
        pollfds.push(sys::PollFd { fd: proxy_listener.as_raw_fd(), events: sys::POLLIN, revents: 0 });
        pollfds.push(sys::PollFd { fd: share_listener.as_raw_fd(), events: sys::POLLIN, revents: 0 });

        // (fd, stream_id) parallel table for stream pollfds.
        let mut poll_stream_ids: Vec<u32> = Vec::with_capacity(streams.len());
        for (id, s) in streams.iter() {
            let mut ev: i16 = 0;
            if !s.awaiting_ok && s.credit > 0 && !s.fin_sent {
                ev |= sys::POLLIN | sys::POLLRDHUP;
            }
            if !s.out_buf.is_empty() {
                ev |= sys::POLLOUT;
            }
            pollfds.push(sys::PollFd { fd: s.sock.as_raw_fd(), events: ev, revents: 0 });
            poll_stream_ids.push(*id);
        }

        // Bounded timeout: virtio_console's poll can miss wakeups after idle
        // 0-byte reads (the benchmark reader uses the same 100ms-capped wait),
        // so never sleep indefinitely on the mux fd.
        let n = unsafe { sys::poll(pollfds.as_mut_ptr(), pollfds.len() as sys::NfdsT, 100) };
        if n < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            eprintln!("valencebox-mux: poll failed: {e}");
            return 1;
        }

        // ---- mux events ----
        let mux_re = pollfds[0].revents;
        if mux_re & (sys::POLLERR | sys::POLLHUP) != 0 {
            eprintln!("valencebox-mux: mux port closed (QEMU gone?) — exiting");
            return 0;
        }
        // Flush pending outbound frames (POLLOUT, or opportunistically).
        if !out.is_empty() {
            if let Err(e) = out.flush(mux_fd) {
                eprintln!("valencebox-mux: mux write failed: {e} — exiting");
                return 1;
            }
        }
        // Drain the mux fd unconditionally: virtio_console poll may not report
        // readability after idle 0-byte reads, so read-first is the only
        // reliable pattern (same as the benchmark reader).
        loop {
            // SAFETY: mux_fd is a valid open descriptor for the loop lifetime.
            match unsafe { unsafe_read(mux_fd, &mut mux_read_buf) } {
                Ok(0) => {
                    // virtio_console returns 0-byte reads when the port is
                    // idle (non-blocking semantics) — NOT EOF. True link loss
                    // surfaces as POLLHUP/POLLERR on the port.
                    break;
                }
                Ok(n) => {
                    in_buf.extend_from_slice(&mux_read_buf[..n]);
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => {
                    eprintln!("valencebox-mux: mux read failed: {e} — exiting");
                    return 1;
                }
            }
        }
        if !in_buf.is_empty() {
            if let Err(e) = process_inbound(&mut in_buf, &mut streams, &mut out) {
                eprintln!("valencebox-mux: {e} — exiting");
                return 1;
            }
            // Flush replies (PONG, CREDIT, DATA) immediately.
            if !out.is_empty() {
                if let Err(e) = out.flush(mux_fd) {
                    eprintln!("valencebox-mux: mux write failed: {e} — exiting");
                    return 1;
                }
            }
        }

        // ---- listener events ----
        for (idx, listener) in [&proxy_listener, &share_listener].into_iter().enumerate() {
            let re = pollfds[1 + idx].revents;
            if re & sys::POLLIN == 0 {
                continue;
            }
            loop {
                match listener.accept() {
                    Ok((sock, _peer)) => {
                        let _ = sock.set_nonblocking(true);
                        let target = relay_targets[&listener.as_raw_fd()];
                        let id = next_id;
                        next_id = next_id.wrapping_add(2);
                        if next_id == 0 {
                            next_id = 2;
                        }
                        out.push_frame(MT_OPEN, id, target.as_bytes());
                        streams.insert(
                            id,
                            Stream {
                                sock,
                                out_buf: Vec::new(),
                                credit: MUX_WINDOW,
                                unacked: 0,
                                received: 0,
                                awaiting_ok: true,
                                fin_from_host: false,
                                fin_sent: false,
                            },
                        );
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) => {
                        eprintln!("valencebox-mux: accept failed: {e}");
                        break;
                    }
                }
            }
        }

        // ---- stream socket events ----
        let mut dead: Vec<u32> = Vec::new();
        for (i, id) in poll_stream_ids.iter().enumerate() {
            let re = pollfds[3 + i].revents;
            if re == 0 {
                continue;
            }
            let Some(s) = streams.get_mut(id) else { continue };

            // Errors / hangups
            if re & sys::POLLERR != 0 || (re & sys::POLLHUP != 0 && re & (sys::POLLIN | sys::POLLRDHUP) == 0) {
                out.push_frame(MT_RESET, *id, &[]);
                dead.push(*id);
                continue;
            }

            // Writable: flush pending out_buf (or finish non-blocking connect is
            // handled in the dial table, not here).
            if re & sys::POLLOUT != 0 && !s.out_buf.is_empty() {
                match s.sock.write(&s.out_buf) {
                    Ok(n) => {
                        s.out_buf.drain(..n);
                        if s.out_buf.is_empty() && s.fin_from_host {
                            s.shutdown_write();
                        }
                        maybe_grant(s, *id, &mut out);
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    Err(_) => {
                        out.push_frame(MT_RESET, *id, &[]);
                        dead.push(*id);
                        continue;
                    }
                }
            }

            // Readable / peer closed
            if re & (sys::POLLIN | sys::POLLRDHUP) != 0 {
                loop {
                    if s.credit == 0 || s.awaiting_ok {
                        break;
                    }
                    let want = std::cmp::min(sock_read_buf.len(), s.credit as usize);
                    match s.sock.read(&mut sock_read_buf[..want]) {
                        Ok(0) => {
                            // Peer closed its write side.
                            if !s.fin_sent {
                                s.fin_sent = true;
                                out.push_frame(MT_FIN, *id, &[]);
                            }
                            if s.fin_from_host && s.out_buf.is_empty() {
                                dead.push(*id);
                            }
                            break;
                        }
                        Ok(n) => {
                            s.credit -= n as u32;
                            let data = sock_read_buf[..n].to_vec();
                            let mut off = 0;
                            while off < data.len() {
                                let end = std::cmp::min(off + DATA_FRAME_CHUNK, data.len());
                                out.push_frame(MT_DATA, *id, &data[off..end]);
                                off = end;
                            }
                            if n < want {
                                break; // drained for now
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                        Err(_) => {
                            out.push_frame(MT_RESET, *id, &[]);
                            dead.push(*id);
                            break;
                        }
                    }
                }
            }

            // Fully closed stream: FIN from host drained + we sent FIN.
            if s.fin_from_host && s.out_buf.is_empty() && s.fin_sent {
                dead.push(*id);
            }
        }

        for id in dead {
            streams.remove(&id);
        }
    }
}

/// Parse and dispatch every complete frame in `in_buf`.
fn process_inbound(
    in_buf: &mut Vec<u8>,
    streams: &mut HashMap<u32, Stream>,
    out: &mut OutQueue,
) -> Result<(), String> {
    loop {
        if in_buf.len() < FRAME_HEADER_SIZE {
            return Ok(());
        }
        let len = u32::from_be_bytes([in_buf[0], in_buf[1], in_buf[2], in_buf[3]]) as usize;
        let typ = in_buf[4];
        let id = u32::from_be_bytes([in_buf[5], in_buf[6], in_buf[7], in_buf[8]]);
        if len > MAX_FRAME_PAYLOAD {
            return Err(format!("mux frame too large: {len}"));
        }
        if in_buf.len() < FRAME_HEADER_SIZE + len {
            return Ok(());
        }
        let payload = in_buf[FRAME_HEADER_SIZE..FRAME_HEADER_SIZE + len].to_vec();
        in_buf.drain(..FRAME_HEADER_SIZE + len);

        match typ {
            MT_OPEN => {
                let target = String::from_utf8_lossy(&payload).to_string();
                handle_host_open(&target, id, streams, out);
            }
            MT_OPEN_OK => {
                if let Some(s) = streams.get_mut(&id) {
                    s.awaiting_ok = false;
                }
            }
            MT_OPEN_FAIL => {
                eprintln!(
                    "valencebox-mux: open refused for stream {id}: {}",
                    String::from_utf8_lossy(&payload)
                );
                streams.remove(&id);
            }
            MT_DATA => {
                if let Some(s) = streams.get_mut(&id) {
                    if !s.fin_from_host {
                        s.received += payload.len() as u64;
                        s.out_buf.extend_from_slice(&payload);
                        // Opportunistic flush.
                        match s.sock.write(&s.out_buf) {
                            Ok(n) => {
                                s.out_buf.drain(..n);
                                if s.out_buf.is_empty() && s.fin_from_host {
                                    s.shutdown_write();
                                }
                            }
                            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                            Err(_) => {
                                out.push_frame(MT_RESET, id, &[]);
                                streams.remove(&id);
                                continue;
                            }
                        }
                        maybe_grant(s, id, out);
                    }
                }
            }
            MT_FIN => {
                if let Some(s) = streams.get_mut(&id) {
                    s.fin_from_host = true;
                    if s.out_buf.is_empty() {
                        s.shutdown_write();
                    }
                }
            }
            MT_RESET => {
                streams.remove(&id);
            }
            MT_CREDIT => {
                if payload.len() >= 4 {
                    let n = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
                    if let Some(s) = streams.get_mut(&id) {
                        s.credit = s.credit.saturating_add(n);
                    }
                }
            }
            MT_PING => {
                out.push_frame(MT_PONG, id, &[]);
            }
            MT_PONG => {}
            _ => {}
        }
    }
}

fn handle_host_open(
    target: &str,
    id: u32,
    streams: &mut HashMap<u32, Stream>,
    out: &mut OutQueue,
) {
    let Some(port_str) = target.strip_prefix("fwd:") else {
        out.push_frame(MT_OPEN_FAIL, id, format!("unknown target '{target}'").as_bytes());
        return;
    };
    let Ok(port) = port_str.parse::<u16>() else {
        out.push_frame(MT_OPEN_FAIL, id, format!("bad port in '{target}'").as_bytes());
        return;
    };
    let sock = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
            // Non-blocking listener? Not expected — treat as failure.
            out.push_frame(MT_OPEN_FAIL, id, b"connect would block");
            return;
        }
        Err(e) => {
            out.push_frame(MT_OPEN_FAIL, id, format!("connect failed: {e}").as_bytes());
            return;
        }
    };
    let _ = sock.set_nonblocking(true);
    let _ = sock.set_nodelay(true);
    out.push_frame(MT_OPEN_OK, id, &[]);
    streams.insert(
        id,
        Stream {
            sock,
            out_buf: Vec::new(),
            credit: MUX_WINDOW,
            unacked: 0,
            received: 0,
            awaiting_ok: false,
            fin_from_host: false,
            fin_sent: false,
        },
    );
}

/// Grant credit back for bytes actually written into the destination socket,
/// in batches of at least MUX_CREDIT_BATCH (mirrors the host side).
fn maybe_grant(s: &mut Stream, id: u32, out: &mut OutQueue) {
    let consumed = s.received.saturating_sub(s.out_buf.len() as u64) as u32;
    let grantable = consumed - s.unacked;
    if grantable >= MUX_CREDIT_BATCH {
        s.unacked += grantable;
        out.push_frame(MT_CREDIT, id, &grantable.to_be_bytes());
    }
}

fn cmdline_u32(key: &str) -> Option<u32> {
    let cmdline = std::fs::read_to_string("/proc/cmdline").ok()?;
    for part in cmdline.split_whitespace() {
        if let Some(val) = part.strip_prefix(&format!("{key}=")) {
            return val.parse().ok();
        }
    }
    None
}
