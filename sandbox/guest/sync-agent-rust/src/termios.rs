use std::os::fd::AsRawFd;

#[repr(C)]
struct Termios {
    iflag: u32,
    oflag: u32,
    cflag: u32,
    lflag: u32,
    line: u8,
    cc: [u8; 19],
}

const TCGETS: libc::c_int = 0x5401;
const TCSETS: libc::c_int = 0x5402;

const IGNBRK: u32 = 0x1;
const BRKINT: u32 = 0x2;
const PARMRK: u32 = 0x8;
const ISTRIP: u32 = 0x20;
const INLCR: u32 = 0x40;
const IGNCR: u32 = 0x80;
const ICRNL: u32 = 0x100;
const IXON: u32 = 0x400;

const OPOST: u32 = 0x1;

const ECHO: u32 = 0x8;
const ECHONL: u32 = 0x40;
const ICANON: u32 = 0x2;
const ISIG: u32 = 0x1;
const IEXTEN: u32 = 0x8000;

const CSIZE: u32 = 0x30;
const PARENB: u32 = 0x100;
const CS8: u32 = 0x30;

const VTIME: usize = 5;
const VMIN: usize = 6;

fn ioctl_req(v: libc::c_int) -> libc::c_int { v }

pub fn set_raw(fd: std::fs::File) -> std::io::Result<()> {
    let raw_fd = fd.as_raw_fd();
    let mut t: Termios = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::ioctl(raw_fd, ioctl_req(TCGETS), &mut t as *mut Termios) };
    if ret == -1 {
        return Err(std::io::Error::last_os_error());
    }
    t.iflag &= !(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
    t.oflag &= !OPOST;
    t.lflag &= !(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
    t.cflag &= !(CSIZE | PARENB);
    t.cflag |= CS8;
    t.cc[VTIME] = 0;
    t.cc[VMIN] = 1;
    let ret = unsafe { libc::ioctl(raw_fd, ioctl_req(TCSETS), &t as *const Termios) };
    if ret == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
