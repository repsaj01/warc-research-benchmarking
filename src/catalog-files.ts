import { readdir, stat, writeFile, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

interface ManifestEntry {
  fileName: string;
  filePath: string;
  fileSizeBytes: number;
  uncompressedBytes: number;
  /** True when the file is actually gzipped (regardless of extension). */
  gzipped: boolean;
  sizeCategory: "XS" | "S" | "M" | "L";
}

interface Manifest {
  generatedAt: string;
  rootDir: string;
  entries: ManifestEntry[];
}

function categorize(uncompressed: number): ManifestEntry["sizeCategory"] {
  if (uncompressed < 100 * 1024) return "XS";
  if (uncompressed < 1024 * 1024) return "S";
  if (uncompressed < 10 * 1024 * 1024) return "M";
  return "L";
}

/**
 * Detect gzip by magic bytes (0x1f 0x8b) rather than file extension. Some
 * crawler outputs name files `.warc.gz` while writing plain WARC, which would
 * otherwise blow up with Z_DATA_ERROR.
 */
async function isGzipped(filePath: string): Promise<boolean> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

async function uncompressedSize(filePath: string, gzipped: boolean): Promise<number> {
  if (!gzipped) {
    const s = await stat(filePath);
    return s.size;
  }
  let total = 0;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      total += chunk.length;
      cb();
    },
  });
  await pipeline(createReadStream(filePath), createGunzip(), sink);
  return total;
}

function parseArgs(): { dir: string; output: string } {
  const args = process.argv.slice(2);
  let dir = "./data/warc";
  let output = "./data/manifest.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && args[i + 1]) dir = args[++i]!;
    else if (args[i] === "--output" && args[i + 1]) output = args[++i]!;
  }
  return { dir: resolve(dir), output: resolve(output) };
}

async function main(): Promise<void> {
  const { dir, output } = parseArgs();

  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const all = await readdir(dir, { withFileTypes: true });
  const warcFiles = all
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => n.endsWith(".warc") || n.endsWith(".warc.gz"));

  const entries: ManifestEntry[] = [];
  let mismatchCount = 0;
  for (const name of warcFiles) {
    const filePath = join(dir, name);
    const s = await stat(filePath);
    const gzipped = await isGzipped(filePath);
    if (name.endsWith(".gz") && !gzipped) mismatchCount++;
    let uncompressed: number;
    try {
      uncompressed = await uncompressedSize(filePath, gzipped);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  warning: failed to measure uncompressed size for ${name}: ${msg}; falling back to file size`);
      uncompressed = s.size;
    }
    entries.push({
      fileName: name,
      filePath,
      fileSizeBytes: s.size,
      uncompressedBytes: uncompressed,
      gzipped,
      sizeCategory: categorize(uncompressed),
    });
  }
  if (mismatchCount > 0) {
    console.error(`  note: ${mismatchCount} file(s) have a .gz extension but are not gzipped (manifest reflects actual format)`);
  }

  entries.sort((a, b) => a.uncompressedBytes - b.uncompressedBytes);

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    rootDir: dir,
    entries,
  };

  await writeFile(output, JSON.stringify(manifest, null, 2));

  const counts: Record<ManifestEntry["sizeCategory"], number> = { XS: 0, S: 0, M: 0, L: 0 };
  for (const e of entries) counts[e.sizeCategory]++;

  console.error(`Cataloged ${entries.length} file(s) → ${output}`);
  for (const cat of ["XS", "S", "M", "L"] as const) {
    const tag = counts[cat] < 5 ? " (warning: <5)" : "";
    console.error(`  ${cat}: ${counts[cat]}${tag}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
