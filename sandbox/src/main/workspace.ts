import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { SandboxAppConfig } from "../config";

export function resolveWorkspaceDir(cfg: SandboxAppConfig, userDataDir: string): string {
  if (cfg.workspaceDir) return cfg.workspaceDir;
  if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR;
  const workspace = path.join(userDataDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

/** Never recurse into a workspace, including one left by an older app version. */
export async function cleanupRuntimeDir(tmpDir: string): Promise<void> {
  const runtimeFiles = ["serial.sock", "qmp.sock", "pty.sock", "share-config.json", "mitm-ca.pem"];
  await Promise.all(runtimeFiles.map(async (name) => {
    try { await fsp.unlink(path.join(tmpDir, name)); }
    catch (err: any) { if (err.code !== "ENOENT") throw err; }
  }));
  try {
    await fsp.rmdir(tmpDir);
  } catch (err: any) {
    if (err.code === "ENOTEMPTY" || err.code === "EEXIST") {
      console.log(`[shutdown] retained nonempty runtime directory: ${tmpDir}`);
    } else if (err.code !== "ENOENT") {
      throw err;
    }
  }
}
