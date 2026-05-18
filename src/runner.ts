import { runStream } from "./strategies/stream.js";
import { runMemory } from "./strategies/memory.js";
import { runWorker } from "./strategies/worker.js";
import type { StrategyName, StrategyResult } from "./strategies/types.js";

interface RunRequest {
  filePath: string;
  strategy: StrategyName;
}

async function dispatch(req: RunRequest): Promise<StrategyResult> {
  switch (req.strategy) {
    case "stream":
      return runStream(req.filePath);
    case "memory":
      return runMemory(req.filePath);
    case "worker":
      return runWorker(req.filePath);
  }
}

process.on("message", async (msg: RunRequest) => {
  // Best-effort allocator settle: GC + short pause before measuring.
  if (typeof global.gc === "function") {
    global.gc();
  }
  await new Promise((r) => setTimeout(r, 5000));

  try {
    const result = await dispatch(msg);
    // Records can be large; strip them before sending back. The benchmark only
    // needs the count + metrics, not the parsed payload itself.
    process.send?.({
      ok: true,
      recordCount: result.recordCount ?? result.records.length,
      metrics: result.metrics,
      error: result.error,
    });
  } catch (err) {
    process.send?.({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Give IPC a tick to flush, then exit so the parent can fork the next run
    // with a clean heap.
    setTimeout(() => process.exit(0), 50);
  }
});
