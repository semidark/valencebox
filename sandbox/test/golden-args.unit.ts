// Golden-argument test: verifies the refactored buildArgs logic (which
// delegates to GuestProfile machineFor / virtioSuffix / extraCmdline) produces
// the exact same argument vector as the original inline logic for x86_64 under
// TCG (the common case on Apple Silicon without HVF).
//
// Since QemuProcess.buildArgs is private, we duplicate the *new* logic using
// the same public profile methods the real method calls, and compare against a
// hand-crafted expected vector that matches what the old inline code produced.
import { x86_64Profile, GuestProfile } from "../src/main/guest-profile";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ---- helper: re-implement buildArgs logic using profile methods ----
function buildArgsNew(
  profile: GuestProfile,
  accels: string[],
  opts: {
    memoryMB: number;
    smp: number;
    kernelCmdline?: string;
    rootImage?: string;
    workspaceImage?: string;
    sharePort?: number;
    shareToken?: string;
  },
): string[] {
  const machineType = profile.machineFor(accels[0]);
  const args: string[] = [];

  for (const a of accels) args.push("-accel", a);
  args.push(
    "-machine", machineType,
    "-m", `${opts.memoryMB}`,
    "-smp", `${opts.smp}`,
    "-nodefaults",
    "-no-user-config",
    "-nographic",
    "-no-reboot",
  );
  if (profile.cpu) args.push("-cpu", profile.cpu);

  // QMP + serial placeholders (same shape regardless of transport choice)
  args.push("-qmp", "tcp:127.0.0.1:1234,server,nowait");
  args.push("-serial", "tcp:127.0.0.1:1235,server,nowait");

  const kernel = profile.kernel;
  if (kernel) args.push("-kernel", kernel);
  const initrd = profile.initrd;
  if (initrd) args.push("-initrd", initrd);
  if (opts.kernelCmdline) {
    const extra = profile.extraCmdline(machineType);
    let cmdline = extra ? `${opts.kernelCmdline} ${extra}` : opts.kernelCmdline;
    if (opts.sharePort && opts.shareToken) {
      cmdline += ` valencebox.port=${opts.sharePort} valencebox.token=${opts.shareToken}`;
    }
    args.push("-append", cmdline);
  }

  const suffix = profile.virtioSuffix(machineType);
  const blkDev = `virtio-blk${suffix}`;
  const netDev = `virtio-net${suffix}`;
  const rngDev = `virtio-rng${suffix}`;

  if (opts.rootImage) {
    args.push(
      "-drive", `id=root,file=${opts.rootImage},format=qcow2,if=none`,
      "-device", `${blkDev},drive=root`,
    );
  }
  if (opts.workspaceImage) {
    args.push(
      "-drive", `id=ws,file=${opts.workspaceImage},format=qcow2,if=none`,
      "-device", `${blkDev},drive=ws`,
    );
  }

  args.push("-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22", "-device", `${netDev},netdev=net0`);
  args.push("-device", rngDev);

  return args;
}

// ---- expected old-vector for x86_64 under TCG ----
// Under TCG, useMicrovm = false → machine "pc", virtio-*-pci, no reboot=t.
function buildExpectedOld(
  profile: GuestProfile,
  opts: {
    memoryMB: number;
    smp: number;
    kernelCmdline?: string;
    rootImage?: string;
    workspaceImage?: string;
    sharePort?: number;
    shareToken?: string;
  },
): string[] {
  const args: string[] = [];

  const accels = ["tcg,thread=multi"];
  for (const a of accels) args.push("-accel", a);
  args.push(
    "-machine", "pc",
    "-m", `${opts.memoryMB}`,
    "-smp", `${opts.smp}`,
    "-nodefaults",
    "-no-user-config",
    "-nographic",
    "-no-reboot",
  );
  if (profile.cpu) args.push("-cpu", profile.cpu);

  args.push("-qmp", "tcp:127.0.0.1:1234,server,nowait");
  args.push("-serial", "tcp:127.0.0.1:1235,server,nowait");

  const kernel = profile.kernel;
  if (kernel) args.push("-kernel", kernel);
  const initrd = profile.initrd;
  if (initrd) args.push("-initrd", initrd);
  if (opts.kernelCmdline) {
    // old code: no extra cmdline for pc
    let cmdline = opts.kernelCmdline;
    if (opts.sharePort && opts.shareToken) {
      cmdline += ` valencebox.port=${opts.sharePort} valencebox.token=${opts.shareToken}`;
    }
    args.push("-append", cmdline);
  }

  // old code: suffix = machine === "pc" ? "-pci" : "-device"
  const suffix = "-pci";
  const blkDev = `virtio-blk${suffix}`;
  const netDev = `virtio-net${suffix}`;
  const rngDev = `virtio-rng${suffix}`;

  if (opts.rootImage) {
    args.push(
      "-drive", `id=root,file=${opts.rootImage},format=qcow2,if=none`,
      "-device", `${blkDev},drive=root`,
    );
  }
  if (opts.workspaceImage) {
    args.push(
      "-drive", `id=ws,file=${opts.workspaceImage},format=qcow2,if=none`,
      "-device", `${blkDev},drive=ws`,
    );
  }

  args.push("-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22", "-device", `${netDev},netdev=net0`);
  args.push("-device", rngDev);

  return args;
}

