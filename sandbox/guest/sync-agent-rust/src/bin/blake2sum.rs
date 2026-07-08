use blake2::{Blake2s256, Digest};
use std::io::{self, Read};

fn main() -> io::Result<()> {
    let mut buf = Vec::new();
    io::stdin().read_to_end(&mut buf)?;
    let hash = Blake2s256::digest(&buf);
    for byte in hash {
        print!("{byte:02x}");
    }
    Ok(())
}