
use std::collections::HashMap;
use std::io::{self, Read, Write as IoWrite, Seek, SeekFrom};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::frame::{Frame, FrameWriter, TYPE_ACK, TYPE_FILE_CHUNK, TYPE_FILE_DEL, TYPE_FILE_PUT, TYPE_MANIFEST, TYPE_NAK};
use crate::manifest::{ignored_rel, marshal_manifest_batches, safe_join, build_manifest, Manifest};
use crate::state::SyncState;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutMeta {
    pub xfer: u32,
    pub path: String,
    pub size: i64,
    pub mode: u32,
    pub mtime_ms: i64,
    pub hash: String,
}

#[derive(Clone)]
struct Incoming {
    meta: PutMeta,
    tmp_path: String,
    received: i64,
    chunks: i32,
}

struct IncomingTree {
    xfer: u32,
    size: i64,
    received: i64,
    chunks: i32,
    buf: Vec<u8>,
    cur: Option<PutMeta>,
    cur_file: Option<std::fs::File>,
    cur_path: String,
    cur_left: i64,
    skipping: bool,
    skipped: Vec<String>,
}

struct ReceiverInner {
    root: String,
    fw: Arc<FrameWriter>,
    xfers: HashMap<u32, Incoming>,
    trees: HashMap<u32, IncomingTree>,
    sync: Arc<SyncState>,
    verify: bool,
}

pub struct Receiver {
    inner: Mutex<ReceiverInner>,
}

pub fn new_receiver(root: &str, fw: Arc<FrameWriter>, sync: Arc<SyncState>, verify: bool) -> Receiver {
    Receiver {
        inner: Mutex::new(ReceiverInner {
            root: root.to_string(),
            fw,
            xfers: HashMap::new(),
            trees: HashMap::new(),
            sync,
            verify,
        }),
    }
}

impl Receiver {
    fn ack(&self, seq: u32, extra: Option<serde_json::Value>) {
        let mut m = serde_json::Map::new();
        m.insert("ack".to_string(), serde_json::json!(seq));
        if let Some(e) = extra {
            if let serde_json::Value::Object(obj) = e {
                for (k, v) in obj {
                    m.insert(k, v);
                }
            }
        }
        let payload = serde_json::to_vec(&serde_json::Value::Object(m)).unwrap();
        crate::slog!("GUEST TX: ACK seq={} payload={}", seq, String::from_utf8_lossy(&payload));
        let fw = {
            let inner = self.inner.lock().unwrap();
            inner.fw.clone()
        };
        let _ = fw.send(TYPE_ACK, &payload);
    }

    fn nak(&self, seq: u32, err: &str, extra: Option<serde_json::Value>) {
        let mut m = serde_json::Map::new();
        m.insert("ack".to_string(), serde_json::json!(seq));
        m.insert("error".to_string(), serde_json::json!(err));
        if let Some(e) = extra {
            if let serde_json::Value::Object(obj) = e {
                for (k, v) in obj {
                    m.insert(k, v);
                }
            }
        }
        let payload = serde_json::to_vec(&serde_json::Value::Object(m)).unwrap();
        let fw = {
            let inner = self.inner.lock().unwrap();
            inner.fw.clone()
        };
        let _ = fw.send(TYPE_NAK, &payload);
    }

