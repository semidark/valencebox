// TODO: remove — ad-hoc/manual validation script only, NOT part of the
// permanent test suite (not wired into package.json). Boots a real VM,
// hydrates a large synthetic workspace, and reports host RSS + hda/hdb
// block_cache sizes before/after, to empirically confirm the bounded-cache
// patch (semidark/v86#1) keeps host memory from growing unboundedly with
// hydration volume. Run manually with:
//   node --expose-gc -r tsx/cjs test/memcheck.adhoc.ts
import * as fs from "fs";
import * as path from "path";
import { SyncManager } from "../src/main/sync-manager";
import { bootAndLogin } from "./util";

const SCRATCH = process.env.SCRATCH ?? "/tmp";
const HOST_WS = path.join(SCRATCH, `memcheck-hostws-${process.pid}`);

function prand(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

function makeLargeTree(targetBytes: number): { files: number; bytes: number } {
  fs.rmSync(HOST_WS, { recursive: true, force: true });
  fs.mkdirSync(HOST_WS, { recursive: true });
  let files = 0;
  let bytes = 0;
  let seed = 1;
  while (bytes < targetBytes) {
    const size = 50_000 + (seed % 150_000); // 50-200KB files, mimics node_modules
    const rel = `vendor/pkg-${Math.floor(files / 40)}/file-${files}.bin`;
    const abs = path.join(HOST_WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, prand(size, seed));
    files++;
    bytes += size;
    seed++;
  }
  return { files, bytes };
}

function rssMB(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

function cacheStats(vm: any): { hda: number; hdb: number } {
  const ide = vm.emulator?.v86?.cpu?.devices?.ide;
  const hda = ide?.primary?.master?.buffer?.block_cache?.size ?? -1;
  const hdb = ide?.primary?.slave?.buffer?.block_cache?.size ?? -1;
  return { hda, hdb };
}

(async () => {
  const { files, bytes } = makeLargeTree(200 * 1024 * 1024); // ~200MB synthetic workspace
  console.log(`host tree: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);

  console.log("RSS before boot:", rssMB(), "MB");
  const t = await bootAndLogin();
  console.log("RSS after boot (before hydrate):", rssMB(), "MB", cacheStats(t.vm));

  const sync = new SyncManager(t.bridge, HOST_WS, {});
  const hydrateStart = Date.now();
  await sync.hydrate();
  console.log(`hydrated in ${((Date.now() - hydrateStart) / 1000).toFixed(1)}s`);

  console.log("RSS immediately after hydrate:", rssMB(), "MB", cacheStats(t.vm));
  console.log(
    "hdb block_cache bytes:",
    (cacheStats(t.vm).hdb * 256) / 1024 / 1024,
    "MB (cap should be 128MB per vm.ts)"
  );

  // Proactively flush, as sandbox.ts now does after hydrate() completes.
  const flushStart = Date.now();
  await t.vm.flushDisks();
  console.log(`flushDisks took ${((Date.now() - flushStart) / 1000).toFixed(1)}s`);
  await new Promise((r) => setTimeout(r, 500));

  console.log("RSS after flushDisks():", rssMB(), "MB", cacheStats(t.vm));

  if (global.gc) {
    global.gc();
    console.log("RSS after manual gc():", rssMB(), "MB");
  }

  t.vm.stop();
  fs.rmSync(HOST_WS, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
