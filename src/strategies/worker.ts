import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MetricsCollector } from "../metrics.js";
import type { BenchmarkMetrics, StrategyResult } from "./types.js";

interface WorkerMessage {
  type: "result" | "error";
  recordCount?: number;
  metrics?: BenchmarkMetrics;
  error?: string;
}

function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Pick the worker entry from how *this* module was loaded
  // Under tsx the source tree is live and this file loads as
  // `.ts`, so spawn the .mjs bootstrap: it registers tsx's ESM loader inside
  // the worker thread, then imports `worker-thread.ts`. Going straight to the
  // .ts file doesn't work because `--import tsx` in execArgv is a startup-only
  // flag and the loader hook isn't honored in spawned worker threads.
  // After `tsc` build this file loads as `.js`, so spawn the compiled worker.
  if (import.meta.url.endsWith(".ts")) {
    return resolve(here, "worker-bootstrap.mjs");
  }
  return resolve(here, "worker-thread.js");
}

export async function runWorker(filePath: string): Promise<StrategyResult> {
  const metrics = new MetricsCollector();
  metrics.startSampling();
  metrics.markStart("total");

  return new Promise<StrategyResult>((resolvePromise) => {
    const worker = new Worker(resolveWorkerPath(), { workerData: { filePath } });

    let settled = false;
    // Ends timing, then builds the result so getMetrics() sees the final marks.
    const finish = (build: () => StrategyResult): void => {
      if (settled) return;
      settled = true;
      metrics.markEnd("total");
      metrics.stopSampling();
      resolvePromise(build());
      void worker.terminate();
    };

    worker.on("message", (msg: WorkerMessage) => {
      if (msg.metrics) {
        // Merge the worker thread's peak memory into the main-thread collector
        // so the returned metrics reflect the worker's heap, not just main's.
        metrics.mergePeakMemory(msg.metrics.peakHeapUsedBytes, msg.metrics.peakRssBytes);
      }

      if (msg.type === "error" || !msg.metrics) {
        finish(() => ({
          records: [],
          recordCount: msg.recordCount ?? 0,
          metrics: metrics.getMetrics(),
          error: msg.error ?? "worker returned no result",
        }));
        return;
      }

      const workerMetrics = msg.metrics;
      finish(() => ({
        records: [],
        recordCount: msg.recordCount ?? 0,
        metrics: {
          ...metrics.getMetrics(),
          parseOnlyMs: workerMetrics.parseOnlyMs,
          cpuUserMs: workerMetrics.cpuUserMs,
          cpuSystemMs: workerMetrics.cpuSystemMs,
        },
      }));
    });

    worker.on("error", (err) => {
      finish(() => ({
        records: [],
        recordCount: 0,
        metrics: metrics.getMetrics(),
        error: err.message,
      }));
    });
  });
}
