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
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;

// ---- libc externs (no crates) ----

mod sys {
    use std::os::raw::{c_int, c_uint, c_void};

    pub const POLLIN: i16 = 0x001;
    pub const POLLOUT: i16 = 0x004;
    pub const POLLERR: i16 = 0x008;
    pub const POLLHUP: i16 = 0x010;
    pub const POLLRDHUP: i16 = 0x2000;

    pub const SHUT_WR: c_int = 1;

    // Linux netfilter original destination (include/uapi/linux/netfilter_ipv4.h)
    pub const SOL_IP: c_int = 0;
    pub const SO_ORIGINAL_DST: c_int = 80;
    pub const AF_INET: u16 = 2;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct PollFd {
        pub fd: c_int,
        pub events: i16,
        pub revents: i16,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    pub struct SockAddrIn {
        pub sin_family: u16,
        pub sin_port: u16,
        pub sin_addr: u32,
        pub sin_zero: [u8; 8],
    }

    pub type NfdsT = u64;

    unsafe extern "C" {
        pub fn poll(fds: *mut PollFd, nfds: NfdsT, timeout: c_int) -> c_int;
        pub fn shutdown(fd: c_int, how: c_int) -> c_int;
        pub fn getsockopt(
            sockfd: c_int,
            level: c_int,
            optname: c_int,
            optval: *mut c_void,
            optlen: *mut c_uint,
        ) -> c_int;
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
const DEFAULT_TPROXY_PORT: u32 = 3129;
const DEFAULT_DNS_PORT: u32 = 53;

const MUX_DEVICE: &str = "/dev/virtio-ports/mux";

// ---- Fake-DNS (RFC 2544 198.18.0.0/15) + SO_ORIGINAL_DST ----
//
// 198.18.0.0 is network, 198.18.0.1 is assigned to guest `lo` as the route
// source address, and 198.18.0.2..=198.19.255.254 (131,069 addresses) are
// handed out for A queries and mapped back to the queried hostname when a
// transparent TCP connection arrives on 127.0.0.1:<tproxy_port>.
const FAKE_DNS_BASE: u32 = 0xC612_0000; // 198.18.0.0
const FAKE_DNS_FIRST_OFFSET: u32 = 2;   // 198.18.0.2
const FAKE_DNS_LAST_OFFSET: u32 = 0x0001_FFFE; // 198.19.255.254
const FAKE_DNS_TTL_SECS: u32 = 60;

struct FakeDns {
    name_to_ip: HashMap<String, Ipv4Addr>,
    ip_to_name: HashMap<Ipv4Addr, String>,
    next_offset: u32,
}

impl FakeDns {
    fn new() -> Self {
        FakeDns {
            name_to_ip: HashMap::new(),
            ip_to_name: HashMap::new(),
            next_offset: FAKE_DNS_FIRST_OFFSET,
        }
    }

    fn resolve_or_alloc(&mut self, raw_name: &str) -> Ipv4Addr {
        let name = raw_name.trim_end_matches('.').to_ascii_lowercase();
        if name == "localhost" || name.ends_with(".localhost") {
            return Ipv4Addr::new(127, 0, 0, 1);
        }
        if let Ok(ip) = name.parse::<Ipv4Addr>() {
            return ip;
        }
        if let Some(&ip) = self.name_to_ip.get(&name) {
            return ip;
        }
        let ip = Ipv4Addr::from(FAKE_DNS_BASE + self.next_offset);
        self.next_offset += 1;
        if self.next_offset > FAKE_DNS_LAST_OFFSET {
            self.next_offset = FAKE_DNS_FIRST_OFFSET;
        }
        if let Some(old_name) = self.ip_to_name.insert(ip, name.clone()) {
            self.name_to_ip.remove(&old_name);
        }
        self.name_to_ip.insert(name, ip);
        ip
    }

    fn lookup_ip(&self, ip: Ipv4Addr) -> Option<&str> {
        self.ip_to_name.get(&ip).map(|s| s.as_str())
    }

    /// Parse a raw UDP DNS query and build a DNS response packet.
    /// - `A` (qtype 1): returns a synthetic 198.18.x.y address.
    /// - `AAAA` (qtype 28) or other types: returns NOERROR with 0 answers
    ///   (NODATA) so dual-stack resolvers immediately use the IPv4 `A` record.
    fn handle_packet(&mut self, req: &[u8]) -> Option<Vec<u8>> {
        if req.len() < 12 {
            return None;
        }
        let flags = u16::from_be_bytes([req[2], req[3]]);
        if flags & 0x8000 != 0 {
            return None; // ignore responses
        }
        let qdcount = u16::from_be_bytes([req[4], req[5]]);
        if qdcount == 0 {
            return None;
        }
        let (qname, after_name) = parse_dns_qname(req, 12)?;
        if after_name + 4 > req.len() {
            return None;
        }
        let qtype = u16::from_be_bytes([req[after_name], req[after_name + 1]]);
        let qclass = u16::from_be_bytes([req[after_name + 2], req[after_name + 3]]);
        let q_end = after_name + 4;

        let rd = flags & 0x0100;
        let resp_flags: u16 = 0x8000 | rd | 0x0080; // QR=1, RA=1, RCODE=0 (NOERROR)
        let include_a = qtype == 1 && (qclass == 1 || qclass == 255) && !qname.is_empty();
        let ancount: u16 = if include_a { 1 } else { 0 };

        let mut resp = Vec::with_capacity(q_end + 16);
        resp.extend_from_slice(&req[0..2]); // Transaction ID
        resp.extend_from_slice(&resp_flags.to_be_bytes());
        resp.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT = 1
        resp.extend_from_slice(&ancount.to_be_bytes()); // ANCOUNT
        resp.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT = 0
        resp.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT = 0
        resp.extend_from_slice(&req[12..q_end]); // Question section verbatim

        if include_a {
            let ip = self.resolve_or_alloc(&qname);
            resp.extend_from_slice(&0xC00Cu16.to_be_bytes()); // Name pointer to offset 12
            resp.extend_from_slice(&1u16.to_be_bytes()); // TYPE A
            resp.extend_from_slice(&1u16.to_be_bytes()); // CLASS IN
            resp.extend_from_slice(&FAKE_DNS_TTL_SECS.to_be_bytes());
            resp.extend_from_slice(&4u16.to_be_bytes()); // RDLENGTH = 4
            resp.extend_from_slice(&ip.octets());
        }
        Some(resp)
    }
}

/// Parse a DNS question name starting at `start` (no compression pointers in
/// the single first question, RFC 1035 §4.1.2). Returns `(name, next_offset)`.
fn parse_dns_qname(pkt: &[u8], start: usize) -> Option<(String, usize)> {
    let mut pos = start;
    let mut labels: Vec<String> = Vec::new();
    loop {
        if pos >= pkt.len() {
            return None;
        }
        let len = pkt[pos] as usize;
        pos += 1;
        if len == 0 {
            break;
        }
        if len & 0xC0 != 0 || pos + len > pkt.len() {
            return None;
        }
        let label = std::str::from_utf8(&pkt[pos..pos + len]).ok()?;
        labels.push(label.to_string());
        pos += len;
        if pos - start > 255 {
            return None;
        }
    }
    Some((labels.join("."), pos))
}

/// Query netfilter `SO_ORIGINAL_DST` on a redirected IPv4 TCP socket.
fn orig_dst_of(sock: &TcpStream) -> Option<SocketAddrV4> {
    let mut addr = sys::SockAddrIn::default();
    let mut len = std::mem::size_of::<sys::SockAddrIn>() as std::os::raw::c_uint;
    let rc = unsafe {
        sys::getsockopt(
            sock.as_raw_fd(),
            sys::SOL_IP,
            sys::SO_ORIGINAL_DST,
            (&mut addr as *mut sys::SockAddrIn).cast(),
            &mut len,
        )
    };
    if rc != 0 || addr.sin_family != sys::AF_INET {
        return None;
    }
    let ip = Ipv4Addr::from(u32::from_be(addr.sin_addr));
    let port = u16::from_be(addr.sin_port);
    Some(SocketAddrV4::new(ip, port))
}

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
    let tproxy_port = cmdline_u32("valencebox.tproxy_port")
        .or_else(|| std::env::var("VALENCEBOX_TPROXY_PORT").ok()?.parse().ok())
        .unwrap_or(DEFAULT_TPROXY_PORT);
    let dns_port_explicit = cmdline_u32("valencebox.dns_port")
        .or_else(|| std::env::var("VALENCEBOX_DNS_PORT").ok()?.parse().ok());
    let dns_port = dns_port_explicit.unwrap_or(DEFAULT_DNS_PORT);
    // Dev/test affordance: override target when connecting directly to
    // tproxy_listener without netfilter REDIRECT (e.g. "198.18.0.2:80" or "example.com:80").
    let tproxy_test_dst = std::env::var("VALENCEBOX_TPROXY_DEFAULT_DST").ok();

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
    let tproxy_listener = match TcpListener::bind(("127.0.0.1", tproxy_port as u16)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("valencebox-mux: cannot bind tproxy 127.0.0.1:{tproxy_port}: {e}");
            return 1;
        }
    };
    let tproxy_bound_port = tproxy_listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(tproxy_port as u16);
    for l in [&proxy_listener, &share_listener, &tproxy_listener] {
        if let Err(e) = l.set_nonblocking(true) {
            eprintln!("valencebox-mux: set_nonblocking: {e}");
            return 1;
        }
    }

    let dns_sock: Option<UdpSocket> = if dns_port == 0 {
        None
    } else {
        match UdpSocket::bind(("127.0.0.1", dns_port as u16)) {
            Ok(s) => {
                if let Err(e) = s.set_nonblocking(true) {
                    eprintln!("valencebox-mux: dns set_nonblocking: {e}");
                    return 1;
                }
                Some(s)
            }
            Err(e) if dns_port_explicit.is_none() && e.kind() == io::ErrorKind::PermissionDenied => {
                eprintln!("valencebox-mux: skipping privileged DNS bind 127.0.0.1:{dns_port} ({e})");
                None
            }
            Err(e) => {
                eprintln!("valencebox-mux: cannot bind DNS 127.0.0.1:{dns_port}: {e}");
                return 1;
            }
        }
    };
    let mut fake_dns = FakeDns::new();

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
        "valencebox-mux: started (proxy relay 127.0.0.1:{proxy_port}, share relay 127.0.0.1:{share_port}, tproxy 127.0.0.1:{tproxy_bound_port}, dns {})",
        dns_sock
            .as_ref()
            .and_then(|s| s.local_addr().ok())
            .map(|a| a.to_string())
            .unwrap_or_else(|| "disabled".to_string()),
    );

