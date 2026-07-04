use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
pub struct FileMeta {
    pub hash: String,
    pub size: i64,
    pub mode: u32,
    pub mtime_ms: i64,
}

#[derive(Serialize, Debug)]
pub struct Manifest {
    pub files: HashMap<String, FileMeta>,
}

const TMP_DIR_NAME: &str = ".sync-tmp";
const IGNORED_NAMES: &[&str] = &[TMP_DIR_NAME, ".git", "node_modules", "lost+found", ".DS_Store"];

pub fn ignored_rel(rel: &str) -> bool {
    rel.split('/').any(|seg| IGNORED_NAMES.contains(&seg))
}

pub fn hash_file(path: &str) -> io::Result<String> {
    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
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

pub fn build_manifest(root: &str, state: &mut SyncState) -> io::Result<Manifest> {
    let mut m = Manifest {
        files: HashMap::new(),
    };
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if ignored_rel(&rel_str) {
            if entry.file_type().is_dir() {
                // walkdir doesn't have SkipDir equivalent, but ignored paths won't recurse into node_modules/.git etc.
                // We just skip entries; walkdir still walks subdirs but we filter them out.
            }
            continue;
        }
        if entry.file_type().is_dir() {
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let meta = entry.metadata()?;
        let size = meta.len() as i64;
        let mtime_ms = meta.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let hash = state.hash_cached_stat(&rel_str, path.to_string_lossy().as_ref(), size, mtime_ms)?;
        let mode = meta.permissions().mode() & 0o777;
        m.files.insert(
            rel_str,
            FileMeta {
                hash,
                size,
                mode: mode as u32,
                mtime_ms,
            },
        );
    }
    Ok(m)
}

const MANIFEST_BATCH_LIMIT: usize = 160 * 1024;

pub fn marshal_manifest_batches(m: &Manifest) -> Vec<Vec<u8>> {
    let mut batches = Vec::new();
    let mut cur = Manifest {
        files: HashMap::new(),
    };
    let mut cur_len: usize = 0;

    let mut files: Vec<_> = m.files.iter().collect();
    files.sort_by_key(|(k, _)| *k);

    for (rel, meta) in files {
        let ent_len = rel.len() + 160;
        if cur_len > 0 && cur_len + ent_len > MANIFEST_BATCH_LIMIT {
            let json = serde_json::to_vec(&cur).unwrap();
            batches.push(json);
            cur = Manifest {
                files: HashMap::new(),
            };
            cur_len = 0;
        }
        cur.files.insert(rel.clone(), meta.clone());
        cur_len += ent_len;
    }
    if !cur.files.is_empty() {
        let json = serde_json::to_vec(&cur).unwrap();
        batches.push(json);
    }
    batches
}

pub fn safe_join(root: &str, rel: &str) -> Option<String> {
    if rel.is_empty() || rel.starts_with('/') {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for comp in Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(name) => {
                parts.push(name.to_string_lossy().to_string());
            }
            std::path::Component::ParentDir => {
                if parts.pop().is_none() {
                    return None;
                }
            }
            _ => {}
        }
    }
    let clean = parts.join("/");
    if !clean.is_empty() {
        Some(format!("{}/{}", root, clean))
    } else {
        Some(root.to_string())
    }
}

use crate::state::SyncState;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_rel_catches_node_modules() {
        assert!(ignored_rel("node_modules/foo.js"));
        assert!(ignored_rel("src/node_modules/foo.js"));
        assert!(!ignored_rel("src/index.js"));
    }

    #[test]
    fn ignored_rel_catches_git() {
        assert!(ignored_rel(".git/config"));
        assert!(ignored_rel("sub/.git/HEAD"));
        assert!(!ignored_rel("my-git-clone/readme.txt"));
    }

    #[test]
    fn ignored_rel_catches_sync_tmp() {
        assert!(ignored_rel(".sync-tmp/lock"));
        assert!(ignored_rel("build/.sync-tmp/foo"));
    }

    #[test]
    fn ignored_rel_ds_store() {
        assert!(ignored_rel(".DS_Store"));
        assert!(ignored_rel("src/.DS_Store"));
    }

    #[test]
    fn ignored_rel_lost_found() {
        assert!(ignored_rel("lost+found/file"));
    }

    #[test]
    fn safe_join_normal() {
        assert_eq!(safe_join("/workspace", "src/main.rs"), Some("/workspace/src/main.rs".to_string()));
        assert_eq!(safe_join("/workspace", "file.txt"), Some("/workspace/file.txt".to_string()));
    }

    #[test]
    fn safe_join_rejects_empty() {
        assert_eq!(safe_join("/workspace", ""), None);
    }

    #[test]
    fn safe_join_rejects_absolute() {
        assert_eq!(safe_join("/workspace", "/etc/passwd"), None);
    }

    #[test]
    fn safe_join_rejects_traversal() {
        assert_eq!(safe_join("/workspace", "../etc/passwd"), None);
        assert_eq!(safe_join("/workspace", "foo/../../etc/passwd"), None);
    }

    #[test]
    fn hash_file_known_content() {
        use std::fs::File;
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("sync-agent-test-{:x}", rand()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.txt");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);
        let h = hash_file(path.to_string_lossy().as_ref()).unwrap();
        assert_eq!(h, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn marshal_manifest_batches_single() {
        let mut m = Manifest {
            files: HashMap::new(),
        };
        m.files.insert(
            "small.txt".to_string(),
            FileMeta {
                hash: "abc".to_string(),
                size: 10,
                mode: 0o644,
                mtime_ms: 1000,
            },
        );
        let batches = marshal_manifest_batches(&m);
        assert_eq!(batches.len(), 1);
        let json: serde_json::Value = serde_json::from_slice(&batches[0]).unwrap();
        assert!(json["files"]["small.txt"].is_object());
    }

    fn rand() -> u64 {
        use std::time::SystemTime;
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }
}
