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
