
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

const DEBOUNCE_MS: u64 = 300;

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

    let state = Arc::new(Mutex::new(state));
    let tx = Arc::new(tx);

    let state_clone = state.clone();
    let tx_clone = tx.clone();

    Ok(WatchHandle {
        _thread: thread::spawn(move || {
            watcher_loop(fd, &state_clone, &tx_clone);
            unsafe { libc::close(fd); }
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
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
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
                break;
            }
            continue;
        }

        if ret > 0 {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::WouldBlock {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                eprintln!("sync-agent: inotify read error: {}", err);
                break;
            }

            let events = parse_events(&buf[..n as usize]);
            let mut st = state.lock().unwrap();
            for (wd, mask, name) in events {
                if name.is_empty() || name == ".sync-tmp" {
                    continue;
                }
                let dir = match st.wds.get(&wd) {
                    Some(d) => d.clone(),
                    None => continue,
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

                if is_dir && (mask & (IN_CREATE | IN_MOVED_TO) != 0) {
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
                    pending.insert(rel, "del".to_string());
                    debounce_start = Some(Instant::now());
                } else if mask & (IN_CLOSE_WRITE | IN_MOVED_TO) != 0 {
                    pending.insert(rel, "put".to_string());
                    debounce_start = Some(Instant::now());
                } else if mask & (IN_DELETE | IN_MOVED_FROM) != 0 {
                    pending.insert(rel, "del".to_string());
                    debounce_start = Some(Instant::now());
                }
            }
        }

        // Flush if debounce expired and we have pending ops
        if debounce_start.is_some() && debounce_start.unwrap().elapsed() >= Duration::from_millis(DEBOUNCE_MS) && !pending.is_empty() {
            let ops = std::mem::take(&mut pending);
            if tx.send(ops).is_err() {
                break;
            }
            debounce_start = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_events_empty() {
        let events = parse_events(&[]);
        assert!(events.is_empty());
    }

    #[test]
    fn parse_events_short_buffer() {
        let buf = [0u8; 3]; // smaller than InotifyEvent
        let events = parse_events(&buf);
        assert!(events.is_empty());
    }

    #[test]
    fn ignored_rel_filter() {
        assert!(ignored_rel(".git/config"));
        assert!(ignored_rel("node_modules/foo"));
        assert!(ignored_rel(".sync-tmp/bar"));
        assert!(ignored_rel("lost+found"));
        assert!(ignored_rel(".DS_Store"));
        assert!(!ignored_rel("src/index.js"));
        assert!(!ignored_rel("valid/path.txt"));
    }
}