// ---- Tests ----

const p = x86_64Profile("/images/root.qcow2", "/images/ws.qcow2");

// Case 1: minimal invocation (no kernel/cmdline, no fw_cfg)
{
  const opts = { memoryMB: 1024, smp: 2, rootImage: p.rootImage, workspaceImage: p.workspaceImage };
  const newArgs = buildArgsNew(p, ["tcg,thread=multi"], opts);
  const oldArgs = buildExpectedOld(p, opts);
  assert(
    JSON.stringify(newArgs) === JSON.stringify(oldArgs),
    `minimal: args differ\n  new: ${JSON.stringify(newArgs)}\n  old: ${JSON.stringify(oldArgs)}`,
  );
  console.log(`✓ minimal x86_64 TCG: ${newArgs.length} args, match`);
}

// Case 2: full invocation with kernel, initrd, cmdline, share port+token
{
  const pFull = x86_64Profile(
    "/images/root.qcow2",
    "/images/ws.qcow2",
    "/images/vmlinuz-virt",
    "/images/initramfs-virt",
  );
  const opts = {
    memoryMB: 2048,
    smp: 4,
    rootImage: pFull.rootImage,
    workspaceImage: pFull.workspaceImage,
    kernelCmdline: "console=ttyS0 root=/dev/vda quiet",
    sharePort: 12345,
    shareToken: "abc123def456",
  };
  const newArgs = buildArgsNew(pFull, ["tcg,thread=multi"], opts);
  const oldArgs = buildExpectedOld(pFull, opts);
  assert(
    JSON.stringify(newArgs) === JSON.stringify(oldArgs),
    `full: args differ\n  new: ${JSON.stringify(newArgs)}\n  old: ${JSON.stringify(oldArgs)}`,
  );
  // Spot-check: -cpu must not appear (x86_64Profile has cpu = undefined)
  assert(!newArgs.includes("-cpu"), "x86_64 TCG has no -cpu flag");
  // Spot-check: -append must NOT contain reboot=t (only -pci, no microvm)
  const appendIdx = newArgs.indexOf("-append");
  assert(appendIdx !== -1, "cmdline present");
  assert(!newArgs[appendIdx + 1].includes("reboot=t"), "no reboot=t under pc");
  console.log(`✓ full x86_64 TCG: ${newArgs.length} args, match`);
}

// Case 3: no kernel, no cmdline (still works)
{
  const opts = { memoryMB: 512, smp: 1, rootImage: "/r.qcow2", workspaceImage: "/w.qcow2" };
  const newArgs = buildArgsNew(p, ["tcg,thread=multi"], opts);
  const oldArgs = buildExpectedOld(p, opts);
  assert(
    JSON.stringify(newArgs) === JSON.stringify(oldArgs),
    `no-kernel: args differ\n  new: ${JSON.stringify(newArgs)}\n  old: ${JSON.stringify(oldArgs)}`,
  );
  assert(!newArgs.includes("-append"), "no -append without kernelCmdline");
  assert(!newArgs.includes("-kernel"), "no -kernel without kernel");
  assert(!newArgs.includes("-initrd"), "no -initrd without initrd");
  console.log(`✓ no-kernel x86_64 TCG: ${newArgs.length} args, match`);
}

console.log("ALL GOLDEN ARGS TESTS PASSED");
