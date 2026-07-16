import * as fs from "fs";
import * as net from "net";
import * as path from "path";

function rootDir(): string {
  return path.resolve(__dirname, "..", "..");
}

function resourceDir(): string {
  return path.join(rootDir(), "resources");
}

export function qemuPlatformDir(): string {
  return path.join(resourceDir(), "qemu", process.platform);
}

export interface VmTransport {
  type: "unix" | "tcp";
  /** For Unix: socket path. For TCP: port number as string. */
  local: string;
  /** For Unix: socket path. For TCP: port number as string. */
  connectPath: string;
}

export function qemuBinaryPath(): string {
  const bundled = path.join(qemuPlatformDir(), "qemu-system-x86_64");
  if (fs.existsSync(bundled)) return bundled;
  const bundledExe = path.join(qemuPlatformDir(), "qemu-system-x86_64.exe");
  if (fs.existsSync(bundledExe)) return bundledExe;
  return "qemu-system-x86_64";
}

export function imagesDir(): string {
  return path.join(rootDir(), "images");
}

export function firmwareDir(): string {
  const bundled = path.join(qemuPlatformDir(), "pc-bios");
  if (fs.existsSync(bundled)) return bundled;
  return "";
}

/**
 * Allocate a platform-appropriate serial transport.
 *
 * - Linux / macOS: Unix domain socket inside tmpDir, chmod 0600 after creation.
 * - Windows: named pipe (\\.\pipe\valencebox-serial-<uuid>); default ACL
 *   restricts access to the creator user + admins.
 */
export async function allocSerialTransport(tmpDir: string): Promise<VmTransport> {
  if (process.platform === "win32") {
    // Windows: TCP on 127.0.0.1 with random port — named pipes have a
    // chardev read bug in this QEMU build (greeting works, commands don't).
    const port = await getRandomFreePort();
    return { type: "tcp", local: String(port), connectPath: String(port) };
  }
  const sock = path.join(tmpDir, "serial.sock");
  return { type: "unix", local: sock, connectPath: sock };
}

/**
 * Allocate a platform-appropriate QMP transport.
 *
 * - Linux / macOS: Unix domain socket inside tmpDir, chmod 0600 after creation.
 * - Windows: TCP on 127.0.0.1 (same reason as serial).
 */
export async function allocQmpTransport(tmpDir: string): Promise<VmTransport> {
  if (process.platform === "win32") {
    const port = await getRandomFreePort();
    return { type: "tcp", local: String(port), connectPath: String(port) };
  }
  const sock = path.join(tmpDir, "qmp.sock");
  return { type: "unix", local: sock, connectPath: sock };
}

export function getRandomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export function rootQcow2Path(): string {
  return path.join(imagesDir(), "root.qcow2");
}

export function workspaceQcow2Path(): string {
  return path.join(imagesDir(), "workspace.qcow2");
}
