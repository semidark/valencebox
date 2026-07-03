// Regression test for a real bug: on a real cold boot, the data plane's
// connection races the console login handshake and doesn't always win
// (see Sandbox.waitDataPlane). hydrate() must therefore pick up a data
// channel that attaches *after* hydrate has already started, not just one
// attached beforehand — which is all the VM-based dataplane.test.ts covers.
//
// This is VM-free and fast: a "fake guest" auto-acks over the real framing
// code (FrameChannel/FrameParser/encodeFrame), so no v86 boot is needed.
import * as fs from "fs";
import * as path from "path";
import { FrameChannel } from "../src/main/bridge";
import { SyncManager } from "../src/main/sync-manager";
import { FrameType, FrameParser, encodeFrame } from "../src/shared/protocol";
import { assert } from "./util";

const HOST_WS = path.join(process.env.SCRATCH ?? "/tmp", `chswitch-${process.pid}`);

/** A minimal in-process "guest" that auto-ACKs FILE_PUT/TREE_PUT/FILE_CHUNK
 *  frames sent to it, so pushFile/pushTree resolve without a real VM. */
function makeFakeGuestChannel(label: string, calls: string[]): FrameChannel {
  const parser = new FrameParser();
  const xferSize = new Map<number, number>();
  const xferReceived = new Map<number, number>();
  let ch: FrameChannel;
  const ack = (seq: number, body: Record<string, unknown>) =>
    ch.feed(encodeFrame(FrameType.ACK, 1, Buffer.from(JSON.stringify({ ack: seq, ...body }))));
  const doneAck = (seq: number, xfer: number, extra: Record<string, unknown> = {}) =>
    ack(seq, { xfer, done: true, ...extra });
  const guestWrite = (buf: Buffer) => {
    for (const f of parser.push(buf)) {
      if (f.type === FrameType.FILE_PUT) {
        calls.push(`${label}:FILE_PUT`);
        const meta = JSON.parse(f.payload.toString("utf8"));
        xferSize.set(meta.xfer, meta.size);
        xferReceived.set(meta.xfer, 0);
        if (meta.size === 0) doneAck(f.seq, meta.xfer);
        // plain ready-ack (no done/received field): the console path needs
        // this to start pumping chunks (see sync-manager.ts pushFile). The
        // data-plane path ignores it (already pumping optimistically), so
        // sending it unconditionally is harmless regardless of which
        // channel a given push actually lands on.
        else ack(f.seq, { xfer: meta.xfer });
      } else if (f.type === FrameType.TREE_PUT) {
        calls.push(`${label}:TREE_PUT`);
        const meta = JSON.parse(f.payload.toString("utf8"));
        xferSize.set(meta.xfer, meta.size);
        xferReceived.set(meta.xfer, 0);
        if (meta.size === 0) doneAck(f.seq, meta.xfer, { skipped: [] });
      } else if (f.type === FrameType.FILE_CHUNK) {
        const xfer = f.payload.readUInt32LE(0);
        const got = (xferReceived.get(xfer) ?? 0) + (f.payload.length - 12);
        xferReceived.set(xfer, got);
        const total = xferSize.get(xfer) ?? 0;
        if (got >= total) doneAck(f.seq, xfer, { skipped: [] });
      }
      // MANIFEST/FILE_DEL: not exercised by this test, ignored
    }
  };
  ch = new FrameChannel(guestWrite);
  return ch;
}

async function main() {
  fs.rmSync(HOST_WS, { recursive: true, force: true });
  fs.mkdirSync(HOST_WS, { recursive: true });
  const N = 20;
  for (let i = 0; i < N; i++) fs.writeFileSync(path.join(HOST_WS, `f${i}.txt`), `hello ${i}\n`);

  const calls: string[] = [];
  const consoleCh = makeFakeGuestChannel("console", calls);
  const dataCh = makeFakeGuestChannel("data", calls);

  // expectDataChannel:true (as Sandbox passes whenever networking is
  // enabled) sizes the worker pool for the fast path up front — matches
  // production wiring, where the data plane may connect a few seconds
  // into hydrate rather than being ready before it starts.
  const sync = new SyncManager(consoleCh, HOST_WS, { expectDataChannel: true });

  // Don't await: hydrate() runs synchronously up to its first real await
  // (each worker's first claim() + job() happens before this call returns
  // control here), then suspends. Attaching the data channel on the very
  // next line lands after that first synchronous wave but before any
  // microtask-driven continuation — so some early files land on the
  // console (claimed before the switch) and the rest land on the newly
  // attached data channel, batched via TREE_PUT. That's the exact
  // real-world timing this test exists to cover.
  const hydrateP = sync.hydrate();
  sync.attachDataChannel(dataCh);
  await hydrateP;

  await sync.stop();

  const consolePuts = calls.filter((c) => c === "console:FILE_PUT").length;
  const dataTreePuts = calls.filter((c) => c === "data:TREE_PUT").length;
  const consoleTreePuts = calls.filter((c) => c === "console:TREE_PUT").length;

  // Note: pushFile/pushTree pick their channel via txChannel() *after* an
  // async gap (fsp.stat), so exactly how many claims land on console before
  // the switch is inherently timing-dependent — even claims made before
  // attachDataChannel() can end up sending their bytes over the new data
  // channel if it attaches during that gap. That's fine (more work benefits
  // from the fast path, not less); this test only asserts the properties
  // that must hold regardless of that timing.
  assert(dataTreePuts > 0, `files claimed after the switch were batched over the data channel (got ${dataTreePuts})`);
  assert(consoleTreePuts === 0, `TREE_PUT must never be sent over the console (got ${consoleTreePuts})`);
  assert(sync.stats.pushed === N, `all ${N} files pushed exactly once (got ${sync.stats.pushed})`);

  console.log(
    `✓ mid-hydrate channel switch: ${consolePuts} individual push(es) over console, ` +
      `${dataTreePuts} TREE_PUT batch(es) over data channel after it attached`
  );
  console.log("ALL HYDRATE CHANNEL SWITCH TESTS PASSED");
  fs.rmSync(HOST_WS, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
