import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { WARCParser } from "warcio";
import { MetricsCollector } from "../metrics.js";
import type { ParsedRecord, StrategyResult } from "./types.js";
import { extractRecord } from "./stream.js";

export async function runMemory(filePath: string): Promise<StrategyResult> {
  const metrics = new MetricsCollector();
  const records: ParsedRecord[] = [];

  metrics.startSampling();
  metrics.markStart("total");

  try {
    const buffer = await readFile(filePath);

    metrics.markStart("parse");

    // Wrap the buffer in a Readable so WARCParser can consume it like a stream.
    // Yielding once keeps the buffer fully resident, which is the point of this strategy.
    const stream = Readable.from((async function* () {
      yield buffer;
    })());

    const parser = new WARCParser(stream);
    for await (const record of parser) {
      records.push(extractRecord(record));
    }

    metrics.markEnd("parse");
    metrics.markEnd("total");
    metrics.stopSampling();

    return { records, metrics: metrics.getMetrics() };
  } catch (err) {
    metrics.markEnd("parse");
    metrics.markEnd("total");
    metrics.stopSampling();
    return {
      records,
      metrics: metrics.getMetrics(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
