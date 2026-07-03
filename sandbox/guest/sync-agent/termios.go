package main

import (
	"os"
	"syscall"
	"unsafe"
)

// kernel struct termios (linux/386), NCCS = 19
type termios struct {
	Iflag, Oflag, Cflag, Lflag uint32
	Line                       uint8
	Cc                         [19]uint8
}

const (
	tcgets = 0x5401
	tcsets = 0x5402

	ignbrk = 0x1
	brkint = 0x2
	parmrk = 0x8
	istrip = 0x20
	inlcr  = 0x40
	igncr  = 0x80
	icrnl  = 0x100
	ixon   = 0x400

	opost = 0x1

	echoFlag = 0x8
	echonl   = 0x40
	icanon   = 0x2
	isig     = 0x1
	iexten   = 0x8000

	csize  = 0x30
	parenb = 0x100
	cs8    = 0x30

	vtime = 5
	vmin  = 6
)

// setRaw puts a tty (e.g. /dev/hvc0) into raw byte-transparent mode so the
// binary framed protocol is not mangled by the line discipline.
func setRaw(f *os.File) error {
	fd := f.Fd()
	var t termios
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, tcgets, uintptr(unsafe.Pointer(&t))); errno != 0 {
		return errno
	}
	t.Iflag &^= ignbrk | brkint | parmrk | istrip | inlcr | igncr | icrnl | ixon
	t.Oflag &^= opost
	t.Lflag &^= echoFlag | echonl | icanon | isig | iexten
	t.Cflag &^= csize | parenb
	t.Cflag |= cs8
	t.Cc[vmin] = 1
	t.Cc[vtime] = 0
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, tcsets, uintptr(unsafe.Pointer(&t))); errno != 0 {
		return errno
	}
	return nil
}
