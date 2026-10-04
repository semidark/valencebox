export interface ShutdownStage {
  name: string;
  timeoutMs: number;
  stop: () => Promise<void>;
}

/** Bounds an asynchronous operation without leaving a live timeout behind. */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One shutdown per app lifetime; repeated quit requests never bypass cleanup. */
export class ShutdownCoordinator {
  private completion: Promise<void> | null = null;

  constructor(
    private stages: ShutdownStage[],
    private exit: (code: number) => void,
    private forceStop: () => void,
    private deadlineMs = 40_000,
  ) {}

  request(): Promise<void> {
    if (!this.completion) this.completion = this.run();
    return this.completion;
  }

  private async run(): Promise<void> {
    const startedAt = Date.now();
    let exited = false;
    let deadlineReject: (err: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { deadlineReject = reject; });
    const finish = (code: number) => {
      if (exited) return;
      exited = true;
      console.log(`[shutdown] finished after ${Date.now() - startedAt}ms (exit=${code})`);
      this.exit(code);
    };
    const watchdog = setTimeout(() => {
      console.error(`[shutdown] overall deadline reached (${this.deadlineMs}ms)`);
      try { this.forceStop(); }
      catch (err) { console.error("[shutdown] emergency stop failed:", err); }
      finish(1);
      deadlineReject(new Error("Shutdown deadline reached"));
    }, this.deadlineMs);

    let failed = false;
    try {
      for (const stage of this.stages) {
        if (exited) break;
        const stageStart = Date.now();
        console.log(`[shutdown] ${stage.name}: starting`);
        try {
          await withTimeout(Promise.race([Promise.resolve().then(stage.stop), deadline]), stage.timeoutMs, stage.name);
          console.log(`[shutdown] ${stage.name}: complete (${Date.now() - stageStart}ms)`);
        } catch (err) {
          if (exited) break;
          failed = true;
          console.error(`[shutdown] ${stage.name}: failed (${Date.now() - stageStart}ms)`, err);
        }
      }
      finish(failed ? 1 : 0);
    } finally {
      clearTimeout(watchdog);
    }
  }
}
