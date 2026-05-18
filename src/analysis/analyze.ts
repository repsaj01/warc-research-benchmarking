import { readFile, writeFile } from "node:fs/promises";
import { resolve, basename, dirname, join } from "node:path";
import type { BenchmarkMetrics, StrategyName } from "../strategies/types.js";

interface RunRow extends BenchmarkMetrics {
  recordCount: number;
  error?: string;
}

interface FileResult {
  file: string;
  fileSizeBytes: number;
  uncompressedBytes: number;
  sizeCategory: "XS" | "S" | "M" | "L";
  strategy: StrategyName;
  runs: RunRow[];
}

interface ResultsDoc {
  metadata: Record<string, unknown>;
  results: FileResult[];
}

interface Stats {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

interface GroupSummary {
  strategy: StrategyName;
  sizeCategory: FileResult["sizeCategory"];
  fileCount: number;
  runCount: number;
  wallClockMs: Stats;
  parseOnlyMs: Stats;
  peakHeapMB: Stats;
  peakRssMB: Stats;
  cpuUserMs: Stats;
  cpuSystemMs: Stats;
  throughputMBps: number;            // median, computed per run then summarized
  workerSpawnOverheadMs?: number;    // median (wallClock - parseOnly) for worker
  workerSpawnOverheadPct?: number;
}

function padAround(str: string, length: number): string {
  if (str.length >= length) return str;

  const totalPadding = length - str.length;
  const rightPadding = Math.floor(totalPadding / 2);
  const leftPadding = totalPadding - rightPadding;

  return " ".repeat(leftPadding) + str + " ".repeat(rightPadding);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  if (next !== undefined) return sorted[base]! + rest * (next - sorted[base]!);
  return sorted[base]!;
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { median: 0, p25: 0, p75: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function parseArgs(): { input: string; output?: string } {
  const args = process.argv.slice(2);
  let input = "";
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) input = args[++i]!;
    else if (args[i] === "--output" && args[i + 1]) output = args[++i]!;
    else if (!input && !args[i]!.startsWith("--")) input = args[i]!;
  }
  if (!input) {
    console.error("Usage: analyze --input <results.json> [--output <summary.json>]");
    process.exit(1);
  }
  return { input: resolve(input), output: output ? resolve(output) : undefined };
}

async function main(): Promise<void> {
  const { input, output } = parseArgs();
  const doc: ResultsDoc = JSON.parse(await readFile(input, "utf8"));

  // Group runs by (strategy, sizeCategory).
  type Key = string;
  const groups = new Map<Key, { strategy: StrategyName; cat: FileResult["sizeCategory"]; files: Set<string>; runs: Array<RunRow & { fileSizeBytes: number }> }>();

  for (const fr of doc.results) {
    const key = `${fr.strategy}|${fr.sizeCategory}`;
    let g = groups.get(key);
    if (!g) {
      g = { strategy: fr.strategy, cat: fr.sizeCategory, files: new Set(), runs: [] };
      groups.set(key, g);
    }
    g.files.add(fr.file);
    for (const run of fr.runs) {
      if (run.error) continue;
      g.runs.push({ ...run, fileSizeBytes: fr.uncompressedBytes });
    }
  }

  const summaries: GroupSummary[] = [];
  for (const g of groups.values()) {
    const wall = g.runs.map((r) => r.wallClockMs);
    const parse = g.runs.map((r) => r.parseOnlyMs);
    const heap = g.runs.map((r) => r.peakHeapUsedBytes / (1024 * 1024));
    const rss = g.runs.map((r) => r.peakRssBytes / (1024 * 1024));
    const cpuU = g.runs.map((r) => r.cpuUserMs);
    const cpuS = g.runs.map((r) => r.cpuSystemMs);
    const throughputs = g.runs
      .filter((r) => r.wallClockMs > 0)
      .map((r) => (r.fileSizeBytes / (1024 * 1024)) / (r.wallClockMs / 1000));

    const summary: GroupSummary = {
      strategy: g.strategy,
      sizeCategory: g.cat,
      fileCount: g.files.size,
      runCount: g.runs.length,
      wallClockMs: stats(wall),
      parseOnlyMs: stats(parse),
      peakHeapMB: stats(heap),
      peakRssMB: stats(rss),
      cpuUserMs: stats(cpuU),
      cpuSystemMs: stats(cpuS),
      throughputMBps: stats(throughputs).median,
    };

    if (g.strategy === "worker") {
      const overheads = g.runs.map((r) => r.wallClockMs - r.parseOnlyMs);
      const med = stats(overheads).median;
      summary.workerSpawnOverheadMs = med;
      summary.workerSpawnOverheadPct = summary.wallClockMs.median > 0
        ? (med / summary.wallClockMs.median) * 100
        : 0;
    }

    summaries.push(summary);
  }

  // Order: size category XS→L, then strategy stream/memory/worker.
  const catOrder = { XS: 0, S: 1, M: 2, L: 3 } as const;
  const stratOrder: Record<StrategyName, number> = { stream: 0, memory: 1, worker: 2 };
  summaries.sort((a, b) =>
    catOrder[a.sizeCategory] - catOrder[b.sizeCategory] || stratOrder[a.strategy] - stratOrder[b.strategy],
  );

  // Markdown table to stdout.
  const lines: string[] = [];
  lines.push(`# Benchmark summary — ${basename(input)}`);
  lines.push("");
  lines.push("| Size | Strategy | Files | Runs | Wall ms (med) | Parse ms (med) | Heap MB (med) | RSS MB (med) | Throughput MB/s | Worker overhead |");
  lines.push("|------|----------|-------|------|---------------|----------------|---------------|--------------|-----------------|-----------------|");
  for (const s of summaries) {
    const overhead = s.strategy === "worker"
      ? `${fmt(s.workerSpawnOverheadMs ?? 0, 1)} ms (${fmt(s.workerSpawnOverheadPct ?? 0, 1)}%)`
      : "—";
    lines.push(
      `|${padAround(s.sizeCategory, 6)}|${padAround(s.strategy, 10)}|${padAround(s.fileCount.toString(), 7)}|${padAround(s.runCount.toString(), 6)}|${padAround(fmt(s.wallClockMs.median), 15)}|${padAround(fmt(s.parseOnlyMs.median), 16)}|${padAround(fmt(s.peakHeapMB.median), 15)}|${padAround(fmt(s.peakRssMB.median), 14)}|${padAround(fmt(s.throughputMBps, 2), 17)}|${padAround(overhead, 17)}|`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");

  const outPath = output ?? join(dirname(input), basename(input, ".json") + ".summary.json");
  await writeFile(outPath, JSON.stringify({
    source: input,
    generatedAt: new Date().toISOString(),
    summaries,
  }, null, 2));
  process.stderr.write(`\nSummary JSON → ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