    let mut mux_read_buf = vec![0u8; 256 * 1024];
    let mut sock_read_buf = vec![0u8; 64 * 1024];
    let mut dns_buf = [0u8; 2048];
    loop {
        // ---- build poll set ----
        let mut pollfds: Vec<sys::PollFd> = Vec::with_capacity(6 + streams.len());
        let mut mux_events = sys::POLLIN;
        if !out.is_empty() {
            mux_events |= sys::POLLOUT;
        }
        pollfds.push(sys::PollFd { fd: mux_fd, events: mux_events, revents: 0 });
        pollfds.push(sys::PollFd { fd: proxy_listener.as_raw_fd(), events: sys::POLLIN, revents: 0 });
        pollfds.push(sys::PollFd { fd: share_listener.as_raw_fd(), events: sys::POLLIN, revents: 0 });
        pollfds.push(sys::PollFd { fd: tproxy_listener.as_raw_fd(), events: sys::POLLIN, revents: 0 });
        let dns_poll_idx = if let Some(ref ds) = dns_sock {
            let idx = pollfds.len();
            pollfds.push(sys::PollFd { fd: ds.as_raw_fd(), events: sys::POLLIN, revents: 0 });
            Some(idx)
        } else {
            None
        };
        let stream_poll_base = pollfds.len();

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

        // ---- Fake-DNS UDP events ----
        if let (Some(idx), Some(ds)) = (dns_poll_idx, dns_sock.as_ref()) {
            if pollfds[idx].revents & sys::POLLIN != 0 {
                loop {
                    match ds.recv_from(&mut dns_buf) {
                        Ok((n, peer)) => {
                            if let Some(resp) = fake_dns.handle_packet(&dns_buf[..n]) {
                                let _ = ds.send_to(&resp, peer);
                            }
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                        Err(e) => {
                            eprintln!("valencebox-mux: dns recv_from failed: {e}");
                            break;
                        }
                    }
                }
            }
        }

        // ---- listener events (explicit proxy + share relays) ----
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

        // ---- transparent proxy listener events (SO_ORIGINAL_DST + Fake-DNS) ----
        if pollfds[3].revents & sys::POLLIN != 0 {
            loop {
                match tproxy_listener.accept() {
                    Ok((sock, _peer)) => {
                        let _ = sock.set_nonblocking(true);
                        let Some(target) = resolve_tproxy_target(
                            &sock,
                            tproxy_bound_port,
                            &fake_dns,
                            tproxy_test_dst.as_deref(),
                        ) else {
                            continue;
                        };
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
                        eprintln!("valencebox-mux: tproxy accept failed: {e}");
                        break;
                    }
                }
            }
        }

        // ---- stream socket events ----
        let mut dead: Vec<u32> = Vec::new();
        for (i, id) in poll_stream_ids.iter().enumerate() {
            let re = pollfds[stream_poll_base + i].revents;
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

fn resolve_tproxy_target(
    sock: &TcpStream,
    tproxy_bound_port: u16,
    fake_dns: &FakeDns,
    test_default_dst: Option<&str>,
) -> Option<String> {
    let orig = orig_dst_of(sock);
    let is_self_connect = match orig {
        Some(dst) => *dst.ip() == Ipv4Addr::new(127, 0, 0, 1) && dst.port() == tproxy_bound_port,
        None => true,
    };
    if is_self_connect {
        // Without netfilter REDIRECT, SO_ORIGINAL_DST returns the listener's
        // own 127.0.0.1:<tproxy_bound_port> address (or fails). Allow a dev/test
        // override (`VALENCEBOX_TPROXY_DEFAULT_DST=host_or_ip:port`); otherwise
        // drop to prevent a self-connect loop.
        let raw = test_default_dst?;
        let (h, p_str) = raw.rsplit_once(':')?;
        let port: u16 = p_str.parse().ok()?;
        let host = if let Ok(ip) = h.parse::<Ipv4Addr>() {
            fake_dns
                .lookup_ip(ip)
                .map(|s| s.to_string())
                .unwrap_or_else(|| ip.to_string())
        } else {
            h.to_string()
        };
        return Some(format!("tproxy:{host}:{port}"));
    }
    let dst = orig?;
    let ip = *dst.ip();
    let port = dst.port();
    let host = fake_dns
        .lookup_ip(ip)
        .map(|s| s.to_string())
        .unwrap_or_else(|| ip.to_string());
    Some(format!("tproxy:{host}:{port}"))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn build_dns_query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
        let mut pkt = Vec::new();
        pkt.extend_from_slice(&id.to_be_bytes());
        pkt.extend_from_slice(&0x0100u16.to_be_bytes()); // RD=1
        pkt.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT=1
        pkt.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT=0
        pkt.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT=0
        pkt.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT=0
        for label in name.trim_end_matches('.').split('.') {
            pkt.push(label.len() as u8);
            pkt.extend_from_slice(label.as_bytes());
        }
        pkt.push(0);
        pkt.extend_from_slice(&qtype.to_be_bytes());
        pkt.extend_from_slice(&1u16.to_be_bytes()); // QCLASS=IN
        pkt
    }

    #[test]
    fn fake_dns_allocates_and_reuses_198_18_addresses() {
        let mut dns = FakeDns::new();
        let ip1 = dns.resolve_or_alloc("PyPI.org.");
        assert_eq!(ip1, Ipv4Addr::new(198, 18, 0, 2));
        let ip1_again = dns.resolve_or_alloc("pypi.org");
        assert_eq!(ip1, ip1_again);
        assert_eq!(dns.lookup_ip(ip1), Some("pypi.org"));

        let ip2 = dns.resolve_or_alloc("registry.npmjs.org");
        assert_eq!(ip2, Ipv4Addr::new(198, 18, 0, 3));
        assert_eq!(dns.lookup_ip(ip2), Some("registry.npmjs.org"));

        assert_eq!(dns.resolve_or_alloc("localhost"), Ipv4Addr::new(127, 0, 0, 1));
    }

    #[test]
    fn fake_dns_packet_a_and_aaaa() {
        let mut dns = FakeDns::new();
        let q_a = build_dns_query(0x1234, "api.example.com", 1);
        let resp_a = dns.handle_packet(&q_a).expect("A response");
        assert_eq!(&resp_a[0..2], &[0x12, 0x34]);
        assert_eq!(u16::from_be_bytes([resp_a[6], resp_a[7]]), 1); // ANCOUNT=1
        let rdata = &resp_a[resp_a.len() - 4..];
        assert_eq!(rdata, &[198, 18, 0, 2]);
        assert_eq!(dns.lookup_ip(Ipv4Addr::new(198, 18, 0, 2)), Some("api.example.com"));

        // AAAA query returns NOERROR with ANCOUNT=0 (NODATA)
        let q_aaaa = build_dns_query(0x5678, "api.example.com", 28);
        let resp_aaaa = dns.handle_packet(&q_aaaa).expect("AAAA response");
        assert_eq!(&resp_aaaa[0..2], &[0x56, 0x78]);
        assert_eq!(resp_aaaa[3] & 0x0f, 0); // RCODE=0 (NOERROR)
        assert_eq!(u16::from_be_bytes([resp_aaaa[6], resp_aaaa[7]]), 0); // ANCOUNT=0
    }
}
