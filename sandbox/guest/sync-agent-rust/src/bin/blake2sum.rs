use blake2::{Blake2s256, Digest};
use std::env;
use std::fs::File;
use std::io::{self, Read};

// Minimal blake2sum CLI matching the manifest hashing in manifest.rs
// (streamed Blake2s256, lowercase hex). Reads the file named as the first
// argument if given (e.g. `blake2sum /workspace/foo.bin`), otherwise falls
// back to stdin (e.g. `blake2sum < foo.bin`), like sha256sum/md5sum.
fn main() -> io::Result<()> {
    let mut hasher = Blake2s256::new();
    let mut buf = [0u8; 65536];

    let path = env::args().nth(1);
    let mut input: Box<dyn Read> = match &path {
        Some(p) => Box::new(File::open(p)?),
        None => Box::new(io::stdin()),
    };

    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    println!("{:x}", hasher.finalize());
    Ok(())
}