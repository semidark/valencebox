# Switch from env86 to a v86 fork (bounded disk-cache patch)

## Background

`npm run images` sources four v86 runtime assets (`libv86.js`, `v86.wasm`,
`seabios.bin`, `vgabios.bin`) from the `env86/` git submodule
([progrium/env86](https://github.com/progrium/env86)). Investigation into
unbounded host-memory growth (a 512MB-configured VM using 2.5GB+ of host RAM
after workspace hydration) traced the root cause to upstream
[`copy/v86`](https://github.com/copy/v86)'s `AsyncXHRBuffer.block_cache`: an
in-memory `Map` that caches every disk block ever read or written to
`hda`/`hdb`, with **no eviction of any kind**. For a long-running Electron
host backing a real local disk-image file (as opposed to v86's typical
browser/remote-URL use case), this cache grows forever with cumulative guest
disk I/O — most visibly during the initial workspace hydration, which can
write hundreds of MB into `hdb` in one pass.

Also discovered along the way: `env86` itself is barely used. The only thing
`sandbox/scripts/build-guest.sh` takes from it is those four static v86
assets — the kernel/initramfs, the guest sync-agent, and env86's own Go CLI
are all unrelated/unused parts of the product. `env86` hasn't been updated
in ~2 years, whereas `copy/v86` is actively maintained. Since we need to
patch v86 anyway, the plan is to fork `copy/v86`, carry the memory-bound
patch there, and stop depending on `env86` for anything.

This also needs to land on top of the separate Go→Rust sync-agent rewrite
that has since been merged into `main` — that rewrite touched
`sandbox/guest/`, `sandbox/scripts/build-guest.sh` (added Go/Rust switching
via `AGENT=`), and various host-side sync files, but did **not** touch v86
asset sourcing (`env86/` usage is untouched by it).

## Fork patch: bounded `AsyncXHRBuffer.block_cache`

Repo: [`semidark/v86`](https://github.com/semidark/v86) (forked from
`copy/v86`), branch `feature/bounded-async-disk-cache`,
[PR #1](https://github.com/semidark/v86/pull/1).

Change, in `src/buffer.js` (+ a small Node-only addition to `src/lib.js`):

- New optional `max_cache_bytes` param on `AsyncXHRBuffer` (wired through
  `buffer_from_object({ ..., max_cache_bytes })`). `undefined` by default —
  100% unchanged behavior for existing/browser callers.
- `block_cache`'s `Map` insertion order is (ab)used as LRU order: every
  cache hit deletes+re-inserts the entry, so the front of the map is always
  the least-recently-used block.
- Once `max_cache_bytes` is exceeded, a background eviction pass runs:
  clean (never-written) entries are dropped for free; dirty entries are
  first written back to the backing file (new `write_file_ranges` in
  `lib.js`, Node-only, `fs.promises.open(filename, "r+")` + positional
  `write()`) so a later cache miss reads correct (not stale) data.
- **Writes must be coalesced.** A hydration burst can touch hundreds of
  thousands of 256-byte blocks; writing them back one syscall at a time
  does not scale (empirically: ~22s to flush a 200MB write burst). Adjacent
  dirty block indices are merged into single larger `{start, data}` writes
  before calling `write_file_ranges` (this was lost from a previous
  session's scratch directory and needs to be re-implemented — see
  Execution Log).
- `AsyncXHRBuffer.prototype.flush()`: proactively write back all dirty
  blocks and drop the whole cache, independent of the size threshold.
  `V86.prototype.flush_disks()` exposes this for `hda`/`hdb` through the
  public API.
- Test: `tests/api/bounded-disk-cache.js` (buffer.js-level, no VM boot) —
  default-is-unbounded, bounded cache stays near cap + writes survive
  eviction/flush durably, and a performance regression guard for the
  coalescing fix.

## tab-microvm-side changes

1. **Remove `env86` submodule** entirely (deinit, `git rm`, drop
   `.gitmodules` entry). Also remove the dead `AGENT=(rust|go)` switch in
   `sandbox/scripts/build-guest.sh` and `sandbox/guest/Dockerfile` — the Go
   sync-agent source no longer exists in the repo (removed by the Rust
   rewrite), so `AGENT=go` is unreachable dead code/an artefact to delete,
   not preserve.
2. **Add `v86` submodule** at repo root, pointing to `semidark/v86`,
   pinned to the (corrected, coalescing-fixed) `feature/bounded-async-disk-cache`
   commit.
3. **Add root-level build tooling**: `scripts/Dockerfile.v86` (adapted from
   `env86/scripts/Dockerfile.v86`, but building the local submodule checkout
   instead of cloning upstream fresh) + `scripts/build-v86.sh`, producing
   `build/v86/{libv86.js,v86.wasm,seabios.bin,vgabios.bin}`.
4. **Update `sandbox/scripts/build-guest.sh`**: source v86 assets from
   `../build/v86` instead of `../env86/assets`; drop the Go agent branch
   entirely (Rust-only, no `AGENT` env var).
5. **Update `sandbox/guest/Dockerfile`**: drop `ARG AGENT` and the
   Go/Rust `chmod` branch — always install `blake2sum` alongside
   `sync-agent`.
6. **Wire the new v86 API into the app**:
   - `sandbox/src/main/vm.ts`: `HDA_MAX_CACHE_BYTES` (32MB, boot-reads-mostly)
     / `HDB_MAX_CACHE_BYTES` (128MB, absorbs hydration+ongoing writes)
     passed as `max_cache_bytes` on the `hda`/`hdb` config; new
     `SandboxVM.flushDisks()` wrapping `emulator.flush_disks()`
     (best-effort, never throws).
   - `sandbox/src/main/sandbox.ts`: call `flushDisks()` right after both
     `hydrate()` call sites (cold boot and post-restore reconcile).
   - `sandbox/src/main/snapshot.ts`: call `flushDisks()` in `save()`'s
     `finally` block (already only runs after idle — a good proactive
     reclaim point).
7. **Docs**: update `AGENTS.md`, root `README.md`, `sandbox/README.md`,
   `sandbox/THIRD_PARTY_LICENSES.md` to describe the `v86` submodule/fork
   instead of `env86`, and drop the Go-agent mentions that survived the
   rewrite's doc pass.
8. **Validation script**: `sandbox/test/memcheck.adhoc.ts` (boots a real
   VM, hydrates a large synthetic workspace, reports host RSS + block_cache
   sizes before/after) is kept as a manual tool per explicit request, not
   wired into `package.json` — marked with a `// TODO: remove` comment.
9. **Rebuild + validate**: `npm run images`, `npm run build`, full test
   suite (`test:unit`, `test:agent`, `test:boot`, `test:sync`,
   `test:snapshot`, `test:net`, `test:dataplane`, `test:e2e`), plus a fresh
   run of the empirical memory-growth check.
10. Push a branch, open a PR against `semidark/valencebox` `main`.

## Execution log

- [x] Investigated root cause (block_cache unbounded growth), confirmed via
      empirical RSS measurement during a synthetic 200MB hydration.
- [x] Confirmed upstream `copy/v86` has the same issue, unaddressed.
- [x] Forked to `semidark/v86`, patched `src/buffer.js`/`lib.js`, opened
      PR #1 with the base (non-coalesced) fix.
- [x] Discovered upstream `main` had been rewritten (Go→Rust sync-agent,
      2 merged PRs) since the original local clone; reconciled by resetting
      local `main` onto `origin/main` (content-identical through the shared
      ancestor, confirmed via tree-hash comparison — no work lost).
- [x] Discovered the coalescing performance fix (contiguous-block write
      merging, fixing a 22s→0.3s flush-time regression) was made in a
      since-vanished scratch directory and never pushed; confirmed via
      decompiling the one surviving compiled `libv86.js` artifact that it
      predates the coalescing fix (only has the naive per-block-write
      eviction/flush).
- [x] Re-implemented `coalesce_writes`/`finish_run` in the fork, re-added the
      performance regression test (`tests/api/bounded-disk-cache.js`),
      rebuilt via Docker (0 errors/warnings), re-verified (200MB write+flush
      dropped from ~22s to well under a second; scattered-write stress case
      also stays fast), pushed, updated PR #1 description.
- [x] PR #1 merged into `semidark/v86` `master` (`901003d1`).
- [x] Reconciled local `main` onto `origin/main`, created
      `feature/switch-to-v86-fork` branch off it.
- [x] Removed `env86` submodule; added `v86` submodule pinned to the merged
      `master` commit (`901003d1`, confirmed contains `coalesce_writes`).
- [x] Added `scripts/Dockerfile.v86` + `scripts/build-v86.sh`; verified a
      full `npm`-independent Docker build produces working
      `build/v86/{libv86.js,v86.wasm,seabios.bin,vgabios.bin}` with the
      patch present.
- [x] Updated `build-guest.sh` + `guest/Dockerfile`: dropped the dead
      `AGENT=(rust|go)` switch entirely (Go sync-agent source no longer
      exists in the repo), sources v86 assets from `build/v86` instead of
      `env86/assets`.
- [x] Wired `max_cache_bytes`/`flushDisks()` into
      `vm.ts`/`sandbox.ts`/`snapshot.ts` — applied as minimal, additive
      diffs on top of the Rust-rewrite versions of those files (verified
      clean, non-conflicting diffs before applying).
- [x] Updated docs (`AGENTS.md`, root `README.md`, `sandbox/README.md`,
      `THIRD_PARTY_LICENSES.md`) — replaced `env86` bootstrap/attribution
      with `v86` fork instructions, removed stale Go-agent mentions,
      documented the disk-cache bound behavior.
- [x] Full test suite run surfaced two **pre-existing bugs unrelated to
      this change** (confirmed by reproducing both with `max_cache_bytes`
      completely disabled, i.e. identical to old unbounded upstream v86
      behavior):
      1. `sandbox/guest/sync-agent-rust/src/bin/blake2sum.rs` only read
         stdin and ignored its file-path argument, hanging forever on
         `blake2sum /workspace/<file>` — introduced when the file was
         recreated from scratch in the just-merged Rust rewrite (commit
         `188e2f8`, "was untracked, accidentally deleted"). **Fixed** as
         part of this branch (added `env::args().nth(1)` file-argument
         handling, matching the streaming/format style already used in
         `manifest.rs`/`state.rs`) since it fully blocked test validation.
      2. A real correctness bug in the LWW conflict resolver
         (`sandbox/src/main/sync-manager.ts:808-830`) wrongly favors a
         stale host copy over a legitimate guest write, then leaves the
         host file truncated to 0 bytes with no repair. **Not fixed** —
         filed as
         [semidark/valencebox#3](https://github.com/semidark/valencebox/issues/3)
         with full root-cause trace for a dedicated fix; `test:sync`'s
         "large guest→host push" step fails consistently until that's
         resolved, everything before/around it passes.
- [x] Full test suite pass (`test:unit`, `test:boot`, `test:snapshot`,
      `test:net`, `test:dataplane`, `test:e2e`, `test:ui` all green;
      `test:sync` green up to the pre-existing bug above; `test:agent`
      skipped — no local `cargo`, only built inside Docker by
      `build-guest.sh`).
- [x] Re-ran the empirical 200MB-hydration memory validation
      (`sandbox/test/memcheck.adhoc.ts`) with the corrected (coalesced)
      fork, both bounded and unbounded (`max_cache_bytes` temporarily
      removed) for a direct comparison:
      - **Unbounded** (old behavior): `hdb` block_cache grows to
        827,168 blocks (~202 MB, i.e. the *entire* hydration volume);
        peak RSS 1963 MB even after `flushDisks()`.
      - **Bounded** (this patch, 128 MB cap on `hdb`): cache self-evicts
        during hydration itself, settling at 500,563 blocks
        (~122 MB, under the cap); peak RSS 1494 MB — ~470 MB lower.
      - `flushDisks()` completes in ~1.1-1.2s in both cases (vs. the
        ~22s the pre-coalescing naive per-block-write version took),
        confirming the coalescing fix holds under real hydration traffic,
        not just the synthetic buffer.js-level test.
- [ ] Push branch, open PR against `semidark/valencebox`.