    pub fn handle_put(&self, f: &Frame) {
        let meta: PutMeta = match serde_json::from_slice(&f.payload) {
            Ok(m) => m,
            Err(_) => {
                self.nak(f.seq, "bad FILE_PUT json", None);
                return;
            }
        };
        crate::slog!("handle_put: path={} size={} xfer={}", meta.path, meta.size, meta.xfer);
        let root = self.inner.lock().unwrap().root.clone();
        let abs = match safe_join(&root, &meta.path) {
            Some(a) => a,
            None => {
                self.nak(f.seq, "illegal path", Some(serde_json::json!({"xfer": meta.xfer})));
                return;
            }
        };
        let sync = self.inner.lock().unwrap().sync.clone();
        let (winner, conflict) = sync.resolve_incoming(&meta.path, &abs, &meta.hash, meta.mtime_ms);
        if conflict && winner == "local" {
            self.nak(f.seq, "conflict: local wins", Some(serde_json::json!({"xfer": meta.xfer, "conflict": true})));
            return;
        }
        if let Err(e) = std::fs::create_dir_all(Path::new(&abs).parent().unwrap()) {
            self.nak(f.seq, &e.to_string(), Some(serde_json::json!({"xfer": meta.xfer})));
            return;
        }
        let tmp_dir = format!("{}/.sync-tmp", root);
        let _ = std::fs::create_dir_all(&tmp_dir);
        let tmp_path = format!("{}/put-{}", tmp_dir, std::process::id());
        let _ = std::fs::write(&tmp_path, b"");

        {
            let mut inner = self.inner.lock().unwrap();
            inner.xfers.insert(meta.xfer, Incoming {
                meta: meta.clone(),
                tmp_path: tmp_path.clone(),
                received: 0,
                chunks: 0,
            });
        }
        if meta.size == 0 {
            crate::slog!("handle_put: zero-size file, finishing immediately");
            self.finish(f.seq, meta.xfer);
        } else {
            crate::slog!("handle_put: sending ready-ack for non-zero file");
            self.ack(f.seq, Some(serde_json::json!({"xfer": meta.xfer})));
        }
    }

    pub fn handle_chunk(&self, f: &Frame) {
        if f.payload.len() < 12 {
            self.nak(f.seq, "short chunk", None);
            return;
        }
        let xfer = u32::from_le_bytes([
            f.payload[0], f.payload[1], f.payload[2], f.payload[3],
        ]);
        let offset = u64::from_le_bytes([
            f.payload[4], f.payload[5], f.payload[6], f.payload[7],
            f.payload[8], f.payload[9], f.payload[10], f.payload[11],
        ]) as i64;
        let data = &f.payload[12..];

        let is_tree = {
            let inner = self.inner.lock().unwrap();
            inner.trees.contains_key(&xfer)
        };

        if is_tree {
            self.handle_tree_chunk(f.seq, xfer, offset, data);
            return;
        }

        let _in_meta = {
            let inner = self.inner.lock().unwrap();
            match inner.xfers.get(&xfer) {
                Some(i) => i.meta.clone(),
                None => {
                    self.nak(f.seq, "unknown xfer", Some(serde_json::json!({"xfer": xfer})));
                    return;
                }
            }
        };

        let tmp_path = {
            let inner = self.inner.lock().unwrap();
            match inner.xfers.get(&xfer) {
                Some(i) => i.tmp_path.clone(),
                None => return,
            }
        };

        let mut tmp_file = match std::fs::OpenOptions::new().write(true).open(&tmp_path) {
            Ok(f) => f,
            Err(e) => {
                self.abort(f.seq, xfer, &e.to_string());
                return;
            }
        };
        if let Err(_) = tmp_file.seek(SeekFrom::Start(offset as u64)) {
            drop(tmp_file);
            self.abort(f.seq, xfer, "seek failed");
            return;
        }
        if let Err(e) = tmp_file.write_all(data) {
            drop(tmp_file);
            self.abort(f.seq, xfer, &e.to_string());
            return;
        }
        drop(tmp_file);

        let (done, progress_ack, received) = {
            let mut inner = self.inner.lock().unwrap();
            let in_mut = match inner.xfers.get_mut(&xfer) {
                Some(i) => i,
                None => return,
            };
            in_mut.received += data.len() as i64;
            in_mut.chunks += 1;

            if in_mut.received >= in_mut.meta.size {
                (true, false, 0i64)
            } else if in_mut.chunks % 16 == 0 {
                (false, true, in_mut.received)
            } else {
                (false, false, 0i64)
            }
        };

        if done {
            self.finish(f.seq, xfer);
        } else if progress_ack {
            self.ack(f.seq, Some(serde_json::json!({"xfer": xfer, "received": received})));
        }
    }

