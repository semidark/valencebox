import { SandboxVM, VMOptions } from "../src/main/vm";
import { HostBridge } from "../src/main/bridge";
import { Frame } from "../src/shared/protocol";

export interface TestVM {
  vm: SandboxVM;
  bridge: HostBridge;
  hello: Frame;
  /** run a shell command via serial root session and wait for a pattern */
  run: (cmd: string, expect: RegExp, timeout?: number) => Promise<string>;
}

export async function bootAndLogin(
  opts: VMOptions = {},
  extras: { helloExtra?: Record<string, unknown> } = {}
): Promise<TestVM> {
  const vm = new SandboxVM({
    memoryMB: 512,
    onSerial: process.env.VERBOSE ? (t) => process.stdout.write(t) : undefined,
    ...opts,
  });
  await vm.start();
  const bridge = new HostBridge(vm);
  if (extras.helloExtra) bridge.helloExtra = extras.helloExtra;
  const helloP = bridge.waitGuestHello(120000);

  await vm.waitSerial(/login:/, 120000);
  let mark = vm.serialLog.length;
  vm.serialWrite("root\n");
  await vm.waitSerial(/Password:/, 15000, mark);
  vm.serialWrite("root\n");
  await vm.waitSerial(/:~#/, 15000, mark);

  const hello = await helloP;

  const run = async (cmd: string, expect: RegExp, timeout = 30000) => {
    mark = vm.serialLog.length;
    vm.serialWrite(cmd + "\n");
    return await vm.waitSerial(expect, timeout, mark);
  };

  return { vm, bridge, hello, run };
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
