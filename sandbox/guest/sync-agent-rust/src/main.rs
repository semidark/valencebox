mod dataplane;
mod frame;
mod logging;
mod manifest;
mod pty;
mod state;
mod termios;
mod transfer;
mod watcher;

use std::io::BufReader;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

fn parse_args(args: &[String]) -> (String, String) {
    let mut root = "/workspace".to_string();
    let mut dev = "/dev/hvc0".to_string();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg.starts_with("--root=") {
            root = arg[7..].to_string();
        } else if arg == "-root" && i + 1 < args.len() {
            root = args[i + 1].clone();
            i += 1;
        } else if arg.starts_with("--dev=") {
            dev = arg[6..].to_string();
        } else if arg == "-dev" && i + 1 < args.len() {
            dev = args[i + 1].clone();
            i += 1;
        }
        i += 1;
    }
    (root, dev)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (root, dev) = parse_args(&args[1..]);

    loop {
        if let Err(e) = run(&root, &dev) {
            crate::slog!("sync-agent: session ended: {} — reopening in 2s", e);
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }
}

fn run(root: &str, dev: &str) -> std::io::Result<()> {
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dev)?;
    if let Err(e) = termios::set_raw(f.try_clone()?) {
        crate::slog!("sync-agent: warning: could not set {} raw: {}", dev, e);
    }

    let fw = Arc::new(frame::FrameWriter::new(Box::new(f.try_clone()?)));
    let sync = Arc::new(state::SyncState::new());
    sync.set_fw(fw.clone());
    let recv = Arc::new(transfer::new_receiver(root, fw.clone(), sync.clone(), true));
    let send = Arc::new(transfer::new_sender(root, fw.clone(), sync.clone(), 0));
    let dplane = Arc::new(dataplane::DataPlane::new(root, sync.clone()));
    let pty_session: Arc<Mutex<Option<pty::PtySession>>> = Arc::new(Mutex::new(None));

    let hello = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "role": "guest",
        "root": root,
    })).unwrap();
    let hello_seq = fw.send(frame::TYPE_HELLO, &hello)?;

    // Retransmit HELLO until host ACKs (up to 30 tries × 2s = 60s)
    {
        use std::os::unix::io::AsRawFd;
        let fd = f.as_raw_fd();
        let mut pollfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let mut reader = BufReader::new(f.try_clone()?);
        let mut acked = false;
        for _ in 0..30 {
            let rc = unsafe { libc::poll(&mut pollfd, 1, 2000) };
            if rc < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if rc == 0 {
                // Timeout — resend HELLO
                fw.send(frame::TYPE_HELLO, &hello)?;
                continue;
            }
            // Read frames until we find our HELLO ACK or run out of data
            loop {
                let fr = match frame::read_frame(&mut reader) {
                    Ok(f) => f,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) => return Err(e),
                };
                if fr.typ == frame::TYPE_ACK {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&fr.payload) {
                        if let Some(ack) = v.get("ack").and_then(|a| a.as_u64()) {
                            if ack as u32 == hello_seq {
                                if let Some(cfg) = parse_dp_cfg(&fr.payload) {
                                    dplane.update(cfg);
                                }
                                acked = true;
                                break;
                            }
                        }
                    }
                }
            }
            if acked { break; }
        }
        if !acked {
            crate::slog!("sync-agent: HELLO handshake timeout");
        }
    }

    let push_dplane = dplane.clone();
    let push_send = send.clone();
    let push_via = Arc::new(move |op: &dyn Fn(&transfer::Sender) -> std::io::Result<()>| -> std::io::Result<()> {
        if let Some(ds) = push_dplane.sender() {
            if op(&ds).is_ok() {
                return Ok(());
            } else {
                crate::slog!("sync-agent: data-plane push failed, retrying over console");
            }
        }
        op(&push_send)
    });

    let (push_tx, push_rx) = mpsc::channel::<Vec<watcher::WatchOp>>();
    let push_root = root.to_string();
    let push_sync = sync.clone();
    let push_via_clone = push_via.clone();
    let _push_handle = std::thread::spawn(move || {
        while let Ok(ops) = push_rx.recv() {
            let ops = coalesce_watch_ops(ops, &push_sync);
            for op in &ops {
                match op {
                    watcher::WatchOp::Put(rel) => {
                        let abs = match manifest::safe_join(&push_root, rel) {
                            Some(a) => a,
                            None => continue,
                        };
                        if push_sync.is_echo(rel, &abs) {
                            continue;
                        }
                        let rel_copy = rel.clone();
                        if let Err(e) = push_via_clone(&|s| s.push_file(&rel_copy)) {
                            crate::slog!("sync-agent: push {}: {}", rel, e);
                        }
                    }
                    watcher::WatchOp::Del(rel) => {
                        if manifest::safe_join(&push_root, rel).is_none() {
                            continue;
                        }
                        let rel_copy = rel.clone();
                        if let Err(e) = push_via_clone(&|s| s.push_delete(&rel_copy)) {
                            crate::slog!("sync-agent: push del {}: {}", rel, e);
                        }
                    }
                    watcher::WatchOp::Rename { old, new } => {
                        if manifest::safe_join(&push_root, old).is_none() {
                            continue;
                        }
                        let old_copy = old.clone();
                        let new_copy = new.clone();
                        if let Err(e) = push_via_clone(&|s| s.push_rename(&old_copy, &new_copy)) {
                            crate::slog!("sync-agent: push rename {} -> {}: {}", old, new, e);
                        }
                    }
                }
            }
        }
    });

    // Wait for workspace to be mounted (up to 5s)
    for _ in 0..50 {
        if std::path::Path::new(root).is_dir() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    match watcher::new_watcher(root, push_tx) {
        Ok(_handle) => {
            crate::slog!("sync-agent: inotify watcher started");
        }
        Err(e) => {
            crate::slog!("sync-agent: inotify unavailable: {}", e);
        }
    }

    let reader = BufReader::with_capacity(256 * 1024, f);
    let mut r = reader;
    loop {
        let frame_data = frame::read_frame(&mut r)?;
        match frame_data.typ {
            frame::TYPE_HELLO => {
                let hello_val: Option<serde_json::Value> = serde_json::from_slice(&frame_data.payload).ok();
                recv.handle_hello(&frame_data, &hello_val);
                if let Some(cfg) = parse_dp_cfg(&frame_data.payload) {
                    dplane.update(cfg);
                }
            }
            frame::TYPE_PING => {
                recv.handle_ping(&frame_data);
            }
            frame::TYPE_MANIFEST => {
                recv.handle_manifest(&frame_data);
            }
            frame::TYPE_FILE_PUT => {
                recv.handle_put(&frame_data);
            }
            frame::TYPE_TREE_PUT => {
                recv.handle_tree_put(&frame_data);
            }
            frame::TYPE_FILE_CHUNK => {
                recv.handle_chunk(&frame_data);
            }
            frame::TYPE_FILE_DEL => {
                recv.handle_del(&frame_data);
            }
            frame::TYPE_ACK | frame::TYPE_NAK => {
                // handle_ack_transfer must run first: routes progress ACKs to
                // Sender.handle_ack (window drain) and ready/done/NAK ACKs to
                // xfer waiters.  fw.complete_xfer runs second (fallback for
                // waiters not managed by Sender, e.g. dataplane).
                // Order matters: if complete_xfer runs first it catches
                // progress ACKs and routes them into push_file's ack_rx
                // channel, starving the window semaphore.
                if !handle_ack_transfer(&frame_data, &send) {
                    let ack_body = serde_json::from_slice::<serde_json::Value>(&frame_data.payload).ok();
                    // data-plane sender fallback (if any)
                    let xfer_id = ack_body
                        .as_ref()
                        .and_then(|v| v.get("xfer").and_then(|x| x.as_u64()))
                        .map(|x| x as u32);
                    let consumed = xfer_id
                        .map(|x| fw.complete_xfer(x, frame_data.typ, &frame_data.payload))
                        .unwrap_or(false);
                    if !consumed {
                        let ack_seq = ack_body
                            .as_ref()
                            .and_then(|v| v.get("ack").and_then(|a| a.as_u64()))
                            .map(|x| x as u32);
                        let request_consumed = ack_seq
                            .map(|seq| fw.complete_request(seq, frame_data.typ, &frame_data.payload))
                            .unwrap_or(false);
                        if !request_consumed {
                            if let Some(cfg) = parse_dp_cfg(&frame_data.payload) {
                                dplane.update(cfg);
                            }
                        }
                    }
                }
            }
            frame::TYPE_PTY_OPEN => {
                let req: serde_json::Value =
                    serde_json::from_slice(&frame_data.payload).unwrap_or_default();
                let rows = req.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
                let cols = req.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                match pty::PtySession::open(rows, cols, fw.clone()) {
                    Ok(session) => {
                        *pty_session.lock().unwrap() = Some(session);
                        let ack = serde_json::json!({"ack": frame_data.seq});
                        let _ = fw.send(frame::TYPE_ACK, ack.to_string().as_bytes());
                    }
                    Err(e) => {
                        crate::slog!("pty: open failed: {}", e);
                        let nack = serde_json::json!({"ack": frame_data.seq, "error": format!("{e}")});
                        let _ = fw.send(frame::TYPE_NAK, nack.to_string().as_bytes());
                    }
                }
            }
            frame::TYPE_PTY_DATA => {
                if let Some(session) = pty_session.lock().unwrap().as_ref() {
                    if let Err(e) = session.write(&frame_data.payload) {
                        crate::slog!("pty: write failed: {}", e);
                    }
                }
            }
            frame::TYPE_PTY_RESIZE => {
                let req: serde_json::Value =
                    serde_json::from_slice(&frame_data.payload).unwrap_or_default();
                let rows = req.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
                let cols = req.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
                if let Some(session) = pty_session.lock().unwrap().as_ref() {
                    if let Err(e) = session.resize(rows, cols) {
                        crate::slog!("pty: resize failed: {}", e);
                    }
                }
            }
            frame::TYPE_PTY_CLOSE => {
                if pty_session.lock().unwrap().take().is_some() {
                    crate::slog!("pty: session closed by host");
                }
            }
            frame::TYPE_EVENT => {
                crate::slog!("sync-agent: host event: {:?}", frame_data.payload);
            }
            _ => {
                crate::slog!("sync-agent: unknown frame type {}", frame_data.typ);
            }
        }
    }
}