    fn finish(&self, seq: u32, xfer: u32) {
        crate::slog!("finish: seq={} xfer={}", seq, xfer);
        let (tmp_path, meta, verify, root, sync) = {
            let mut inner = self.inner.lock().unwrap();
            let in_entry = match inner.xfers.remove(&xfer) {
                Some(i) => i,
                None => return,
            };
            (
                in_entry.tmp_path,
                in_entry.meta,
                inner.verify,
                inner.root.clone(),
                inner.sync.clone(),
            )
        };

        if verify {
            let h = match crate::manifest::hash_file(&tmp_path) {
                Ok(h) => h,
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp_path);
                    self.nak(seq, &format!("hash read error: {}", e), Some(serde_json::json!({"xfer": xfer})));
                    return;
                }
            };
            if h != meta.hash {
                let _ = std::fs::remove_file(&tmp_path);
                self.nak(seq, &format!("hash mismatch: got {} want {}", h, meta.hash), Some(serde_json::json!({"xfer": xfer})));
                return;
            }
        }

        let abs = match safe_join(&root, &meta.path) {
            Some(a) => a,
            None => {
                let _ = std::fs::remove_file(&tmp_path);
                self.nak(seq, "illegal path on finish", Some(serde_json::json!({"xfer": xfer})));
                return;
            }
        };

        let _ = std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(meta.mode));
        set_mtime(&tmp_path, meta.mtime_ms);

        if let Err(e) = std::fs::rename(&tmp_path, &abs) {
            let _ = std::fs::remove_file(&tmp_path);
            self.nak(seq, &e.to_string(), Some(serde_json::json!({"xfer": xfer})));
            return;
        }

        sync.mark_synced(&meta.path, &meta.hash);
        self.ack(seq, Some(serde_json::json!({"xfer": xfer, "done": true})));
    }

    fn abort(&self, seq: u32, xfer: u32, msg: &str) {
        crate::slog!("sync-agent: xfer {} aborted: {}", xfer, msg);
        let tmp_path = {
            let mut inner = self.inner.lock().unwrap();
            match inner.xfers.remove(&xfer) {
                Some(i) => i.tmp_path,
                None => {
                    self.nak(seq, msg, Some(serde_json::json!({"xfer": xfer})));
                    return;
                }
            }
        };
        let _ = std::fs::remove_file(&tmp_path);
        self.nak(seq, msg, Some(serde_json::json!({"xfer": xfer})));
    }

    pub fn handle_tree_put(&self, f: &Frame) {
        let meta: serde_json::Value = match serde_json::from_slice(&f.payload) {
            Ok(m) => m,
            Err(_) => {
                self.nak(f.seq, "bad TREE_PUT json", None);
                return;
            }
        };
        let xfer = meta.get("xfer").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let size = meta.get("size").and_then(|v| v.as_i64()).unwrap_or(0);

        {
            let mut inner = self.inner.lock().unwrap();
            inner.trees.insert(xfer, IncomingTree {
                xfer,
                size,
                received: 0,
                chunks: 0,
                buf: Vec::new(),
                cur: None,
                cur_file: None,
                cur_path: String::new(),
                cur_left: 0,
                skipping: false,
                skipped: Vec::new(),
            });
        }

        if size == 0 {
            let tr = self.inner.lock().unwrap().trees.remove(&xfer);
            if let Some(tr) = tr {
                self.finish_tree(f.seq, tr);
            }
        }
    }

    fn handle_tree_chunk(&self, seq: u32, xfer: u32, offset: i64, data: &[u8]) {
        let expected = {
            let inner = self.inner.lock().unwrap();
            match inner.trees.get(&xfer) {
                Some(t) => t.received,
                None => {
                    self.nak(seq, "unknown tree xfer", Some(serde_json::json!({"xfer": xfer})));
                    return;
                }
            }
        };

        if offset != expected {
            let tr = self.inner.lock().unwrap().trees.remove(&xfer);
            if let Some(tr) = tr {
                self.abort_tree(seq, tr, &format!("out-of-order tree chunk: got {} want {}", offset, expected));
            }
            return;
        }

        let root = self.inner.lock().unwrap().root.clone();
        let sync = self.inner.lock().unwrap().sync.clone();

        let (done, progress_ack, received) = {
            let mut inner = self.inner.lock().unwrap();
            let tr = match inner.trees.get_mut(&xfer) {
                Some(t) => t,
                None => return,
            };
            tr.received += data.len() as i64;
            tr.chunks += 1;

            if let Err(e) = self.unpack(tr, &root, &sync, data) {
                let tr = inner.trees.remove(&xfer);
                drop(inner);
                if let Some(tr) = tr {
                    self.abort_tree(seq, tr, &e);
                }
                return;
            }

            if tr.received >= tr.size {
                (true, false, 0i64)
            } else if tr.chunks % 16 == 0 {
                (false, true, tr.received)
            } else {
                (false, false, 0i64)
            }
        };

        if done {
            let tr = self.inner.lock().unwrap().trees.remove(&xfer);
            if let Some(tr) = tr {
                self.finish_tree(seq, tr);
            }
        } else if progress_ack {
            self.ack(seq, Some(serde_json::json!({"xfer": xfer, "received": received})));
        }
    }

    fn unpack(&self, tr: &mut IncomingTree, root: &str, sync: &SyncState, data: &[u8]) -> Result<(), String> {
        tr.buf.extend_from_slice(data);
        loop {
            if tr.cur.is_none() {
                if tr.buf.len() < 4 {
                    return Ok(());
                }
                let hlen = u32::from_le_bytes([
                    tr.buf[0], tr.buf[1], tr.buf[2], tr.buf[3],
                ]) as usize;
                if hlen == 0 || hlen > 64 * 1024 {
                    return Err(format!("bad tree entry header length {}", hlen));
                }
                if tr.buf.len() < 4 + hlen {
                    return Ok(());
                }
                let meta: PutMeta = match serde_json::from_slice(&tr.buf[4..4 + hlen]) {
                    Ok(m) => m,
                    Err(e) => return Err(format!("bad tree entry header: {}", e)),
                };
                tr.buf.drain(..4 + hlen);
                tr.cur = Some(meta.clone());
                tr.cur_left = meta.size;
                tr.skipping = false;

                let abs = match safe_join(root, &meta.path) {
                    Some(a) => a,
                    None => {
                        tr.skipping = true;
                        tr.skipped.push(meta.path.clone());
                        continue;
                    }
                };

                if ignored_rel(&meta.path) {
                    tr.skipping = true;
                    tr.skipped.push(meta.path.clone());
                    continue;
                }

                let (winner, conflict) = sync.resolve_incoming(&meta.path, &abs, &meta.hash, meta.mtime_ms);
                if conflict && winner == "local" {
                    tr.skipping = true;
                    tr.skipped.push(meta.path.clone());
                    continue;
                }

                if let Err(e) = std::fs::create_dir_all(Path::new(&abs).parent().unwrap()) {
                    return Err(e.to_string());
                }

                let f = match std::fs::OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .write(true)
                    .mode(meta.mode)
                    .open(&abs)
                {
                    Ok(f) => f,
                    Err(e) => { let s: String = e.to_string(); return Err(s); }
                };
                tr.cur_file = Some(f);
                tr.cur_path = abs;
            }

            let n = {
                let buf_len = tr.buf.len() as i64;
                if buf_len > tr.cur_left { tr.cur_left } else { buf_len }
            };
            if n > 0 {
                if !tr.skipping {
                    if let Some(ref mut f) = tr.cur_file {
                        if let Err(e) = f.write_all(&tr.buf[..n as usize]) {
                            return Err(e.to_string());
                        }
                    }
                }
                tr.buf.drain(..n as usize);
                tr.cur_left -= n;
            }
            if tr.cur_left > 0 {
                return Ok(());
            }

            if !tr.skipping {
                let meta = tr.cur.clone().unwrap();
                if let Some(ref mut f) = tr.cur_file {
                    let _ = f.flush();
                    let _ = f.sync_all();
                }
                let path = tr.cur_path.clone();
                set_mtime(&path, meta.mtime_ms);
                sync.mark_synced(&meta.path, &meta.hash);
            }
            tr.cur = None;
            tr.cur_file = None;
        }
    }

    fn finish_tree(&self, seq: u32, tr: IncomingTree) {
        let buf_len = tr.buf.len();
        if buf_len > 0 || tr.cur.is_some() {
            self.abort_tree(seq, tr, &format!("truncated archive: {} trailing bytes", buf_len));
            return;
        }
        self.ack(seq, Some(serde_json::json!({"xfer": tr.xfer, "done": true, "skipped": tr.skipped})));
    }

    fn abort_tree(&self, seq: u32, tr: IncomingTree, msg: &str) {
        crate::slog!("sync-agent: tree xfer {} aborted: {}", tr.xfer, msg);
        if let Some(ref _f) = tr.cur_file {
            let _ = std::fs::remove_file(&tr.cur_path);
        }
        self.nak(seq, msg, Some(serde_json::json!({"xfer": tr.xfer})));
    }

    pub fn handle_del(&self, f: &Frame) {
        let req: serde_json::Value = match serde_json::from_slice(&f.payload) {
            Ok(m) => m,
            Err(_) => {
                self.nak(f.seq, "bad FILE_DEL json", None);
                return;
            }
        };
        let path = match req.get("path").and_then(|v| v.as_str()) {
            Some(p) => p.to_string(),
            None => {
                self.nak(f.seq, "bad FILE_DEL json", None);
                return;
            }
        };
        let root = self.inner.lock().unwrap().root.clone();
        let abs = match safe_join(&root, &path) {
            Some(a) => a,
            None => {
                self.nak(f.seq, "illegal path", None);
                return;
            }
        };
        if let Err(e) = std::fs::remove_file(&abs) {
            self.nak(f.seq, &e.to_string(), None);
            return;
        }
        {
            let inner = self.inner.lock().unwrap();
            inner.sync.mark_deleted(&path);
        }
        self.ack(f.seq, None);
    }

    pub fn handle_hello(&self, f: &Frame, data_plane: &Option<serde_json::Value>) {
        self.ack(f.seq, Some(serde_json::json!({"role": "guest"})));
        if let Some(dp) = data_plane {
            crate::slog!("sync-agent: data plane config: {}", dp);
        }
        let root = self.inner.lock().unwrap().root.clone();
        let sync = self.inner.lock().unwrap().sync.clone();
        if let Ok(m) = build_manifest(&root, &sync) {
            let fw = self.inner.lock().unwrap().fw.clone();
            for b in marshal_manifest_batches(&m) {
                let _ = fw.send(TYPE_MANIFEST, &b);
            }
        }
    }

    pub fn handle_ping(&self, f: &Frame) {
        self.ack(f.seq, None);
    }

    pub fn handle_manifest(&self, f: &Frame) {
        let root = self.inner.lock().unwrap().root.clone();
        let sync = self.inner.lock().unwrap().sync.clone();
        let m: Manifest = match serde_json::from_slice(&f.payload) {
            Ok(m) => m,
            Err(_) => {
                self.ack(f.seq, None);
                return;
            }
        };
        for (rel, meta) in &m.files {
            if let Some(abs) = safe_join(&root, rel) {
                if let Ok(h) = sync.hash_cached(rel, &abs) {
                    if h == meta.hash {
                        sync.mark_synced(rel, &h);
                    }
                }
            }
        }
        self.ack(f.seq, None);
    }
}

