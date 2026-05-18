import { createReadStream } from "node:fs";
import { WARCParser } from "warcio";
import { MetricsCollector } from "../metrics.js";
import type { ParsedRecord, StrategyResult } from "./types.js";

export async function runStream(filePath: string): Promise<StrategyResult> {
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
      // strategies, but discard the result immediately — a faithful streaming
      // parser holds no more than one record at a time, so peak memory must
      // not grow with record count.
      extractRecord(record);
      recordCount++;
    }

    metrics.markEnd("parse");
    metrics.markEnd("total");
    metrics.stopSampling();

    return { records: [], recordCount, metrics: metrics.getMetrics() };
  } catch (err) {
    metrics.markEnd("parse");
    metrics.markEnd("total");
    metrics.stopSampling();
    return {
      records: [],
      recordCount,
      metrics: metrics.getMetrics(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractRecord(record: any): ParsedRecord {
  const warcType = record.warcType ?? "unknown";
  const recordId = record.warcHeaders?.headers?.get("WARC-Record-ID") ?? "";
  const targetURI = record.warcTargetURI ?? undefined;
  const lengthRaw = record.warcHeaders?.headers?.get("Content-Length") ?? "0";
  const contentLength = Number.parseInt(lengthRaw, 10) || 0;
  return { warcType, recordId, targetURI, contentLength };
}
