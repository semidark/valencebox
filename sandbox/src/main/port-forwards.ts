// Host-side TCP port forwards for strict network mode. Replaces SLIRP
// hostfwd: each forward is a host listener whose connections are bridged over
// mux streams (OPEN "fwd:<guestPort>") to the guest's loopback service.

import * as net from "net";
import { PortForward } from "../config";
import { MuxChannel } from "./mux-channel";

export interface PortForwardHandle {
  close(): void;
}

export function startTcpPortForwards(mux: MuxChannel, forwards: PortForward[]): PortForwardHandle {
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();

  for (const fwd of forwards) {
    if ((fwd.protocol ?? "tcp") !== "tcp") {
      // Config validation rejects UDP forwards in strict mode; this is a
      // belt-and-suspenders skip for direct callers.
      console.warn(`[port-forwards] skipping non-TCP forward ${fwd.hostPort}→${fwd.guestPort}`);
      continue;
    }
    const bindIp = fwd.hostIp ?? "127.0.0.1";
    const label = fwd.label ?? `${bindIp}:${fwd.hostPort}→guest:${fwd.guestPort}`;
    const srv = net.createServer((sock) => {
      sockets.add(sock);
      sock.once("close", () => sockets.delete(sock));
      mux.openStream(`fwd:${fwd.guestPort}`).then((stream) => {
        if (sock.destroyed) {
          stream.destroy();
          return;
        }
        stream.on("error", () => sock.destroy());
        sock.on("error", () => stream.destroy());
        sock.on("close", () => stream.destroy());
        stream.on("close", () => sock.destroy());
        stream.pipe(sock);
        sock.pipe(stream);
      }).catch((err) => {
        console.warn(`[port-forwards] ${label}: stream open failed: ${err.message}`);
        sock.destroy();
      });
    });
    srv.on("error", (err) => console.error(`[port-forwards] ${label}: ${err.message}`));
    srv.listen(fwd.hostPort, bindIp, () => {
      console.log(`[port-forwards] ${label} listening`);
    });
    servers.push(srv);
  }

  return {
    close() {
      for (const s of servers) s.close();
      for (const s of sockets) s.destroy();
    },
  };
}
