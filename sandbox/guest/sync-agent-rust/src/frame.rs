use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

pub const TYPE_HELLO: u8 = 1;
pub const TYPE_MANIFEST: u8 = 2;
pub const TYPE_FILE_PUT: u8 = 3;
pub const TYPE_FILE_CHUNK: u8 = 4;
pub const TYPE_FILE_DEL: u8 = 5;
pub const TYPE_ACK: u8 = 6;
pub const TYPE_NAK: u8 = 7;
pub const TYPE_EVENT: u8 = 8;
pub const TYPE_PING: u8 = 9;
pub const TYPE_TREE_PUT: u8 = 10;
pub const TYPE_FILE_RENAME: u8 = 11;

pub const MAX_PAYLOAD: u32 = 262_144;
pub const CHUNK_SIZE: usize = 48 * 1024;

const MAGIC: [u8; 4] = [b'V', b'8', b'6', b'S'];

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub typ: u8,
    pub seq: u32,
    pub payload: Vec<u8>,
}

pub fn read_frame(r: &mut impl Read) -> io::Result<Frame> {
    let mut matched: usize = 0;
    while matched < 4 {
        let mut b = [0u8; 1];
        r.read_exact(&mut b)?;
        if b[0] == MAGIC[matched] {
            matched += 1;
        } else if b[0] == MAGIC[0] {
            matched = 1;
        } else {
            matched = 0;
        }
    }

    let mut hdr = [0u8; 9];
    r.read_exact(&mut hdr)?;
    let typ = hdr[0];
    let seq = u32::from_le_bytes([hdr[1], hdr[2], hdr[3], hdr[4]]);
    let plen = u32::from_le_bytes([hdr[5], hdr[6], hdr[7], hdr[8]]);
    if plen > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("payload too large: {}", plen),
        ));
    }

    let mut payload = vec![0u8; plen as usize];
    r.read_exact(&mut payload)?;

    let mut crcb = [0u8; 4];
    r.read_exact(&mut crcb)?;
    let wire_crc = u32::from_le_bytes(crcb);

    let mut crc = crc32fast::Hasher::new();
    crc.update(&hdr);
    crc.update(&payload);
    if crc.finalize() != wire_crc {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("crc mismatch on frame type {} seq {}", typ, seq),
        ));
    }

    Ok(Frame { typ, seq, payload })
}

pub struct FrameWriter {
    inner: Mutex<FrameWriterInner>,
}

struct FrameWriterInner {
    w: Box<dyn Write + Send>,
    seq: u32,
    pending: HashMap<u32, mpsc::Sender<(u8, Vec<u8>)>>,
    xfer_waiters: HashMap<u32, mpsc::Sender<(u8, Vec<u8>)>>,
}

impl FrameWriter {
    pub fn new(w: Box<dyn Write + Send>) -> Self {
        Self {
            inner: Mutex::new(FrameWriterInner {
                w,
                seq: 0,
                pending: HashMap::new(),
                xfer_waiters: HashMap::new(),
            }),
        }
    }

