#!/usr/bin/env python3
import os
import pty
import select
import struct
import sys
import termios
import fcntl
import errno

VPORT_PATH = '/dev/virtio-ports/pty'

def open_port():
    try:
        return os.open(VPORT_PATH, os.O_RDWR)
    except Exception as e:
        sys.stderr.write(f"pty-daemon: failed to open {VPORT_PATH}: {e}\n")
        sys.exit(1)

def main():
    port_fd = open_port()

    pid, master_fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'vt100'
        os.environ['HOME'] = '/root'
        try:
            os.execlp('/bin/bash', 'bash', '--login')
        except Exception as e:
            sys.stderr.write(f"pty-daemon: failed to exec bash: {e}\n")
            sys.exit(1)

    port_buf = bytearray()

    try:
        while True:
            r, _, _ = select.select([port_fd, master_fd], [], [])

            if port_fd in r:
                chunk = os.read(port_fd, 4096)
                if not chunk:
                    break
                port_buf.extend(chunk)

                while len(port_buf) >= 5:
                    payload_len, msg_type = struct.unpack('>IB', port_buf[:5])
                    frame_len = 5 + payload_len
                    if len(port_buf) < frame_len:
                        break
                    payload = port_buf[5:frame_len]
                    del port_buf[:frame_len]

                    if msg_type == 1:
                        os.write(master_fd, payload)
                    elif msg_type == 2:
                        if len(payload) == 4:
                            cols, rows = struct.unpack('>HH', payload)
                            ws = struct.pack('HHHH', rows, cols, 0, 0)
                            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, ws)
                    elif msg_type == 3:
                        try:
                            os.kill(pid, 15)
                        except:
                            pass
                        return

            if master_fd in r:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                except OSError as e:
                    if e.errno == errno.EIO:
                        break
                    raise

                header = struct.pack('>IB', len(data), 1)
                os.write(port_fd, header + data)

    finally:
        try:
            os.close(master_fd)
        except:
            pass
        try:
            os.close(port_fd)
        except:
            pass

if __name__ == '__main__':
    main()
