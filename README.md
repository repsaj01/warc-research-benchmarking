# warc-research-benchmarking

Benchmark suite for my bachelor thesis.

It compares three Node.js processing strategies for WARC files — **streaming**, **in-memory**, and **worker-thread** — across files of varying size, measuring wall-clock time, parse-only time, peak heap and RSS, and CPU time.

Research question: _How do streaming-based, in-memory-based, and worker-based processing strategies compare in efficiency when processing WARC files in Node.js?_

## Prerequisites

- Node.js **24.15 LTS** or newer (developed against Node.js 24.15 LTS).
- npm 11+.

## Setup

```bash
npm install
```

Place WARC files (`.warc` or `.warc.gz`) under `data/warc/`. The directory is gitignored.

## Running the benchmark

### 1. Catalog the files

Scans `data/warc/`, measures uncompressed size (decompressing `.gz` files for an accurate byte count), assigns size categories, and writes a manifest.

(run in development environment)
```bash
npx tsx src/catalog-files.ts --dir ./data/warc --output ./data/manifest.json
```

(run in build environment)
```bash
node dist/catalog-files.js --dir ./data/warc --output ./data/manifest.json
```

Size categories:

| Category | Range (uncompressed) |
|----------|----------------------|
| XS | < 100 KB |
| S  | 100 KB – 1 MB |
| M  | 1 MB – 10 MB |
| L  | > 10 MB |

A warning is printed if any category has fewer than 5 files to process.

### 2. Run the benchmark

(in development environment)
```bash
npx tsx src/benchmark.ts --manifest ./data/manifest.json --output ./results/ --warmup 3 --repetitions 15
```

(in production environment)
```bash
node --expose-gc dist/benchmark.js --manifest ./data/manifest.json --output ./results/ --warmup 3 --repetitions 15
```

Each `(file × strategy × repetition)` tuple runs in a fresh forked child process (`child_process.fork`) with `--expose-gc`, after a forced GC and a 5-second settle pause. Progress is logged to stderr; the result file path is the only line written to stdout.

#### Filtering which files run

When you don't want to run the whole manifest, use the filter flags. They compose in this order: categories → file whitelist → per-category cap → total limit.

| Flag | Description |
|------|-------------|
| `--limit <n>` | Cap the total number of files (after other filters). |
| `--per-category <n>` | Cap files per size category. Useful for keeping XS/S/M/L balanced (e.g. 5 each). |
| `--categories XS,S` | Only include the listed categories. |
| `--strategies stream,memory` | Only run the listed strategies. |
| `--files name1.warc,name2.warc.gz` | Exact filename whitelist (matches `manifest.fileName`). |

Examples (development environment):

```bash
# Quick smoke test: 1 file per category, all 3 strategies, fewer reps.
npx tsx src/benchmark.ts --per-category 1 --warmup 1 --repetitions 3

# Balanced run: 5 files per category, default reps.
npx tsx src/benchmark.ts --per-category 5

# Only the streaming strategy on small files.
npx tsx src/benchmark.ts --categories XS,S --strategies stream

# A single file, full reps.
npx tsx src/benchmark.ts --files art-house.gutweb.at.warc.gz
```

The filter selection is also recorded in `metadata.selection` of the output JSON, so you can tell after the fact which subset a run covered.

After the build step (`npm run build`) the same commands can be run with plain `node`:

```bash
node --expose-gc dist/benchmark.js --manifest ./data/manifest.json --output ./results/
```

### 3. Analyze

(in development environment)
```bash
npx tsx src/analysis/analyze.ts --input ./results/results-<stamp>.json
```

(in production environment)
```bash
node dist/analysis/analyze.ts --input ./results-<stamp>.json
```

Prints a markdown summary table to stdout (median, p25, p75, min, max for each metric, throughput in MB/s, and worker-spawn overhead) and writes a `.summary.json` next to the input.

## Output schema

```jsonc
{
  "metadata": {
    "nodeVersion": "v24.x.x",
    "platform": "linux",
    "arch": "x64",
    "warmupRuns": 3,
    "repetitions": 15,
    "timestamp": "2026-01-01T...",
    "manifestPath": "/abs/path/to/manifest.json"
  },
  "results": [
    {
      "file": "example.warc",
      "filePath": "/abs/path/to/example.warc",
      "fileSizeBytes": 524288,
      "uncompressedBytes": 524288,
      "sizeCategory": "S",
      "strategy": "stream",
      "runs": [
        {
          "wallClockMs": 142.5,
          "parseOnlyMs": 142.5,
          "peakHeapUsedBytes": 12345678,
          "peakRssBytes": 23456789,
          "cpuUserMs": 120.3,
          "cpuSystemMs": 22.1,
          "recordCount": 15
        }
      ]
    }
  ]
}
```

## Layout

```
warc-benchmark/
├── src/
│   ├── benchmark.ts              # Orchestrator - forks runner per repetition (application entry point)
│   ├── catalog-files.ts          # Scans WARC dir to construct manifest.json
│   ├── metrics.ts                # MetricsCollector (hrtime, cpuUsage, memory sampler)
│   ├── runner-bootstrap.mjs      # Registers tsx loader inside forked child (dev only)
│   ├── runner.ts                 # Child-process entry point; runs one strategy
│   ├── strategies/
│   │   ├── types.ts              # Shared interfaces
│   │   ├── stream.ts             # Streaming strategy
│   │   ├── memory.ts             # Memory strategy
│   │   ├── worker.ts             # Worker strategy (main thread)
│   │   ├── worker-thread.ts      # Worker strategy (in-worker code)
│   │   └── worker-bootstrap.mjs  # Registers tsx loader inside the worker (dev only)
│   └── analysis/
│       └── analyze.ts            # Descriptive stats + markdown table
├── data/
│   ├── manifest.json             # Generated from 'catalog-files.ts' (gitignored)
│   ├── warc/                     # WARC files (gitignored)
│   └── results/                  # Benchmark JSON logs (gitignored)
├── tsconfig.json
├── package.json
└── README.md
```

## Methodology notes

- **Process isolation per repetition**: every measured run is a fresh `fork()` so V8 heap state, JIT caches, and the OS page cache (if applicable - partially) cannot bleed between runs.
- **GC + settle**: each child forces `global.gc()` and waits 5 s before measuring, to give the allocator and any background work a stable starting point.
- **Memory sampling**: `process.memoryUsage()` is polled every 10 ms; peak `heapUsed` and `rss` are reported. The sampler is `unref`'d so it cannot keep the event loop alive past a finished run.
- **Worker memory**: the worker thread runs its own sampler and reports peaks back; the main thread merges those into the result so reported peaks reflect the worker's heap, not just the orchestrator's.
- **Worker-spawn overhead**: reported as `wallClockMs − parseOnlyMs` (median) for the worker strategy, in both absolute milliseconds and percentage of total wall-clock.
