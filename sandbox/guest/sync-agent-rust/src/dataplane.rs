
use std::io::BufReader;
use std::net::TcpStream;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use crate::frame::{self, FrameWriter, TYPE_ACK, TYPE_HELLO, TYPE_NAK, TYPE_PING};
use crate::state::SyncState;
use crate::transfer::{new_receiver, new_sender};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct DataPlaneCfg {
    pub ip: String,
    pub port: i32,
    pub token: String,
}

struct DataPlaneInner {
    root: String,
    ss: Arc<SyncState>,
    cfg: Option<DataPlaneCfg>,
    gen: i32,
    sender: Option<Arc<crate::transfer::Sender>>,
}

pub struct DataPlane {
    inner: Arc<Mutex<DataPlaneInner>>,
}

impl DataPlane {
    pub fn new(root: &str, ss: Arc<SyncState>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DataPlaneInner {
                root: root.to_string(),
                ss,
                cfg: None,
                gen: 0,
                sender: None,
            })),
        }
    }

    pub fn update(&self, cfg: DataPlaneCfg) {
        let mut inner = self.inner.lock().unwrap();
        if inner.cfg.as_ref() == Some(&cfg) {
            return;
        }
        inner.cfg = Some(cfg.clone());
        inner.gen += 1;
        let gen = inner.gen;
        drop(inner);

        crate::slog!("data plane: advert {}:{} (gen {})", cfg.ip, cfg.port, gen);

        let inner_clone = self.inner.clone();
        thread::spawn(move || {
            dp_dial_loop(cfg, gen, inner_clone);
        });
    }

    #[allow(dead_code)]
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.gen += 1;
        inner.sender = None;
    }

    pub fn sender(&self) -> Option<Arc<crate::transfer::Sender>> {
        let inner = self.inner.lock().unwrap();
        inner.sender.clone()
    }

    #[allow(dead_code)]
    fn is_stale(&self, gen: i32) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.gen != gen
    }
}

fn dp_dial_loop(cfg: DataPlaneCfg, gen: i32, inner: Arc<Mutex<DataPlaneInner>>) {
    let addr = format!("{}:{}", cfg.ip, cfg.port);
    loop {
        {
            let inn = inner.lock().unwrap();
            if inn.gen != gen {
                return;
            }
        }
        let conn = match TcpStream::connect_timeout(&addr.parse().unwrap(), std::time::Duration::from_secs(5)) {
            Ok(c) => c,
            Err(e) => {
                crate::slog!("data plane: dial {} failed: {}", addr, e);
                thread::sleep(std::time::Duration::from_secs(2));
                continue;
            }
        };

        {
            let inn = inner.lock().unwrap();
            if inn.gen != gen {
                conn.shutdown(std::net::Shutdown::Both).ok();
                return;
            }
        }

        dp_session(conn, cfg.clone(), gen, inner.clone());
        thread::sleep(std::time::Duration::from_secs(1));
    }
}

fn dp_session(conn: TcpStream, cfg: DataPlaneCfg, gen: i32, inner: Arc<Mutex<DataPlaneInner>>) {
    conn.set_nodelay(true).ok();
    let root;
    let ss: Arc<SyncState>;
    {
        let inn = inner.lock().unwrap();
        root = inn.root.clone();
        ss = inn.ss.clone();
    }

    let fw = Arc::new(FrameWriter::new(Box::new(conn.try_clone().unwrap())));

    let hello = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "role": "guest",
        "channel": "data",
        "token": cfg.token,
        "root": root,
    })).unwrap();
    if fw.send(TYPE_HELLO, &hello).is_err() {
        return;
    }

    let recv = Arc::new(new_receiver(&root, fw.clone(), ss.clone(), false));
    let send = Arc::new(new_sender(&root, fw.clone(), ss.clone(), 0x40000000));

    {
        let mut inn = inner.lock().unwrap();
        inn.sender = Some(send.clone());
    }

    crate::slog!("data plane: connected to {}:{:?}", cfg.ip, cfg.port);

    let last_rx_ts = Arc::new(AtomicI64::new(Instant::now().elapsed().as_millis() as i64));
    let last_rx_clone = last_rx_ts.clone();
    let fw_ping = fw.clone();
    let conn_for_close = conn.try_clone().unwrap();

    let _ping_handle = thread::spawn(move || {
        let start = Instant::now();
        loop {
            thread::sleep(std::time::Duration::from_secs(15));
            let _ = fw_ping.send(TYPE_PING, &[]);
            let elapsed = start.elapsed().as_millis() as i64;
            let last = last_rx_clone.load(Ordering::SeqCst);
            if elapsed - last > 45000 {
                crate::slog!("data plane: no traffic for 45s — reconnecting");
                conn_for_close.shutdown(std::net::Shutdown::Both).ok();
                return;
            }
        }
    });

    let mut reader = BufReader::with_capacity(256 * 1024, conn.try_clone().unwrap());
    loop {
        {
            let inn = inner.lock().unwrap();
            if inn.gen != gen {
                return;
            }
        }
        let f = match frame::read_frame(&mut reader) {
            Ok(f) => f,
            Err(e) => {
                crate::slog!("data plane: session ended: {}", e);
                return;
            }
        };
        last_rx_ts.store(Instant::now().elapsed().as_millis() as i64, Ordering::SeqCst);

        match f.typ {
            TYPE_ACK | TYPE_NAK => {
                // non-xfer acks need nothing
            }
            crate::frame::TYPE_FILE_PUT => {
                recv.handle_put(&f);
            }
            crate::frame::TYPE_TREE_PUT => {
                recv.handle_tree_put(&f);
            }
            crate::frame::TYPE_FILE_CHUNK => {
                recv.handle_chunk(&f);
            }
            crate::frame::TYPE_FILE_DEL => {
                recv.handle_del(&f);
            }
            TYPE_PING => {
                let ack_payload = serde_json::to_vec(&serde_json::json!({"ack": f.seq})).unwrap();
                let _ = fw.send(TYPE_ACK, &ack_payload);
            }
            crate::frame::TYPE_MANIFEST => {
                let ack_payload = serde_json::to_vec(&serde_json::json!({"ack": f.seq})).unwrap();
                let _ = fw.send(TYPE_ACK, &ack_payload);
            }
            _ => {
                crate::slog!("data plane: unknown frame type {}", f.typ);
            }
        }
    }
}
