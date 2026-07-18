import { contextBridge, ipcRenderer } from "electron";
import { IPC, SandboxStatus, ConflictRecordDTO, BalloonStatus } from "../shared/ipc";

contextBridge.exposeInMainWorld("sandbox", {
  getStatus: (): Promise<SandboxStatus> => ipcRenderer.invoke(IPC.getStatus),
  saveSnapshot: (): Promise<void> => ipcRenderer.invoke(IPC.saveSnapshot),
  sendInput: (data: string): void => ipcRenderer.send(IPC.serialInput, data),
  onStatus: (cb: (s: SandboxStatus) => void) =>
    ipcRenderer.on(IPC.onStatus, (_e, s) => cb(s)),
  onSerial: (cb: (chunk: string) => void) =>
    ipcRenderer.on(IPC.onSerial, (_e, c) => cb(c)),
  onConflict: (cb: (c: ConflictRecordDTO) => void) =>
    ipcRenderer.on(IPC.onConflict, (_e, c) => cb(c)),
  // PTY terminal
  onPtyData: (cb: (chunk: Uint8Array) => void) =>
    ipcRenderer.on(IPC.onPtyData, (_e, chunk: Uint8Array) => cb(chunk)),
  onPtyClosed: (cb: () => void) =>
    ipcRenderer.on(IPC.onPtyClosed, () => cb()),
  sendPtyInput: (data: Uint8Array): void =>
    ipcRenderer.send(IPC.ptyInput, data),
  sendPtyResize: (cols: number, rows: number): void =>
    ipcRenderer.send(IPC.ptyResize, cols, rows),
  // Memory balloon
  setBalloon: (mb: number): Promise<void> => ipcRenderer.invoke(IPC.setBalloon, mb),
  getBalloon: (): Promise<BalloonStatus | null> => ipcRenderer.invoke(IPC.getBalloon),
});
