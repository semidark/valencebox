use std::ffi::CString;
use std::os::fd::RawFd;
use std::sync::Arc;
use std::thread;

use crate::frame::{FrameWriter, TYPE_PTY_CLOSE, TYPE_PTY_DATA};

const TIOCSWINSZ: libc::c_int = 0x5414;

#[repr(C)]
struct WinSize {
    ws_row: u16,
    ws_col: u16,
    ws_xpixel: u16,
    ws_ypixel: u16,
}

pub struct PtySession {
    master_fd: RawFd,
    child_pid: i32,
}

impl PtySession {
    pub fn open(rows: u16, cols: u16, fw: Arc<FrameWriter>) -> std::io::Result<Self> {
        let master_fd = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
        if master_fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if unsafe { libc::grantpt(master_fd) } < 0 {
            unsafe { libc::close(master_fd) };
            return Err(std::io::Error::last_os_error());
        }
        if unsafe { libc::unlockpt(master_fd) } < 0 {
            unsafe { libc::close(master_fd) };
            return Err(std::io::Error::last_os_error());
        }

        let slave_name = unsafe { libc::ptsname(master_fd) };
        if slave_name.is_null() {
            unsafe { libc::close(master_fd) };
            return Err(std::io::Error::last_os_error());
        }

        set_winsize(master_fd, rows, cols)?;

        let pid = unsafe { libc::fork() };
        if pid < 0 {
            unsafe { libc::close(master_fd) };
            return Err(std::io::Error::last_os_error());
        }

        if pid == 0 {
            // child
            unsafe { libc::setsid() };
            unsafe { libc::close(master_fd) };
            let slave_fd = unsafe { libc::open(slave_name, libc::O_RDWR) };
            if slave_fd < 0 {
                unsafe { libc::_exit(127) };
            }
            unsafe { libc::dup2(slave_fd, 0) };
            unsafe { libc::dup2(slave_fd, 1) };
            unsafe { libc::dup2(slave_fd, 2) };
            if slave_fd > 2 {
                unsafe { libc::close(slave_fd) };
            }
            let env_term = CString::new("TERM=xterm-256color").unwrap();
            unsafe { libc::putenv(env_term.into_raw()) };
            let env_home = CString::new("HOME=/root").unwrap();
            unsafe { libc::putenv(env_home.into_raw()) };
            let bash = CString::new("/bin/bash").unwrap();
            let login = CString::new("-l").unwrap();
            let argv = [bash.as_ptr(), login.as_ptr(), std::ptr::null()];
            unsafe { libc::execv(bash.as_ptr(), argv.as_ptr()) };
            unsafe { libc::_exit(127) };
        }

        // parent
        let fw_clone = fw.clone();
        let fd_for_thread = master_fd;
        thread::spawn(move || {
            pty_reader_thread(fd_for_thread, fw_clone);
        });

        Ok(PtySession {
            master_fd,
            child_pid: pid,
        })
    }

    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        let mut written = 0;
        while written < data.len() {
            let n = unsafe {
                libc::write(
                    self.master_fd,
                    data[written..].as_ptr() as *const libc::c_void,
                    data.len() - written,
                )
            };
            if n < 0 {
                return Err(std::io::Error::last_os_error());
            }
            written += n as usize;
        }
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> std::io::Result<()> {
        set_winsize(self.master_fd, rows, cols)
    }

    pub fn close(&self) {
        unsafe {
            libc::kill(self.child_pid, libc::SIGHUP);
            libc::close(self.master_fd);
        }
        let mut status: libc::c_int = 0;
        unsafe {
            libc::waitpid(self.child_pid, &mut status, 0);
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.close();
    }
}

fn set_winsize(fd: RawFd, rows: u16, cols: u16) -> std::io::Result<()> {
    let ws = WinSize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let ret = unsafe { libc::ioctl(fd, TIOCSWINSZ, &ws as *const WinSize) };
    if ret < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn pty_reader_thread(fd: RawFd, fw: Arc<FrameWriter>) {
    let mut buf = [0u8; 4096];
    loop {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n <= 0 {
            let _ = fw.send(TYPE_PTY_CLOSE, b"");
            break;
        }
        let _ = fw.send(TYPE_PTY_DATA, &buf[..n as usize]);
    }
}