fn set_mtime(path: &str, mtime_ms: i64) {
    let sec = mtime_ms / 1000;
    let nsec = ((mtime_ms % 1000) * 1_000_000) as u32;
    let _ = filetime::set_file_mtime(path, filetime::FileTime::from_unix_time(sec, nsec));
}

pub struct Sender {
    root: String,
    fw: Arc<FrameWriter>,
    next_xfer: Arc<Mutex<u32>>,
    sync: Arc<SyncState>,
}

pub fn new_sender(root: &str, fw: Arc<FrameWriter>, sync: Arc<SyncState>, base: u32) -> Sender {
    Sender {
        root: root.to_string(),
        fw,
        next_xfer: Arc::new(Mutex::new(base)),
        sync,
    }
}

impl Sender {
    pub fn push_file(&self, rel: &str) -> io::Result<()> {
        crate::slog!("sync-agent: push_file({})", rel);
        crate::logging::diag(&format!("TX: push_file({}) start", rel));
        let abs = match safe_join(&self.root, rel) {
            Some(a) => a,
            None => return Err(io::Error::new(io::ErrorKind::InvalidInput, "illegal path")),
        };
        let info = match std::fs::metadata(&abs) {
            Ok(i) => i,
            Err(e) => return Err(e),
        };
        if !info.is_file() {
            return Ok(());
        }
        let hash = crate::manifest::hash_file(&abs).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        crate::slog!("sync-agent: push_file({}) size={} hash={}", rel, info.len(), &hash[..8]);

        let xfer;
        {
            let mut nx = self.next_xfer.lock().unwrap();
            *nx += 1;
            xfer = *nx;
        }

        let mode = info.permissions().mode() & 0o777;
        let mtime_ms = info.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;

        let meta = PutMeta {
            xfer,
            path: rel.to_string(),
            size: info.len() as i64,
            mode,
            mtime_ms,
            hash: hash.clone(),
        };
        let payload = serde_json::to_vec(&meta).unwrap();
        crate::slog!("sync-agent: push_file({}) sending FILE_PUT xfer={}", rel, xfer);
        crate::logging::diag(&format!("TX: FILE_PUT xfer={} size={}", xfer, meta.size));

        if info.len() == 0 {
            self.fw.send(TYPE_FILE_PUT, &payload)?;
            self.sync.mark_synced(rel, &hash);
            crate::logging::diag(&format!("TX: push_file({}) zero-size done", rel));
            return Ok(());
        }

        // Register xfer waiter BEFORE sending PUT so we don't miss the ready-ack
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        self.fw.register_xfer_waiter(xfer, ready_tx);

        self.fw.send(TYPE_FILE_PUT, &payload)?;

        // Wait for ready-ack from host
        match ready_rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok((resp_typ, resp_payload)) => {
                if resp_typ == TYPE_NAK {
                    let body: serde_json::Value = serde_json::from_slice(&resp_payload).unwrap_or_default();
                    let err = body.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
                    let conflict = body.get("conflict").and_then(|c| c.as_bool()).unwrap_or(false);
                    crate::slog!("sync-agent: push_file({}) NAK: {} conflict={}", rel, err, conflict);
                    crate::logging::diag(&format!("TX: push_file({}) NAK: {} conflict={}", rel, err, conflict));
                    return Err(io::Error::new(io::ErrorKind::Other, format!("NAK: {} conflict={}", err, conflict)));
                }
                crate::logging::diag(&format!("TX: push_file({}) ready-ack received", rel));
            }
            Err(e) => {
                crate::slog!("sync-agent: push_file({}) ready-ack timeout: {}", rel, e);
                crate::logging::diag(&format!("TX: push_file({}) ready-ack TIMEOUT", rel));
                return Err(io::Error::new(io::ErrorKind::TimedOut, format!("ready-ack timeout: {}", e)));
            }
        }

