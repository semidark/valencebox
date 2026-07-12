import * as fs from "fs";
import * as path from "path";

function rootDir(): string {
  return path.resolve(__dirname, "..", "..");
}

function resourceDir(): string {
  return path.join(rootDir(), "resources");
}

function qemuPlatformDir(): string {
  return path.join(resourceDir(), "qemu", process.platform);
}

export function qemuBinaryPath(): string {
  const bundled = path.join(qemuPlatformDir(), "qemu-system-x86_64");
  if (fs.existsSync(bundled)) return bundled;
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

export function serialSockPath(tmpDir: string): string {
  return path.join(tmpDir, "serial.sock");
}

export function qmpSockPath(tmpDir: string): string {
  return path.join(tmpDir, "qmp.sock");
}

export function rootQcow2Path(): string {
  return path.join(imagesDir(), "root.qcow2");
}

export function workspaceQcow2Path(): string {
  return path.join(imagesDir(), "workspace.qcow2");
}
