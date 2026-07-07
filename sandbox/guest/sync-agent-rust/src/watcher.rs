use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::manifest::ignored_rel;

const COOKIE_WINDOW_MS: u64 = 500;

const IN_CLOSE_WRITE: u32 = 0x00000008;
const IN_CREATE: u32 = 0x00000100;
const IN_DELETE: u32 = 0x00000200;
const IN_MOVED_TO: u32 = 0x00000080;
const IN_MOVED_FROM: u32 = 0x00000040;
const IN_ISDIR: u32 = 0x40000000;

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

/// Typed watcher operation — replaces stringly-typed HashMap.
#[derive(Debug, Clone)]
pub enum WatchOp {
    Put(String),
    Del(String),
    Rename { old: String, new: String },
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
    tx: mpsc::Sender<Vec<WatchOp>>,
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

fn parse_events(buf: &[u8]) -> Vec<(i32, u32, u32, String)> {
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
        events.push((event.wd, event.mask, event.cookie, name));
        off += std::mem::size_of::<InotifyEvent>() + event.len as usize;
    }
    events
}

/// Remap wd→path entries under old_abs prefix to new_abs prefix.
fn remap_wds(state: &Arc<Mutex<WatcherState>>, old_abs: &str, new_abs: &str) {
    let mut st = state.lock().unwrap();
    let mut remapped: Vec<(i32, String)> = Vec::new();
    for (&wd, path) in &st.wds {
        if path == old_abs {
            remapped.push((wd, new_abs.to_string()));
        } else if path.starts_with(&format!("{}/", old_abs)) {
            let rest = &path[old_abs.len()..];
            remapped.push((wd, format!("{}{}", new_abs, rest)));
        }
    }
    for (wd, new_path) in remapped {
        st.wds.insert(wd, new_path);
    }
}

