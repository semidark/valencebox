import { app } from "electron";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { GuestArch } from "./guest-profile";

function isDev(): boolean {
  if (typeof app === "undefined" || app === null) return true;
  return !app.isPackaged;
}

function resourceDir(): string {
  // Packaged: process.resourcesPath is the app bundle Resources directory.
  // Dev: <sandbox>/resources/
  return isDev() ? path.resolve(__dirname, "..", "..", "resources") : process.resourcesPath;
}

export function imagesDir(): string {
  // Packaged: flat under process.resourcesPath alongside qemu/.
  // Dev: <sandbox>/images/
  return isDev() ? path.resolve(__dirname, "..", "..", "images") : path.join(process.resourcesPath, "images");
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

export function qemuBinaryPath(arch?: GuestArch): string {
  const binary = arch === "aarch64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  const bundled = path.join(qemuPlatformDir(), binary);
  if (fs.existsSync(bundled)) return bundled;
  const bundledExe = path.join(qemuPlatformDir(), `${binary}.exe`);
  if (fs.existsSync(bundledExe)) return bundledExe;
  return binary;
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

/**
 * Allocate a platform-appropriate PTY transport for virtio-serial (virtserialport).
 *
 * - Linux / macOS: Unix domain socket inside tmpDir, chmod 0600 after creation.
 * - Windows: TCP on 127.0.0.1 (same reason as serial).
 */
export async function allocPtyTransport(tmpDir: string): Promise<VmTransport> {
  if (process.platform === "win32") {
    const port = await getRandomFreePort();
    return { type: "tcp", local: String(port), connectPath: String(port) };
  }
  const sock = path.join(tmpDir, "pty.sock");
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

function archSuffix(arch?: GuestArch): string {
  return arch === "aarch64" ? "-arm64" : "";
}

export function rootQcow2Path(arch?: GuestArch): string {
  return path.join(imagesDir(), `root${archSuffix(arch)}.qcow2`);
}

export function workspaceQcow2Path(arch?: GuestArch): string {
  return path.join(imagesDir(), `workspace${archSuffix(arch)}.qcow2`);
}

export function kernelPath(arch?: GuestArch): string {
  return path.join(imagesDir(), `vmlinuz${archSuffix(arch)}.bin`);
}

export function initrdPath(arch?: GuestArch): string {
  return path.join(imagesDir(), `initramfs${archSuffix(arch)}.bin`);
}
