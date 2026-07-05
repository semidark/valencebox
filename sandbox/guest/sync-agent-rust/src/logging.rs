use std::fs::OpenOptions;
use std::io::Write;

#[macro_export]
macro_rules! slog {
    ($($arg:tt)*) => {
        {
            let msg = format!($($arg)*) + "\n";
            let _ = std::io::Write::write_all(&mut std::io::stderr(), msg.as_bytes());
            let _ = std::io::Write::flush(&mut std::io::stderr());
        }
    };
}

/// Write a diagnostic line to /tmp/watch.log (append mode, flushed immediately).
/// Separate from slog so small file stays readable over serial console.
pub fn diag(msg: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open("/tmp/watch.log") {
        let _ = writeln!(f, "{}", msg);
        let _ = f.flush();
    }
}