fn parse_dp_cfg(payload: &[u8]) -> Option<dataplane::DataPlaneCfg> {
    let val: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let dp = val.get("dataPlane")?;
    let ip = dp.get("ip")?.as_str()?.to_string();
    let port = dp.get("port")?.as_i64()? as i32;
    let token = dp.get("token")?.as_str()?.to_string();
    Some(dataplane::DataPlaneCfg { ip, port, token })
}

fn map_prefix(rel: &str, old_root: &str, new_root: &str) -> String {
    if rel == old_root {
        new_root.to_string()
    } else {
        new_root.to_string() + &rel[old_root.len()..]
    }
}

fn rewrite_watch_op(op: &mut watcher::WatchOp, old_root: &str, new_root: &str) {
    let old_prefix = format!("{}/", old_root);
    match op {
        watcher::WatchOp::Put(rel) | watcher::WatchOp::Del(rel) => {
            if rel == old_root || rel.starts_with(&old_prefix) {
                *rel = map_prefix(rel, old_root, new_root);
            }
        }
        watcher::WatchOp::Rename { old, new } => {
            if old == old_root || old.starts_with(&old_prefix) {
                *old = map_prefix(old, old_root, new_root);
            }
            if new == old_root || new.starts_with(&old_prefix) {
                *new = map_prefix(new, old_root, new_root);
            }
        }
    }
}

