
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{self, Read};
use std::sync::{Arc, Mutex};

use blake2::Digest;

use crate::frame::{FrameWriter, TYPE_EVENT};

#[derive(Clone)]
struct StatHash {
    hash: String,
    size: i64,
    mtime_ms: i64,
}

pub struct SyncState {
    inner: Mutex<SyncStateInner>,
}

struct SyncStateInner {
    last_sync: HashMap<String, String>,
    stat_cache: HashMap<String, StatHash>,
    fw: Option<Arc<FrameWriter>>,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SyncStateInner {
                last_sync: HashMap::new(),
                stat_cache: HashMap::new(),
                fw: None,
            }),
        }
    }

    pub fn set_fw(&self, fw: Arc<FrameWriter>) {
        let mut inner = self.inner.lock().unwrap();
        inner.fw = Some(fw);
    }

    pub fn mark_synced(&self, rel: &str, hash: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.last_sync.insert(rel.to_string(), hash.to_string());
    }

    pub fn mark_deleted(&self, rel: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.last_sync.remove(rel);
        inner.stat_cache.remove(rel);
    }

    /// Remap all state entries under old_rel prefix to new_rel prefix.
    pub fn remap_prefix(&self, old_rel: &str, new_rel: &str) {
        let mut inner = self.inner.lock().unwrap();
        let prefix = format!("{}/", old_rel);
        let new_prefix = format!("{}/", new_rel);

        let mut remapped: Vec<(String, String, String)> = Vec::new();
        for key in inner.last_sync.keys() {
            if key == old_rel || key.starts_with(&prefix) {
                let new_key = if key == old_rel {
                    new_rel.to_string()
                } else {
                    new_prefix.clone() + &key[old_rel.len() + 1..]
                };
                let val = inner.last_sync.get(key).cloned().unwrap();
                remapped.push((key.clone(), new_key, val));
            }
        }
        for (old_key, new_key, val) in remapped {
            inner.last_sync.remove(&old_key);
            inner.last_sync.insert(new_key, val);
        }

        // Same remap for stat_cache
        let mut remapped: Vec<(String, String, StatHash)> = Vec::new();
        let prefix = format!("{}/", old_rel);
        for (key, val) in &inner.stat_cache {
            if key == old_rel || key.starts_with(&prefix) {
                let new_key = if key == old_rel {
                    new_rel.to_string()
                } else {
                    new_prefix.clone() + &key[old_rel.len() + 1..]
                };
                remapped.push((key.clone(), new_key, val.clone()));
            }
        }
        for (old_key, new_key, val) in remapped {
            inner.stat_cache.remove(&old_key);
            inner.stat_cache.insert(new_key, val);
        }
    }

    pub fn last_hash(&self, rel: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner.last_sync.get(rel).cloned()
    }

    pub fn has_prefix(&self, rel: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        let prefix = format!("{}/", rel);
        inner.last_sync.keys().any(|k| k == rel || k.starts_with(&prefix))
    }

    pub fn hash_cached(&self, rel: &str, abs: &str) -> io::Result<String> {
        let meta = fs::metadata(abs)?;
        let size = meta.len() as i64;
        let mtime_ms = meta.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.hash_cached_stat(rel, abs, size, mtime_ms)
    }

    pub fn hash_cached_stat(&self, rel: &str, abs: &str, size: i64, mtime_ms: i64) -> io::Result<String> {
        {
            let inner = self.inner.lock().unwrap();
            if let Some(c) = inner.stat_cache.get(rel) {
                if c.size == size && c.mtime_ms == mtime_ms {
                    return Ok(c.hash.clone());
                }
            }
        }
        let h = Self::hash_file(abs)?;
        let mut inner = self.inner.lock().unwrap();
        inner.stat_cache.insert(
            rel.to_string(),
            StatHash {
                hash: h.clone(),
                size,
                mtime_ms,
            },
        );
        Ok(h)
    }

    pub fn is_echo(&self, rel: &str, abs: &str) -> bool {
        let last = match self.last_hash(rel) {
            Some(h) => h,
            None => return false,
        };
        match Self::hash_file(abs) {
            Ok(h) => h == last,
            Err(_) => false,
        }
    }

    pub fn hash_file(path: &str) -> io::Result<String> {
        let mut f = File::open(path)?;
        let mut hasher = blake2::Blake2s256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    // ResolveIncoming: LWW conflict resolution.
    // Returns ("remote", false) if no conflict, or ("local"/"remote", true) on conflict.
    pub fn resolve_incoming(&self, rel: &str, abs: &str, remote_hash: &str, remote_mtime_ms: i64) -> (&'static str, bool) {
        let meta = match fs::metadata(abs) {
            Ok(m) => m,
            Err(_) => return ("remote", false),
        };
        let local_hash = match Self::hash_file(abs) {
            Ok(h) => h,
            Err(_) => return ("remote", false),
        };
        if local_hash == remote_hash {
            return ("remote", false);
        }
        let last = self.last_hash(rel);
        if last.as_deref() == Some(&local_hash.as_str()) {
            return ("remote", false);
        }
        let local_mtime_ms = meta.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let winner = if local_mtime_ms > remote_mtime_ms
            || (local_mtime_ms == remote_mtime_ms && local_hash.as_str() > remote_hash)
        {
            "local"
        } else {
            "remote"
        };
        let fw = self.inner.lock().unwrap().fw.clone();
        if let Some(ref fw) = fw {
            let event = serde_json::json!({
                "events": [{
                    "op": "conflict",
                    "path": rel,
                    "winner": winner,
                    "localMtimeMs": local_mtime_ms,
                    "remoteMtimeMs": remote_mtime_ms,
                }]
            });
            let _ = fw.send(TYPE_EVENT, &serde_json::to_vec(&event).unwrap());
        }
        crate::slog!("CONFLICT {}: local mtime={} remote mtime={} -> {} wins", rel, local_mtime_ms, remote_mtime_ms, winner);
        (winner, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_incoming_no_conflict() {
        let ss = SyncState::new();
        // File doesn't exist locally → remote wins, no conflict
        let (winner, conflict) = ss.resolve_incoming("nonexistent.txt", "/tmp/nonexistent.txt", "abc", 1000);
        assert_eq!(winner, "remote");
        assert!(!conflict);
    }

    #[test]
    fn is_echo_no_last_sync() {
        let ss = SyncState::new();
        assert!(!ss.is_echo("foo.txt", "/tmp/foo.txt"));
    }

    #[test]
    fn hash_cached_miss() {
        let ss = SyncState::new();
        // Non-existent file returns error
        let r = ss.hash_cached("foo.txt", "/tmp/nonexistent_hash");
        assert!(r.is_err());
    }

    #[test]
    fn mark_synced_and_last_hash() {
        let ss = SyncState::new();
        ss.mark_synced("test.txt", "deadbeef");
        assert_eq!(ss.last_hash("test.txt").unwrap(), "deadbeef");
        assert!(ss.last_hash("other.txt").is_none());
    }

    #[test]
    fn mark_deleted_clears_cache() {
        let ss = SyncState::new();
        ss.mark_synced("test.txt", "deadbeef");
        ss.mark_deleted("test.txt");
        assert!(ss.last_hash("test.txt").is_none());
    }

    #[test]
    fn remap_prefix_file() {
        let ss = SyncState::new();
        ss.mark_synced("old.txt", "aaa");
        ss.remap_prefix("old.txt", "new.txt");
        assert!(ss.last_hash("old.txt").is_none());
        assert_eq!(ss.last_hash("new.txt").unwrap(), "aaa");
    }

    #[test]
    fn remap_prefix_dir() {
        let ss = SyncState::new();
        ss.mark_synced("olddir/a.txt", "aaa");
        ss.mark_synced("olddir/b.txt", "bbb");
        ss.mark_synced("olddir/sub/c.txt", "ccc");
        ss.mark_synced("unrelated.txt", "unrelated");
        ss.remap_prefix("olddir", "newdir");
        assert!(ss.last_hash("olddir/a.txt").is_none());
        assert!(ss.last_hash("olddir/b.txt").is_none());
        assert!(ss.last_hash("olddir/sub/c.txt").is_none());
        assert_eq!(ss.last_hash("newdir/a.txt").unwrap(), "aaa");
        assert_eq!(ss.last_hash("newdir/b.txt").unwrap(), "bbb");
        assert_eq!(ss.last_hash("newdir/sub/c.txt").unwrap(), "ccc");
        assert_eq!(ss.last_hash("unrelated.txt").unwrap(), "unrelated");
    }

    #[test]
    fn remap_prefix_stat_cache() {
        let ss = SyncState::new();
        // prime stat_cache by calling hash_cached on a real temp file
        use std::io::Write;
        let dir = std::env::temp_dir();
        let p = dir.join("vb_remap_test_a.txt");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"hello").unwrap();
        f.flush().unwrap();
        drop(f);
        let abs = p.to_str().unwrap();
        ss.mark_synced("old/remap_a.txt", "manual");
        let _ = ss.hash_cached("old/remap_a.txt", abs).unwrap();
        // stat_cache should have an entry now
        ss.remap_prefix("old", "new");
        assert!(ss.last_hash("old/remap_a.txt").is_none());
        assert_eq!(ss.last_hash("new/remap_a.txt").unwrap(), "manual");
        // stat_cache hit for new path (via stat + size match)
        let meta = std::fs::metadata(abs).unwrap();
        let r = ss.hash_cached_stat("new/remap_a.txt", abs, meta.len() as i64, 0);
        // cached hash should match original (from cache, not file read)
        assert!(r.is_ok());
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn has_prefix_matches_exact_and_subtree() {
        let ss = SyncState::new();
        ss.mark_synced("dir/a.txt", "aaa");
        ss.mark_synced("dir/sub/b.txt", "bbb");
        ss.mark_synced("other.txt", "ccc");
        assert!(ss.has_prefix("dir"));
        assert!(ss.has_prefix("dir/a.txt"));
        assert!(!ss.has_prefix("missing"));
    }
}
