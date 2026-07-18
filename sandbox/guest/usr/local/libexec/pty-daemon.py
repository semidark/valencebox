#!/usr/bin/env python3
import os
import pty
import select
import struct
import sys
import termios
import fcntl
import errno

def main():
    try:
        hvc0 = os.open('/dev/hvc0', os.O_RDWR | os.O_NOCTTY)
    except Exception as e:
        sys.stderr.write(f"pty-daemon: failed to open /dev/hvc0: {e}\n")
        sys.exit(1)

    pid, master_fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'vt100'
        os.environ['HOME'] = '/root'
        try:
            os.execlp('/bin/bash', 'bash', '--login')
        except Exception as e:
            sys.stderr.write(f"pty-daemon: failed to exec bash: {e}\n")
            sys.exit(1)

    hvc_buf = bytearray()

    try:
        while True:
            r, _, _ = select.select([hvc0, master_fd], [], [])

            if hvc0 in r:
                chunk = os.read(hvc0, 4096)
                if not chunk:
                    break
                hvc_buf.extend(chunk)

                while len(hvc_buf) >= 5:
                    payload_len, msg_type = struct.unpack('>IB', hvc_buf[:5])
                    frame_len = 5 + payload_len
                    if len(hvc_buf) < frame_len:
                        break
                    payload = hvc_buf[5:frame_len]
                    del hvc_buf[:frame_len]

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
                os.write(hvc0, header + data)

    finally:
        try:
            os.close(master_fd)
        except:
            pass
        try:
            os.close(hvc0)
        except:
            pass

if __name__ == '__main__':
    main()
