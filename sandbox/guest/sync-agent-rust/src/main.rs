mod dataplane;
mod frame;
mod manifest;
mod state;
mod termios;
mod transfer;
mod watcher;

use std::collections::HashMap;
use std::io::BufReader;
use std::sync::mpsc;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut root = "/workspace".to_string();
    let mut dev = "/dev/hvc0".to_string();
    for arg in &args[1..] {
        if arg.starts_with("--root=") {
            root = arg[7..].to_string();
        } else if arg.starts_with("--dev=") {
            dev = arg[6..].to_string();
        }
    }

    loop {
        if let Err(e) = run(&root, &dev) {
            eprintln!("sync-agent: session ended: {} — reopening in 2s", e);
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
        eprintln!("sync-agent: warning: could not set {} raw: {}", dev, e);
    }

    let fw = Arc::new(frame::FrameWriter::new(Box::new(f.try_clone()?)));
    let sync = Arc::new(state::SyncState::new());
    let recv = Arc::new(transfer::new_receiver(root, fw.clone(), sync.clone(), true));
    let send = Arc::new(transfer::new_sender(root, fw.clone(), sync.clone(), 0));
    let dplane = Arc::new(dataplane::DataPlane::new(root, sync.clone()));

    let hello = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "role": "guest",
        "root": root,
    })).unwrap();
    fw.send(frame::TYPE_HELLO, &hello)?;

    let push_dplane = dplane.clone();
    let push_send = send.clone();
    let push_via = Arc::new(move |op: &dyn Fn(&transfer::Sender) -> std::io::Result<()>| -> std::io::Result<()> {
        if let Some(ds) = push_dplane.sender() {
            if op(&ds).is_ok() {
                return Ok(());
            } else {
                eprintln!("sync-agent: data-plane push failed, retrying over console");
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
                            eprintln!("sync-agent: push {}: {}", rel, e);
                        }
                    }
                    "del" => {
                        let rel_copy = rel.clone();
                        if let Err(e) = push_via_clone(&|s| s.push_delete(&rel_copy)) {
                            eprintln!("sync-agent: push del {}: {}", rel, e);
                        }
                    }
                    _ => {}
                }
            }
        }
    });

    match watcher::new_watcher(root, push_tx) {
        Ok(_handle) => {
            eprintln!("sync-agent: inotify watcher started");
        }
        Err(e) => {
            eprintln!("sync-agent: inotify unavailable: {}", e);
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
                if !handle_ack_transfer(&frame_data, &send) {
                    if let Some(cfg) = parse_dp_cfg(&frame_data.payload) {
                        dplane.update(cfg);
                    }
                }
            }
            frame::TYPE_EVENT => {
                eprintln!("sync-agent: event from host: {}", String::from_utf8_lossy(&frame_data.payload));
            }
            _ => {
                eprintln!("sync-agent: unknown frame type {}", frame_data.typ);
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

fn handle_ack_transfer(_f: &frame::Frame, _send: &transfer::Sender) -> bool {
    false
}
