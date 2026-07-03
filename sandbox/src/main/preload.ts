import { contextBridge, ipcRenderer } from "electron";
import { IPC, SandboxStatus, ConflictRecordDTO } from "../shared/ipc";

contextBridge.exposeInMainWorld("sandbox", {
  getStatus: (): Promise<SandboxStatus> => ipcRenderer.invoke(IPC.getStatus),
  saveSnapshot: (): Promise<void> => ipcRenderer.invoke(IPC.saveSnapshot),
  runCommand: (cmd: string): Promise<void> => ipcRenderer.invoke(IPC.runCommand, cmd),
  onStatus: (cb: (s: SandboxStatus) => void) =>
    ipcRenderer.on(IPC.onStatus, (_e, s) => cb(s)),
  onSerial: (cb: (chunk: string) => void) =>
    ipcRenderer.on(IPC.onSerial, (_e, c) => cb(c)),
  onConflict: (cb: (c: ConflictRecordDTO) => void) =>
    ipcRenderer.on(IPC.onConflict, (_e, c) => cb(c)),
});
