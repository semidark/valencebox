mod dataplane;
mod frame;
mod logging;
mod manifest;
mod state;
mod termios;
mod transfer;
mod watcher;

use std::collections::HashMap;
use std::io::BufReader;
use std::sync::mpsc;
use std::sync::Arc;

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

    let (push_tx, push_rx) = mpsc::channel::<HashMap<String, String>>();
    let push_root = root.to_string();
    let push_sync = sync.clone();
    let push_via_clone = push_via.clone();
    let _push_handle = std::thread::spawn(move || {
        while let Ok(ops) = push_rx.recv() {
            for (rel, op_str) in &ops {
                if manifest::safe_join(&push_root, rel).is_none() {
                    continue;
                }
                let abs = manifest::safe_join(&push_root, rel).unwrap();
                match op_str.as_str() {
                    "put" => {
                        if push_sync.is_echo(rel, &abs) {
                            continue;
                        }
                        let rel_copy = rel.clone();
                        if let Err(e) = push_via_clone(&|s| s.push_file(&rel_copy)) {
                            crate::slog!("sync-agent: push {}: {}", rel, e);
                        }
                    }
                    "del" => {
                        // forwarded even if never synced — the host no-ops on unknown paths
                        let rel_copy = rel.clone();
                        if let Err(e) = push_via_clone(&|s| s.push_delete(&rel_copy)) {
                            crate::slog!("sync-agent: push del {}: {}", rel, e);
                        }
                    }
                    _ => {}
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
                // Try xfer-based routing first (guest→host transfer ACKs)
                let xfer_id = serde_json::from_slice::<serde_json::Value>(&frame_data.payload)
                    .ok()
                    .and_then(|v| v.get("xfer").and_then(|x| x.as_u64()))
                    .map(|x| x as u32);
                let consumed = xfer_id
                    .map(|x| fw.complete_xfer(x, frame_data.typ, &frame_data.payload))
                    .unwrap_or(false);
                if !consumed {
                    if !fw.complete_request(frame_data.seq, frame_data.typ, &frame_data.payload) {
                        if !handle_ack_transfer(&frame_data, &send) {
                            if let Some(cfg) = parse_dp_cfg(&frame_data.payload) {
                                dplane.update(cfg);
                            }
                        }
                    }
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

fn handle_ack_transfer(f: &frame::Frame, send: &transfer::Sender) -> bool {
    send.handle_ack(f)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
