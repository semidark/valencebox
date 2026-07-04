use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{self, Read};
use std::sync::Mutex;

use sha2::Digest;

use crate::frame::FrameWriter;

#[derive(Clone)]
struct StatHash {
    hash: String,
    size: i64,
    mtime_ms: i64,
}

pub struct SyncState {
    inner: Mutex<SyncStateInner>,
    fw: FrameWriter,
}

struct SyncStateInner {
    last_sync: HashMap<String, String>,
    stat_cache: HashMap<String, StatHash>,
}

impl SyncState {
    pub fn new(fw: FrameWriter) -> Self {
        Self {
            inner: Mutex::new(SyncStateInner {
                last_sync: HashMap::new(),
                stat_cache: HashMap::new(),
            }),
            fw,
        }
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

    pub fn last_hash(&self, rel: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner.last_sync.get(rel).cloned()
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

    fn hash_file(path: &str) -> io::Result<String> {
        let mut f = File::open(path)?;
        let mut hasher = sha2::Sha256::new();
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
}
