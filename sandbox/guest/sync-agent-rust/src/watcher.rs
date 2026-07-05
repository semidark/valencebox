
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::manifest::ignored_rel;

const IN_CLOSE_WRITE: u32 = 0x00000008;
const IN_CREATE: u32 = 0x00000100;
const IN_DELETE: u32 = 0x00000200;
const IN_MOVED_TO: u32 = 0x00000080;
const IN_MOVED_FROM: u32 = 0x00000040;
const IN_ISDIR: u32 = 0x40000000;

// IN_DELETE_SELF not supported on v86 kernel – omit to avoid EINVAL
const WATCH_MASK: u32 = IN_CLOSE_WRITE
    | IN_CREATE
    | IN_DELETE
    | IN_MOVED_TO
    | IN_MOVED_FROM;

const DEBOUNCE_MS: u64 = 100;

#[repr(C)]
struct InotifyEvent {
    wd: i32,
    mask: u32,
    cookie: u32,
    len: u32,
}

struct WatcherState {
    root: String,
    wds: HashMap<i32, String>,
}

pub struct WatchHandle {
    _thread: thread::JoinHandle<()>,
}

pub fn new_watcher(
    root: &str,
    tx: mpsc::Sender<HashMap<String, String>>,
) -> io::Result<WatchHandle> {
    let fd = unsafe { libc::inotify_init1(0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let mut state = WatcherState {
        root: root.to_string(),
        wds: HashMap::new(),
    };

    watch_tree(root, fd, &mut state)?;
    crate::slog!("sync-agent: watch_tree done, {} watches", state.wds.len());

    let state = Arc::new(Mutex::new(state));
    let tx = Arc::new(tx);

    let state_clone = state.clone();
    let tx_clone = tx.clone();

    Ok(WatchHandle {
        _thread: thread::spawn(move || {
            crate::slog!("sync-agent: watcher loop started");
            crate::logging::diag("W: watcher loop started");
            watcher_loop(fd, &state_clone, &tx_clone);
            unsafe { libc::close(fd); }
            crate::logging::diag("W: watcher loop exited");
        }),
    })
}

fn watch_tree(
    dir: &str,
    fd: i32,
    state: &mut WatcherState,
) -> io::Result<()> {
    // Watch the root directory itself so events on files directly in root are caught
    {
        let c_dir = std::ffi::CString::new(dir).unwrap();
        let wd = unsafe { libc::inotify_add_watch(fd, c_dir.as_ptr(), WATCH_MASK) };
        if wd >= 0 {
            state.wds.insert(wd, dir.to_string());
        }
    }
    let mut stack = vec![dir.to_string()];
    let mut walked = 0;
    while let Some(current) = stack.pop() {
        walked += 1;
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(e) => {
                crate::slog!("sync-agent: read_dir {} failed: {}", current, e);
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let rel = match path.strip_prefix(&state.root) {
                Ok(r) => r.to_string_lossy().to_string(),
                Err(_) => continue,
            };
            if rel != "." && ignored_rel(&rel) {
                continue;
            }
            let path_str = path.to_string_lossy().to_string();
            let c_path = match std::ffi::CString::new(path_str.as_str()) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let wd = unsafe { libc::inotify_add_watch(fd, c_path.as_ptr(), WATCH_MASK) };
            if wd >= 0 {
                state.wds.insert(wd, path_str.clone());
            }
            stack.push(path_str);
        }
    }
    crate::slog!("sync-agent: walk processed {} dirs", walked);
    Ok(())
}

fn parse_events(buf: &[u8]) -> Vec<(i32, u32, String)> {
    let mut events = Vec::new();
    let mut off = 0;
    while off + std::mem::size_of::<InotifyEvent>() <= buf.len() {
        let event = unsafe {
            &*(buf.as_ptr().add(off) as *const InotifyEvent)
        };
        let name = if event.len > 0 {
            let name_start = off + std::mem::size_of::<InotifyEvent>();
            let name_len = event.len as usize;
            std::str::from_utf8(&buf[name_start..name_start + name_len])
                .unwrap_or("")
                .to_string()
                .trim_end_matches('\0')
                .to_string()
        } else {
            String::new()
        };
        events.push((event.wd, event.mask, name));
        off += std::mem::size_of::<InotifyEvent>() + event.len as usize;
    }
    events
}

fn watcher_loop(fd: i32, state: &Arc<Mutex<WatcherState>>, tx: &Arc<mpsc::Sender<HashMap<String, String>>>) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut pending: HashMap<String, String> = HashMap::new();
    let mut debounce_start: Option<Instant> = None;

    // Clear diag file at start
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open("/tmp/watch.log") {
            let _ = writeln!(f, "W: watcher_loop started");
            let _ = f.flush();
        }
    }

    loop {
        // Calculate poll timeout: block until debounce fires or data arrives
        let timeout_ms = match debounce_start {
            Some(start) => {
                let elapsed = start.elapsed().as_millis() as u64;
                if elapsed >= DEBOUNCE_MS {
                    // Debounce expired — poll with 1ms to check for data, then flush
                    1
                } else {
                    // Wait until debounce expires, but not more than 100ms per poll
                    let remaining = (DEBOUNCE_MS - elapsed) as i32;
                    if remaining > 100 { 100 } else { remaining }
                }
            }
            None => -1, // Block indefinitely until data arrives
        };

        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ret = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
        if ret < 0 {
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                crate::logging::diag(&format!("W: poll error: {}", err));
                break;
            }
            continue;
        }

       // Check if we should flush (debounce expired and we have pending ops)
        let should_flush = debounce_start.is_some() && debounce_start.unwrap().elapsed() >= Duration::from_millis(DEBOUNCE_MS) && !pending.is_empty();
        if should_flush {
            let ops = std::mem::take(&mut pending);
            let op_list: Vec<String> = ops.keys().cloned().collect();
            crate::logging::diag(&format!("W: FLUSH {} ops: {:?}", ops.len(), op_list));
            crate::slog!("sync-agent: FLUSH {} ops", ops.len());
            if tx.send(ops).is_err() {
                crate::logging::diag("W: tx.send failed, breaking");
                break;
            }
            debounce_start = None;
        }

        if ret == 0 {
            continue;
        }

        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::WouldBlock {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            crate::slog!("sync-agent: inotify read error: {}", err);
            break;
        }

        let events = parse_events(&buf[..n as usize]);
        crate::logging::diag(&format!("W: read {} events, {} bytes", events.len(), n));
        let mut st = state.lock().unwrap();
        for (wd, mask, name) in events {
            if name.is_empty() || name == ".sync-tmp" {
                continue;
            }
            let dir = match st.wds.get(&wd) {
                Some(d) => d.clone(),
                None => {
                    crate::slog!("sync-agent: unknown wd {}", wd);
                    continue;
                }
            };
            let abs = format!("{}/{}", dir, name);
            let rel = match Path::new(&abs).strip_prefix(&st.root) {
                Ok(r) => r.to_string_lossy().to_string(),
                Err(_) => continue,
            };
            if ignored_rel(&rel) {
                continue;
            }

            let is_dir = mask & IN_ISDIR != 0;
            crate::logging::diag(&format!("W: event wd={} mask=0x{:x} name={} rel={} is_dir={}", wd, mask, name, rel, is_dir));
            if name == "from-guest.txt" {
                crate::logging::diag(&format!("W: *** TARGET HIT *** wd={} mask=0x{:x} dir={} rel={}", wd, mask, dir, rel));
            }

            if is_dir && (mask & (IN_CREATE | IN_MOVED_TO) != 0) {
                crate::logging::diag(&format!("W: new dir {}, calling watch_tree", abs));
                crate::slog!("sync-agent: new dir {}, calling watch_tree", abs);
                drop(st);
                if let Ok(mut s) = state.lock() {
                    let _ = watch_tree(&abs, fd, &mut s);
                }
                if let Ok(_entries) = std::fs::read_dir(&abs) {
                    let root_str = state.lock().unwrap().root.clone();
                    let mut walk_stack = vec![abs.clone()];
                    while let Some(d) = walk_stack.pop() {
                        if let Ok(sub) = std::fs::read_dir(&d) {
                            for e in sub {
                                if let Ok(e) = e {
                                    let p = e.path();
                                    if p.is_dir() {
                                        walk_stack.push(p.to_string_lossy().to_string());
                                    } else if p.is_file() {
                                        if let Ok(r) = p.strip_prefix(&root_str) {
                                            let rel_str = r.to_string_lossy().to_string();
                                            if !ignored_rel(&rel_str) {
                                                pending.insert(rel_str, "put".to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                st = state.lock().unwrap();
                debounce_start = Some(Instant::now());
            } else if is_dir && (mask & (IN_DELETE | IN_MOVED_FROM) != 0) {
                // crate::slog!("sync-agent: watcher event DEL dir {}", rel);
                pending.insert(rel, "del".to_string());
                debounce_start = Some(Instant::now());
            } else if mask & (IN_CLOSE_WRITE | IN_MOVED_TO) != 0 {
                crate::logging::diag(&format!("W: PUT {} (dir={}, wd={})", rel, dir, wd));
                pending.insert(rel, "put".to_string());
                debounce_start = Some(Instant::now());
            } else if mask & (IN_DELETE | IN_MOVED_FROM) != 0 {
                // crate::slog!("sync-agent: watcher event DEL {}", rel);
                pending.insert(rel, "del".to_string());
                debounce_start = Some(Instant::now());
            }
        }
    }
}