    pub fn send(&self, typ: u8, payload: &[u8]) -> io::Result<u32> {
        if payload.len() > MAX_PAYLOAD as usize {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("payload too large: {}", payload.len()),
            ));
        }
        let mut inner = self.inner.lock().unwrap();
        inner.seq = inner.seq.wrapping_add(1);
        let seq = inner.seq;

        let mut hdr = [0u8; 9];
        hdr[0] = typ;
        hdr[1..5].copy_from_slice(&seq.to_le_bytes());
        hdr[5..9].copy_from_slice(&(payload.len() as u32).to_le_bytes());

        let mut crc = crc32fast::Hasher::new();
        crc.update(&hdr);
        crc.update(payload);
        let crc_val = crc.finalize();

        let mut buf = Vec::with_capacity(4 + 9 + payload.len() + 4);
        buf.extend_from_slice(&MAGIC);
        buf.extend_from_slice(&hdr);
        buf.extend_from_slice(payload);
        buf.extend_from_slice(&crc_val.to_le_bytes());
        inner.w.write_all(&buf)?;
        Ok(seq)
    }

    /// Send a frame and block until its seq-matched ACK/NAK arrives.
    /// Returns Ok((typ, payload)) on ACK, Err on NAK or timeout.
    pub fn request(&self, typ: u8, payload: &[u8], timeout: Duration) -> Result<(u8, Vec<u8>), io::Error> {
        let (tx, rx) = mpsc::channel();
        if payload.len() > MAX_PAYLOAD as usize {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("payload too large: {}", payload.len()),
            ));
        }
        let seq = {
            let mut inner = self.inner.lock().unwrap();
            inner.seq = inner.seq.wrapping_add(1);
            let seq = inner.seq;
            inner.pending.insert(seq, tx);

            let mut hdr = [0u8; 9];
            hdr[0] = typ;
            hdr[1..5].copy_from_slice(&seq.to_le_bytes());
            hdr[5..9].copy_from_slice(&(payload.len() as u32).to_le_bytes());

            let mut crc = crc32fast::Hasher::new();
            crc.update(&hdr);
            crc.update(payload);
            let crc_val = crc.finalize();

            let mut buf = Vec::with_capacity(4 + 9 + payload.len() + 4);
            buf.extend_from_slice(&MAGIC);
            buf.extend_from_slice(&hdr);
            buf.extend_from_slice(payload);
            buf.extend_from_slice(&crc_val.to_le_bytes());
            if let Err(e) = inner.w.write_all(&buf) {
                inner.pending.remove(&seq);
                return Err(e);
            }
            seq
        };
        match rx.recv_timeout(timeout) {
            Ok((resp_typ, resp_payload)) => {
                if resp_typ == TYPE_NAK {
                    let msg = String::from_utf8_lossy(&resp_payload).to_string();
                    return Err(io::Error::new(io::ErrorKind::Other, format!("NAK: {}", msg)));
                }
                Ok((resp_typ, resp_payload))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mut inner = self.inner.lock().unwrap();
                inner.pending.remove(&seq);
                Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "channel disconnected"))
            }
        }
    }

    /// Deliver an incoming ACK/NAK to a waiting request(). Returns true if consumed.
    pub fn complete_request(&self, seq: u32, resp_typ: u8, resp_payload: &[u8]) -> bool {
        let tx = {
            let mut inner = self.inner.lock().unwrap();
            inner.pending.remove(&seq)
        };
        if let Some(tx) = tx {
            let _ = tx.send((resp_typ, resp_payload.to_vec()));
            true
        } else {
            false
        }
    }

    /// Deliver an incoming ACK/NAK to a waiting xfer waiter. Returns true if consumed.
    /// Does NOT remove the waiter — the entry stays registered so subsequent
    /// ACKs (e.g. done-ack after ready-ack) also reach the same channel.
    /// The waiter is replaced when a new xfer reuses the same ID.
    pub fn complete_xfer(&self, xfer: u32, resp_typ: u8, resp_payload: &[u8]) -> bool {
        let tx = {
            let inner = self.inner.lock().unwrap();
            inner.xfer_waiters.get(&xfer).cloned()
        };
        if let Some(tx) = tx {
            let _ = tx.send((resp_typ, resp_payload.to_vec()));
            true
        } else {
            false
        }
    }

    /// Register an external xfer waiter (for push_file ready-ack).
    pub fn register_xfer_waiter(&self, xfer: u32, tx: mpsc::Sender<(u8, Vec<u8>)>) {
        let mut inner = self.inner.lock().unwrap();
        inner.xfer_waiters.insert(xfer, tx);
    }
}

 #[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct SharedWriter {
        data: Arc<Mutex<Vec<u8>>>,
    }

    impl SharedWriter {
        fn new() -> (Self, Arc<Mutex<Vec<u8>>>) {
            let data = Arc::new(Mutex::new(Vec::new()));
            (Self { data: data.clone() }, data)
        }
    }

    impl Write for SharedWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.data.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn write_frame(typ: u8, payload: &[u8]) -> (u32, Vec<u8>) {
        let (sw, data) = SharedWriter::new();
        let fw = FrameWriter::new(Box::new(sw));
        let seq = fw.send(typ, payload).unwrap();
        let out = data.lock().unwrap().clone();
        (seq, out)
    }

    #[test]
    fn roundtrip_empty_payload() {
        let (_, out) = write_frame(TYPE_HELLO, b"");
        let frame = read_frame(&mut &out[..]).unwrap();
        assert_eq!(frame.typ, TYPE_HELLO);
        assert_eq!(frame.seq, 1);
        assert!(frame.payload.is_empty());
    }

    #[test]
    fn roundtrip_payload() {
        let (_, out) = write_frame(TYPE_MANIFEST, b"hello world");
        let frame = read_frame(&mut &out[..]).unwrap();
        assert_eq!(frame.typ, TYPE_MANIFEST);
        assert_eq!(frame.seq, 1);
        assert_eq!(frame.payload, b"hello world");
    }

    #[test]
    fn roundtrip_large_payload() {
        let payload = vec![0xABu8; MAX_PAYLOAD as usize];
        let (_, out) = write_frame(TYPE_FILE_CHUNK, &payload);
        let frame = read_frame(&mut &out[..]).unwrap();
        assert_eq!(frame.typ, TYPE_FILE_CHUNK);
        assert_eq!(frame.seq, 1);
        assert_eq!(frame.payload, payload);
    }

    #[test]
    fn seq_auto_increment() {
        let (sw, _) = SharedWriter::new();
        let fw = FrameWriter::new(Box::new(sw));
        let s1 = fw.send(TYPE_HELLO, b"").unwrap();
        let s2 = fw.send(TYPE_HELLO, b"").unwrap();
        let s3 = fw.send(TYPE_HELLO, b"").unwrap();
        assert_eq!(s1, 1);
        assert_eq!(s2, 2);
        assert_eq!(s3, 3);
    }

    #[test]
    fn crc_matches_ts_ieee() {
        let (_, out) = write_frame(TYPE_ACK, b"test");
        let wire_crc = u32::from_le_bytes([out[out.len() - 4], out[out.len() - 3], out[out.len() - 2], out[out.len() - 1]]);

        let hdr = &out[4..13];
        let payload = &out[13..out.len() - 4];
        let mut crc = crc32fast::Hasher::new();
        crc.update(hdr);
        crc.update(payload);
        assert_eq!(crc.finalize(), wire_crc);

        let mut c = 0xFFFFFFFFu32;
        for &b in hdr.iter().chain(payload.iter()) {
            c ^= b as u32;
            for _ in 0..8 {
                c = match c & 1 {
                    1 => 0xEDB88320 ^ (c >> 1),
                    _ => c >> 1,
                };
            }
        }
        let manual_crc = !c;
        assert_eq!(manual_crc, wire_crc);
    }

    #[test]
    fn resync_garbage_before_magic() {
        let (_, out) = write_frame(TYPE_PING, b"ok");
        let mut stream = Vec::new();
        stream.extend_from_slice(b"XXXXXX");
        stream.extend_from_slice(&out);
        let frame = read_frame(&mut &stream[..]).unwrap();
        assert_eq!(frame.typ, TYPE_PING);
        assert_eq!(frame.payload, b"ok");
    }

    #[test]
    fn resync_partial_magic_overlap() {
        let (_, out) = write_frame(TYPE_PING, b"data");
        let mut stream = Vec::new();
        stream.extend_from_slice(b"V86V");
        stream.extend_from_slice(&out);
        let frame = read_frame(&mut &stream[..]).unwrap();
        assert_eq!(frame.typ, TYPE_PING);
        assert_eq!(frame.payload, b"data");
    }

    #[test]
    fn payload_too_large() {
        let (sw, _) = SharedWriter::new();
        let fw = FrameWriter::new(Box::new(sw));
        let big = vec![0u8; MAX_PAYLOAD as usize + 1];
        assert!(fw.send(TYPE_FILE_PUT, &big).is_err());
    }

    #[test]
    fn request_ack_and_nak() {
        use std::thread;
        let (sw, _) = SharedWriter::new();
        let fw = Arc::new(FrameWriter::new(Box::new(sw)));

        // Simulate an ACK arriving from another "thread" via complete_request
        let fw_clone = fw.clone();
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            let payload = serde_json::to_vec(&serde_json::json!({"ack": 1})).unwrap();
            fw_clone.complete_request(1, TYPE_ACK, &payload);
        });

        let result = fw.request(TYPE_PING, b"hello", Duration::from_secs(5));
        handle.join().unwrap();
        assert!(result.is_ok());
        let (typ, payload) = result.unwrap();
        assert_eq!(typ, TYPE_ACK);
        assert!(payload.len() > 0);

        // NAK test
        let (sw2, _) = SharedWriter::new();
        let fw2 = Arc::new(FrameWriter::new(Box::new(sw2)));
        let fw2_clone = fw2.clone();
        let handle2 = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            let payload = serde_json::to_vec(&serde_json::json!({"ack": 1, "error": "bad"})).unwrap();
            fw2_clone.complete_request(1, TYPE_NAK, &payload);
        });

        let result = fw2.request(TYPE_PING, b"hello", Duration::from_secs(5));
        handle2.join().unwrap();
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("NAK"));

        // Timeout test
        let (sw3, _) = SharedWriter::new();
        let fw3 = FrameWriter::new(Box::new(sw3));
        let result = fw3.request(TYPE_PING, b"test", Duration::from_millis(10));
        assert!(result.is_err());
        assert!(format!("{}", result.unwrap_err()).contains("timeout"));
    }
}
