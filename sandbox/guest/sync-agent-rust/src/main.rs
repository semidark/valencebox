mod frame;
mod manifest;
mod state;
mod termios;

use std::io::BufReader;

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

    let f = f;
    let reader = BufReader::with_capacity(256 * 1024, &f);
    let fw = frame::FrameWriter::new(Box::new(f.try_clone()?));
    let hello = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "role": "guest",
        "root": root,
    })).unwrap();
    fw.send(frame::TYPE_HELLO, &hello)?;

    let mut r = reader;
    loop {
        let frame = frame::read_frame(&mut r)?;
        eprintln!(
            "sync-agent: frame type={} seq={} payload_len={}",
            frame.typ,
            frame.seq,
            frame.payload.len()
        );
    }
}
