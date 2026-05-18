import { fork } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { BenchmarkMetrics, StrategyName } from "./strategies/types.js";

interface ManifestEntry {
  fileName: string;
  filePath: string;
  fileSizeBytes: number;
  uncompressedBytes: number;
  sizeCategory: "XS" | "S" | "M" | "L";
}

interface Manifest {
  generatedAt: string;
  rootDir: string;
  entries: ManifestEntry[];
}

interface RunOutput {
  ok: boolean;
  recordCount?: number;
  metrics?: BenchmarkMetrics;
  error?: string;
}

interface FileResult {
  file: string;
  filePath: string;
  fileSizeBytes: number;
  uncompressedBytes: number;
  sizeCategory: ManifestEntry["sizeCategory"];
  strategy: StrategyName;
  runs: Array<BenchmarkMetrics & { recordCount: number; error?: string }>;
}

interface ResultsDoc {
  metadata: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    warmupRuns: number;
    repetitions: number;
    timestamp: string;
    manifestPath: string;
    selection: {
      totalInManifest: number;
      selectedCount: number;
      categories: ManifestEntry["sizeCategory"][];
      strategies: StrategyName[];
      limit: number;
      perCategory: number;
      files: string[];
    };
  };
  results: FileResult[];
}

const ALL_STRATEGIES: StrategyName[] = ["stream", "memory", "worker"];
const ALL_CATEGORIES: ManifestEntry["sizeCategory"][] = ["XS", "S", "M", "L"];

interface CliArgs {
  manifest: string;
  output: string;
  warmup: number;
  repetitions: number;
  limit: number;                                    // total cap, 0 = no cap
  perCategory: number;                              // per-category cap, 0 = no cap
  categories: ManifestEntry["sizeCategory"][];      // which categories to include
  strategies: StrategyName[];                       // which strategies to run
  files: string[];                                  // exact filename whitelist, [] = all
}

function parseList<T extends string>(raw: string, allowed: readonly T[], label: string): T[] {
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (!allowed.includes(item as T)) {
      throw new Error(`Invalid ${label}: "${item}". Allowed: ${allowed.join(", ")}`);
    }
  }
  return items as T[];
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = {
    manifest: "./data/manifest.json",
    output: "./data/results/",
    warmup: 3,
    repetitions: 15,
    limit: 0,
    perCategory: 0,
    categories: [...ALL_CATEGORIES],
    strategies: [...ALL_STRATEGIES],
    files: [],
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (a === "--manifest" && next) { out.manifest = next; i++; }
    else if (a === "--output" && next) { out.output = next; i++; }
    else if (a === "--warmup" && next) { out.warmup = Number.parseInt(next, 10); i++; }
    else if (a === "--repetitions" && next) { out.repetitions = Number.parseInt(next, 10); i++; }
    else if (a === "--limit" && next) { out.limit = Number.parseInt(next, 10); i++; }
    else if (a === "--per-category" && next) { out.perCategory = Number.parseInt(next, 10); i++; }
    else if (a === "--categories" && next) { out.categories = parseList(next, ALL_CATEGORIES, "category"); i++; }
    else if (a === "--strategies" && next) { out.strategies = parseList(next, ALL_STRATEGIES, "strategy"); i++; }
    else if (a === "--files" && next) { out.files = next.split(",").map((s) => s.trim()).filter(Boolean); i++; }
  }

  return out;
}

function selectEntries(all: ManifestEntry[], cli: CliArgs): ManifestEntry[] {
  let filtered = all.filter((e) => cli.categories.includes(e.sizeCategory));
  if (cli.files.length > 0) {
    const want = new Set(cli.files);
    filtered = filtered.filter((e) => want.has(e.fileName));
  }

  if (cli.perCategory > 0) {
    const perCat = new Map<ManifestEntry["sizeCategory"], number>();
    filtered = filtered.filter((e) => {
      const seen = perCat.get(e.sizeCategory) ?? 0;
      if (seen >= cli.perCategory) return false;
      perCat.set(e.sizeCategory, seen + 1);
      return true;
    });
  }

  if (cli.limit > 0 && filtered.length > cli.limit) {
    filtered = filtered.slice(0, cli.limit);
  }

  return filtered;
}

function resolveRunnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Pick the runner entry from how *this* module was loaded
  // Under tsx this file loads as `.ts`, so fork the .mjs
  // bootstrap, which registers tsx's loader in the child process via its
  // supported programmatic API. After `tsc` build it loads as `.js`, so fork
  // the compiled runner directly.
  if (import.meta.url.endsWith(".ts")) {
    return resolve(here, "runner-bootstrap.mjs");
  }
  return resolve(here, "runner.js");
}

function runChild(filePath: string, strategy: StrategyName, runnerPath: string): Promise<RunOutput> {
  return new Promise((resolvePromise) => {
    const child = fork(runnerPath, [], {
      execArgv: ["--expose-gc"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    let settled = false;
    const settle = (out: RunOutput): void => {
      if (settled) return;
      settled = true;
      resolvePromise(out);
    };

    child.on("message", (msg) => settle(msg as RunOutput));
    child.on("error", (err) => settle({ ok: false, error: err.message }));
    child.on("exit", (code) => {
      if (!settled) settle({ ok: false, error: `child exited with code ${code}` });
    });

    child.send({ filePath, strategy });
  });
}

async function main(): Promise<void> {
  const cli = parseArgs();

  const manifestPath = resolve(cli.manifest);
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  
  const outputDir = resolve(cli.output);
  await mkdir(outputDir, { recursive: true });

  const runnerPath = resolveRunnerPath();
  const selected = selectEntries(manifest.entries, cli);

  if (selected.length === 0) {
    console.error("No files match the given filters.");
    process.exit(1);
  }

  const selectionCounts: Record<string, number> = { XS: 0, S: 0, M: 0, L: 0 };
  for (const e of selected) selectionCounts[e.sizeCategory]++;
  process.stderr.write(
    `Selected ${selected.length} file(s) [XS:${selectionCounts.XS} S:${selectionCounts.S} M:${selectionCounts.M} L:${selectionCounts.L}]; strategies: ${cli.strategies.join(",")}\n`,
  );

  const doc: ResultsDoc = {
    metadata: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      warmupRuns: cli.warmup,
      repetitions: cli.repetitions,
      timestamp: new Date().toISOString(),
      manifestPath,
      selection: {
        totalInManifest: manifest.entries.length,
        selectedCount: selected.length,
        categories: cli.categories,
        strategies: cli.strategies,
        limit: cli.limit,
        perCategory: cli.perCategory,
        files: cli.files,
      },
    },
    results: [],
  };

  const totalUnits = selected.length * cli.strategies.length;
  let unit = 0;

  // Main benchmarking logic
  for (const entry of selected) {
    for (const strategy of cli.strategies) {
      unit++;
      const fileResult: FileResult = {
        file: entry.fileName,
        filePath: entry.filePath,
        fileSizeBytes: entry.fileSizeBytes,
        uncompressedBytes: entry.uncompressedBytes,
        sizeCategory: entry.sizeCategory,
        strategy,
        runs: [],
      };

      // Warmup
      for (let w = 0; w < cli.warmup; w++) {
        process.stderr.write(
          `[${unit}/${totalUnits}] ${strategy} | ${entry.fileName} | warmup ${w + 1}/${cli.warmup}\n`,
        );
        await runChild(entry.filePath, strategy, runnerPath);
      }

      // Measured repetitions
      for (let r = 0; r < cli.repetitions; r++) {
        process.stderr.write(
          `[${unit}/${totalUnits}] ${strategy} | ${entry.fileName} | run ${r + 1}/${cli.repetitions}\n`,
        );
        const out = await runChild(entry.filePath, strategy, runnerPath);
        if (out.ok && out.metrics) {
          fileResult.runs.push({
            ...out.metrics,
            recordCount: out.recordCount ?? 0,
            ...(out.error ? { error: out.error } : {}),
          });
        } else {
          process.stderr.write(`  error: ${out.error ?? "unknown"}\n`);
          fileResult.runs.push({
            wallClockMs: 0,
            parseOnlyMs: 0,
            peakHeapUsedBytes: 0,
            peakRssBytes: 0,
            cpuUserMs: 0,
            cpuSystemMs: 0,
            recordCount: 0,
            error: out.error ?? "unknown",
          });
        }
      }

      doc.results.push(fileResult);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outputDir, `results-${stamp}.json`);
  await writeFile(outPath, JSON.stringify(doc, null, 2));
  process.stdout.write(`${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