fn watcher_loop(fd: i32, state: &Arc<Mutex<WatcherState>>, tx: &Arc<mpsc::Sender<Vec<WatchOp>>>) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut pending: Vec<WatchOp> = Vec::new();
    // pending_renames: cookie → (old_rel, is_dir, old_abs, start_time)
    let mut pending_renames: HashMap<u32, (String, bool, String, Instant)> = HashMap::new();
    let mut debounce_start: Option<Instant> = None;

    macro_rules! flush_pending {
        () => {
            let ops = std::mem::take(&mut pending);
            if !ops.is_empty() {
                let _ = tx.send(ops);
            }
            debounce_start = None;
        };
    }

    loop {
        let mut timeout_ms: i32 = -1;
        if let Some(start) = debounce_start {
            let elapsed = start.elapsed().as_millis() as u64;
            if elapsed >= DEBOUNCE_MS {
                timeout_ms = 1;
            } else {
                timeout_ms = (DEBOUNCE_MS - elapsed) as i32;
                if timeout_ms > 100 { timeout_ms = 100; }
            }
        }
        {
            let now = Instant::now();
            let mut min_cookie_rem: Option<u64> = None;
            pending_renames.retain(|_, (_, _, _, start_time)| {
                let elapsed = now.duration_since(*start_time).as_millis() as u64;
                if elapsed >= COOKIE_WINDOW_MS {
                    return false;
                }
                let rem = COOKIE_WINDOW_MS - elapsed;
                if min_cookie_rem.is_none() || rem < min_cookie_rem.unwrap() {
                    min_cookie_rem = Some(rem);
                }
                true
            });
            if timeout_ms == -1 {
                if let Some(rem) = min_cookie_rem {
                    timeout_ms = rem as i32;
                    if timeout_ms > 100 { timeout_ms = 100; }
                }
            }
        }

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
            let mut dir_creates: Vec<String> = Vec::new();

            {
                let st = state.lock().unwrap();
                let root = st.root.clone();
                drop(st);

                // Gather all resolved events + paths first, then process
                let mut resolved: Vec<(i32, u32, u32, String, String, String)> = Vec::new();
                {
                    let st = state.lock().unwrap();
                    for (wd, mask, cookie, name) in &events {
                        if name.is_empty() || *name == ".sync-tmp" {
                            continue;
                        }
                        let dir = match st.wds.get(wd) {
                            Some(d) => d.clone(),
                            None => continue,
                        };
                        let abs = format!("{}/{}", dir, name);
                        let rel = match Path::new(&abs).strip_prefix(&root) {
                            Ok(r) => r.to_string_lossy().to_string(),
                            Err(_) => continue,
                        };
                        resolved.push((*wd, *mask, *cookie, name.clone(), abs, rel));
                    }
                }

                for (_wd, mask, cookie, _name, abs, rel) in resolved {
                    let is_dir = mask & IN_ISDIR != 0;
                    let rel_ignored = ignored_rel(&rel);

                    // === Cookie correlation ===
                    if cookie != 0 {
                        if mask & IN_MOVED_FROM != 0 {
                            pending_renames.insert(cookie, (rel.clone(), is_dir, abs.clone(), Instant::now()));
                            continue;
                        }
                        if mask & IN_MOVED_TO != 0 {
                            if let Some((old_rel, _old_is_dir, old_abs, _)) = pending_renames.remove(&cookie) {
                                let new_ignored = ignored_rel(&rel);

                                if is_dir {
                                    remap_wds(state, &old_abs, &abs);
                                }

                                let old_visible = !ignored_rel(&old_rel);
                                let new_visible = !new_ignored;

                                if old_visible && new_visible {
                                    pending.push(WatchOp::Rename { old: old_rel, new: rel.clone() });
                                    debounce_start = Some(Instant::now());
                                } else if old_visible && !new_visible {
                                    pending.push(WatchOp::Del(old_rel));
                                    debounce_start = Some(Instant::now());
                                } else if !old_visible && new_visible {
                                    dir_creates.push(abs.clone());
                                }

                                if new_visible {
                                    continue;
                                }
                            }
                        }
                    }

                    if rel_ignored {
                        continue;
                    }

                    // === Standard event handling ===
                    if is_dir && (mask & (IN_CREATE | IN_MOVED_TO) != 0) {
                        dir_creates.push(abs.clone());
                    } else if is_dir && (mask & (IN_DELETE | IN_MOVED_FROM) != 0) {
                        pending.push(WatchOp::Del(rel.clone()));
                        debounce_start = Some(Instant::now());
                    } else if mask & (IN_CLOSE_WRITE | IN_MOVED_TO) != 0 {
                        pending.push(WatchOp::Put(rel.clone()));
                        debounce_start = Some(Instant::now());
                    } else if mask & (IN_DELETE | IN_MOVED_FROM) != 0 {
                        pending.push(WatchOp::Del(rel.clone()));
                        debounce_start = Some(Instant::now());
                    }
                }
            }

            for abs in &dir_creates {
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
                                                pending.push(WatchOp::Put(rel_str));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                debounce_start = Some(Instant::now());
            }
        }

        // Expire stale rename cookies (fallback to delete for visible source)
        {
            let now = Instant::now();
            let mut expired: Vec<(String, bool)> = Vec::new();
            pending_renames.retain(|_, (old_rel, _is_dir, _, start_time)| {
                if now.duration_since(*start_time).as_millis() >= COOKIE_WINDOW_MS as u128 {
                    let visible = !ignored_rel(old_rel);
                    expired.push((old_rel.clone(), visible));
                    false
                } else {
                    true
                }
            });
            for (old_rel, visible) in &expired {
                if *visible {
                    pending.push(WatchOp::Del(old_rel.clone()));
                    debounce_start = Some(Instant::now());
                }
            }
        }

        if debounce_start.is_some()
            && debounce_start.unwrap().elapsed() >= Duration::from_millis(DEBOUNCE_MS)
            && !pending.is_empty()
        {
            flush_pending!();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C, align(4))]
    struct AlignedBuf<const N: usize>([u8; N]);

    impl<const N: usize> std::ops::Deref for AlignedBuf<N> {
        type Target = [u8; N];
        fn deref(&self) -> &[u8; N] { &self.0 }
    }

    #[test]
    fn parse_events_empty() {
        let events = parse_events(&[]);
        assert!(events.is_empty());
    }

    #[test]
    fn parse_events_short_buffer() {
        let buf = [0u8; 3];
        let events = parse_events(&buf);
        assert!(events.is_empty());
    }

    fn build_event(wd: i32, mask: u32, cookie: u32, name: &str, buf: &mut Vec<u8>) {
        let event_size = std::mem::size_of::<InotifyEvent>();
        let min_name_len = name.len() + 1;
        let padded_name_len = (min_name_len + 3) & !3;
        let off = buf.len();
        buf.resize(off + event_size + padded_name_len, 0u8);
        let event = InotifyEvent { wd, mask, cookie, len: padded_name_len as u32 };
        unsafe {
            std::ptr::copy(
                &event as *const InotifyEvent as *const u8,
                buf.as_mut_ptr().add(off),
                event_size
            );
            let name_bytes = name.as_bytes();
            std::ptr::copy(
                name_bytes.as_ptr(),
                buf.as_mut_ptr().add(off + event_size),
                name_bytes.len(),
            );
        }
    }

    #[test]
    fn parse_events_single_inotify_event() {
        let mut buf = AlignedBuf::<256>([0u8; 256]);
        let mut v: Vec<u8> = Vec::new();
        build_event(1, IN_CLOSE_WRITE, 0, "test.txt", &mut v);
        assert!(v.len() <= buf.0.len());
        buf.0[..v.len()].copy_from_slice(&v);
        let events = parse_events(&buf.0[..v.len()]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, 1);
        assert_eq!(events[0].1, IN_CLOSE_WRITE);
        assert_eq!(events[0].2, 0);
        assert_eq!(events[0].3, "test.txt");
    }

    #[test]
    fn parse_events_multiple_inotify_events() {
        let mut buf = AlignedBuf::<512>([0u8; 512]);
        let mut v: Vec<u8> = Vec::new();
        build_event(1, IN_CLOSE_WRITE, 0, "a.txt", &mut v);
        build_event(2, IN_DELETE, 0, "b.txt", &mut v);
        assert!(v.len() <= buf.0.len());
        buf.0[..v.len()].copy_from_slice(&v);

        let events = parse_events(&buf.0[..v.len()]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, 1);
        assert_eq!(events[0].1, IN_CLOSE_WRITE);
        assert_eq!(events[0].2, 0);
        assert_eq!(events[0].3, "a.txt");
        assert_eq!(events[1].0, 2);
        assert_eq!(events[1].1, IN_DELETE);
        assert_eq!(events[1].2, 0);
        assert_eq!(events[1].3, "b.txt");
    }

    #[test]
    fn parse_events_moved_from_and_to() {
        let mut buf = AlignedBuf::<512>([0u8; 512]);
        let mut v: Vec<u8> = Vec::new();
        build_event(1, IN_MOVED_FROM, 42, "renamed.txt", &mut v);
        build_event(1, IN_MOVED_TO, 42, "moved.txt", &mut v);
        assert!(v.len() <= buf.0.len());
        buf.0[..v.len()].copy_from_slice(&v);

        let events = parse_events(&buf.0[..v.len()]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].1, IN_MOVED_FROM);
        assert_eq!(events[0].0, 1);
        assert_eq!(events[0].2, 42);
        assert_eq!(events[0].3, "renamed.txt");
        assert_eq!(events[1].1, IN_MOVED_TO);
        assert_eq!(events[1].0, 1);
        assert_eq!(events[1].2, 42);
        assert_eq!(events[1].3, "moved.txt");
    }

    #[test]
    fn parse_events_move_no_cookie_not_correlated() {
        let mut buf = AlignedBuf::<512>([0u8; 512]);
        let mut v: Vec<u8> = Vec::new();
        build_event(1, IN_MOVED_FROM, 99, "src.txt", &mut v);
        build_event(1, IN_MOVED_TO, 88, "dst.txt", &mut v);
        assert!(v.len() <= buf.0.len());
        buf.0[..v.len()].copy_from_slice(&v);

        let events = parse_events(&buf.0[..v.len()]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].2, 99);
        assert_eq!(events[1].2, 88);
        assert_eq!(events[0].3, "src.txt");
        assert_eq!(events[1].3, "dst.txt");
    }

    #[test]
    fn parse_events_dir_inotify() {
        let mut buf = AlignedBuf::<512>([0u8; 512]);
        let mut v: Vec<u8> = Vec::new();
        build_event(1, IN_CREATE | IN_ISDIR, 0, "newdir", &mut v);
        assert!(v.len() <= buf.0.len());
        buf.0[..v.len()].copy_from_slice(&v);

        let events = parse_events(&buf.0[..v.len()]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, IN_CREATE | IN_ISDIR);
        assert_eq!(events[0].2, 0);
        assert_eq!(events[0].3, "newdir");
    }

    #[test]
    fn parse_events_moved_dir() {
        let mut buf = AlignedBuf::<512>([0u8; 512]);
        let mut v: Vec<u8> = Vec::new();
        build_event(1, IN_MOVED_FROM | IN_ISDIR, 55, "olddir", &mut v);
        build_event(1, IN_MOVED_TO | IN_ISDIR, 55, "newdir", &mut v);
        assert!(v.len() <= buf.0.len());
        buf.0[..v.len()].copy_from_slice(&v);

        let events = parse_events(&buf.0[..v.len()]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].1, IN_MOVED_FROM | IN_ISDIR);
        assert_eq!(events[0].2, 55);
        assert_eq!(events[0].3, "olddir");
        assert_eq!(events[1].1, IN_MOVED_TO | IN_ISDIR);
        assert_eq!(events[1].2, 55);
        assert_eq!(events[1].3, "newdir");
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

    #[test]
    fn remap_wds_exact_match() {
        let st = Arc::new(Mutex::new(WatcherState { root: "/ws".into(), wds: HashMap::new() }));
        st.lock().unwrap().wds.insert(1, "/ws/old".into());
        remap_wds(&st, "/ws/old", "/ws/new");
        assert_eq!(st.lock().unwrap().wds.get(&1).unwrap(), "/ws/new");
    }

    #[test]
    fn remap_wds_subtree() {
        let st = Arc::new(Mutex::new(WatcherState { root: "/ws".into(), wds: HashMap::new() }));
        let mut wds = HashMap::new();
        wds.insert(1, "/ws/old".into());
        wds.insert(2, "/ws/old/sub".into());
        wds.insert(3, "/ws/old/sub/deep".into());
        wds.insert(4, "/ws/keep".into());
        wds.insert(5, "/ws/other".into());
        *st.lock().unwrap() = WatcherState { root: "/ws".into(), wds };
        remap_wds(&st, "/ws/old", "/ws/new");
        let guard = st.lock().unwrap();
        assert_eq!(guard.wds.get(&1).unwrap(), "/ws/new");
        assert_eq!(guard.wds.get(&2).unwrap(), "/ws/new/sub");
        assert_eq!(guard.wds.get(&3).unwrap(), "/ws/new/sub/deep");
        assert_eq!(guard.wds.get(&4).unwrap(), "/ws/keep");
        assert_eq!(guard.wds.get(&5).unwrap(), "/ws/other");
    }
}
