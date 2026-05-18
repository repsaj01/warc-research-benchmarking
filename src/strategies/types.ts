export interface ParsedRecord {
  warcType: string;
  recordId: string;
  targetURI?: string;
  contentLength: number;
}

export interface BenchmarkMetrics {
  wallClockMs: number;
  parseOnlyMs: number;
  peakHeapUsedBytes: number;
  peakRssBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}

export interface StrategyResult {
  records: ParsedRecord[];
  recordCount?: number;
  metrics: BenchmarkMetrics;
  error?: string;
}

export type StrategyName = "stream" | "memory" | "worker";
