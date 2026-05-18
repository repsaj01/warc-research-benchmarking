import { parentPort, workerData } from "node:worker_threads";
import { createReadStream } from "node:fs";
import { WARCParser } from "warcio";
import { MetricsCollector } from "../metrics.js";
import { extractRecord } from "./stream.js";

if (!parentPort) {
  throw new Error("worker-thread.ts must be run inside a Worker");
}

const port = parentPort;
const { filePath } = workerData as { filePath: string };

async function run(): Promise<void> {
  const metrics = new MetricsCollector();
  let recordCount = 0;

  metrics.startSampling();
  metrics.markStart("total");
  metrics.markStart("parse");

  try {
    const stream = createReadStream(filePath);
    const parser = new WARCParser(stream);
    for await (const record of parser) {
      // Extract per record so the parsing workload matches the other
      // strategies, but discard the result immediately — the worker is the
      // streaming parse offloaded to a thread, so it must not retain records.
      extractRecord(record);
      recordCount++;
    }

    metrics.markEnd("parse");
    metrics.markEnd("total");
    metrics.stopSampling();

    port.postMessage({
      type: "result",
      recordCount,
      metrics: metrics.getMetrics(),
    });
  } catch (err) {
    metrics.markEnd("parse");
    metrics.markEnd("total");
    metrics.stopSampling();

    port.postMessage({
      type: "error",
      recordCount,
      metrics: metrics.getMetrics(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

void run();