        // Stream chunks
        let mut src = std::fs::File::open(&abs)?;
        let mut buf = vec![0u8; crate::frame::CHUNK_SIZE];
        let mut offset: i64 = 0;
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            let mut chunk_payload = Vec::with_capacity(12 + n);
            chunk_payload.extend_from_slice(&xfer.to_le_bytes());
            chunk_payload.extend_from_slice(&(offset as u64).to_le_bytes());
            chunk_payload.extend_from_slice(&buf[..n]);

            self.fw.send(TYPE_FILE_CHUNK, &chunk_payload)?;
            crate::slog!("sync-agent: push_file({}) sent chunk offset={} len={}", rel, offset, n);
            offset += n as i64;
            if offset >= info.len() as i64 {
                break;
            }
        }
        crate::logging::diag(&format!("TX: push_file({}) all {} bytes sent", rel, offset));

        // Wait for done-ack from host (comes as ACK with xfer=xfer, done=true)
        // Re-register waiter for the done-ack
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        self.fw.register_xfer_waiter(xfer, done_tx);

        match done_rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok((resp_typ, resp_payload)) => {
                if resp_typ == TYPE_NAK {
                    let body: serde_json::Value = serde_json::from_slice(&resp_payload).unwrap_or_default();
                    let err = body.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
                    crate::slog!("sync-agent: push_file({}) done-NAK: {}", rel, err);
                    crate::logging::diag(&format!("TX: push_file({}) done-NAK: {}", rel, err));
                    return Err(io::Error::new(io::ErrorKind::Other, format!("done-NAK: {}", err)));
                }
                let body: serde_json::Value = serde_json::from_slice(&resp_payload).unwrap_or_default();
                let done = body.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
                if !done {
                    crate::logging::diag(&format!("TX: push_file({}) progress ack (not done), continuing", rel));
                    // Progress ack without done — host still processing. Re-register and wait again.
                    let (retry_tx, retry_rx) = std::sync::mpsc::channel();
                    self.fw.register_xfer_waiter(xfer, retry_tx);
                    match retry_rx.recv_timeout(std::time::Duration::from_secs(60)) {
                        Ok((resp_typ2, resp_payload2)) => {
                            if resp_typ2 == TYPE_NAK {
                                let body2: serde_json::Value = serde_json::from_slice(&resp_payload2).unwrap_or_default();
                                let err = body2.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
                                return Err(io::Error::new(io::ErrorKind::Other, format!("done-NAK: {}", err)));
                            }
                            let body2: serde_json::Value = serde_json::from_slice(&resp_payload2).unwrap_or_default();
                            let done2 = body2.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
                            crate::logging::diag(&format!("TX: push_file({}) final ack done={}", rel, done2));
                        }
                        Err(e) => {
                            crate::logging::diag(&format!("TX: push_file({}) done-ack TIMEOUT: {}", rel, e));
                            return Err(io::Error::new(io::ErrorKind::TimedOut, format!("done-ack timeout: {}", e)));
                        }
                    }
                }
                crate::logging::diag(&format!("TX: push_file({}) done-ack received", rel));
            }
            Err(e) => {
                crate::logging::diag(&format!("TX: push_file({}) done-ack TIMEOUT: {}", rel, e));
                return Err(io::Error::new(io::ErrorKind::TimedOut, format!("done-ack timeout: {}", e)));
            }
        }

        self.sync.mark_synced(rel, &hash);
        crate::slog!("sync-agent: push_file({}) done", rel);
        crate::logging::diag(&format!("TX: push_file({}) COMPLETE", rel));
        Ok(())
    }

    pub fn push_delete(&self, rel: &str) -> io::Result<()> {
        let payload = serde_json::to_vec(&serde_json::json!({"path": rel})).unwrap();
        self.fw.send(TYPE_FILE_DEL, &payload)?;
        self.sync.mark_deleted(rel);
        Ok(())
    }
}