fn coalesce_watch_ops(mut ops: Vec<watcher::WatchOp>, sync: &state::SyncState) -> Vec<watcher::WatchOp> {
    let mut out: Vec<watcher::WatchOp> = Vec::new();
    for op in ops.drain(..) {
        match op {
            watcher::WatchOp::Rename { old, new } if !sync.has_prefix(&old) => {
                // The old path was never synced, so the host does not know it.
                // Rewrite any earlier ops in this batch from old prefix to new
                // prefix and drop the rename itself.
                for existing in &mut out {
                    rewrite_watch_op(existing, &old, &new);
                }
            }
            other => out.push(other),
        }
    }
    out
}

fn handle_ack_transfer(f: &frame::Frame, send: &transfer::Sender) -> bool {
    send.handle_ack(f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::SyncState;
    use crate::watcher::WatchOp;

    #[test]
    fn flag_parsing_long_form() {
        let args = vec!["--root=/custom".to_string(), "--dev=/dev/tty0".to_string()];
        let (root, dev) = parse_args(&args);
        assert_eq!(root, "/custom");
        assert_eq!(dev, "/dev/tty0");
    }

    #[test]
    fn flag_parsing_short_form() {
        let args = vec!["-root".to_string(), "/alt".to_string(), "-dev".to_string(), "/dev/tty1".to_string()];
        let (root, dev) = parse_args(&args);
        assert_eq!(root, "/alt");
        assert_eq!(dev, "/dev/tty1");
    }

    #[test]
    fn flag_parsing_defaults() {
        let args: Vec<String> = vec![];
        let (root, dev) = parse_args(&args);
        assert_eq!(root, "/workspace");
        assert_eq!(dev, "/dev/hvc0");
    }

    #[test]
    fn flag_parsing_short_form_missing_value() {
        let args = vec!["-root".to_string()];
        let (root, dev) = parse_args(&args);
        assert_eq!(root, "/workspace"); // defaults preserved when -root has no value
        assert_eq!(dev, "/dev/hvc0");
    }

    #[test]
    fn flag_parsing_mixed() {
        let args = vec!["--root=/custom".to_string(), "-dev".to_string(), "/dev/tty2".to_string()];
        let (root, dev) = parse_args(&args);
        assert_eq!(root, "/custom");
        assert_eq!(dev, "/dev/tty2");
    }

    #[test]
    fn coalesce_unsynced_file_rename_rewrites_put() {
        let sync = SyncState::new();
        let ops = vec![
            WatchOp::Put("old.txt".to_string()),
            WatchOp::Rename { old: "old.txt".to_string(), new: "new.txt".to_string() },
        ];
        let out = coalesce_watch_ops(ops, &sync);
        assert_eq!(out.len(), 1);
        match &out[0] {
            WatchOp::Put(rel) => assert_eq!(rel, "new.txt"),
            other => panic!("expected Put(new.txt), got {:?}", other),
        }
    }

    #[test]
    fn coalesce_synced_file_rename_keeps_rename() {
        let sync = SyncState::new();
        sync.mark_synced("old.txt", "abc");
        let ops = vec![
            WatchOp::Put("old.txt".to_string()),
            WatchOp::Rename { old: "old.txt".to_string(), new: "new.txt".to_string() },
        ];
        let out = coalesce_watch_ops(ops, &sync);
        assert_eq!(out.len(), 2);
        match &out[0] {
            WatchOp::Put(rel) => assert_eq!(rel, "old.txt"),
            other => panic!("expected Put(old.txt), got {:?}", other),
        }
        match &out[1] {
            WatchOp::Rename { old, new } => {
                assert_eq!(old, "old.txt");
                assert_eq!(new, "new.txt");
            }
            other => panic!("expected Rename(old.txt->new.txt), got {:?}", other),
        }
    }

    #[test]
    fn coalesce_unsynced_dir_rename_rewrites_subtree_puts() {
        let sync = SyncState::new();
        let ops = vec![
            WatchOp::Put("old/sub/a.txt".to_string()),
            WatchOp::Put("old/b.txt".to_string()),
            WatchOp::Rename { old: "old".to_string(), new: "new".to_string() },
        ];
        let out = coalesce_watch_ops(ops, &sync);
        assert_eq!(out.len(), 2);
        match &out[0] {
            WatchOp::Put(rel) => assert_eq!(rel, "new/sub/a.txt"),
            other => panic!("expected Put(new/sub/a.txt), got {:?}", other),
        }
        match &out[1] {
            WatchOp::Put(rel) => assert_eq!(rel, "new/b.txt"),
            other => panic!("expected Put(new/b.txt), got {:?}", other),
        }
    }
}
