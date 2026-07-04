mod frame;
mod manifest;
mod state;
mod termios;
mod transfer;
mod watcher;

use std::io::BufReader;
use std::sync::mpsc;

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

    let fw = frame::FrameWriter::new(Box::new(f.try_clone()?));
    let hello = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "role": "guest",
        "root": root,
    })).unwrap();
    fw.send(frame::TYPE_HELLO, &hello)?;

    let (tx, rx) = mpsc::channel();
    match watcher::new_watcher(root, tx) {
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
        if let Ok(ops) = rx.try_recv() {
            for (rel, op) in &ops {
                eprintln!("sync-agent: watcher event: {} {}", rel, op);
            }
        }
        let frame = frame::read_frame(&mut r)?;
        eprintln!(
            "sync-agent: frame type={} seq={} payload_len={}",
            frame.typ,
            frame.seq,
            frame.payload.len()
        );
    }
}
