import type { BenchmarkMetrics } from "./strategies/types.js";

interface Mark {
  startNs?: bigint;
  endNs?: bigint;
  startCpu?: NodeJS.CpuUsage;
  endCpu?: NodeJS.CpuUsage;
}

export class MetricsCollector {
  private marks = new Map<string, Mark>();
  private peakHeap = 0;
  private peakRss = 0;
  private samplingHandle: NodeJS.Timeout | null = null;

  startSampling(intervalMs = 10): void {
    const sample = (): void => {
      const m = process.memoryUsage();
      if (m.heapUsed > this.peakHeap) this.peakHeap = m.heapUsed;
      if (m.rss > this.peakRss) this.peakRss = m.rss;
    };
    sample();
    this.samplingHandle = setInterval(sample, intervalMs);
    // Keep the sampling timer from preventing process exit indirectly
    if (this.samplingHandle.unref) this.samplingHandle.unref();
  }

  stopSampling(): void {
    if (this.samplingHandle) {
      clearInterval(this.samplingHandle);
      this.samplingHandle = null;
    }
    // One last sample to capture end-of-run state
    const m = process.memoryUsage();
    if (m.heapUsed > this.peakHeap) this.peakHeap = m.heapUsed;
    if (m.rss > this.peakRss) this.peakRss = m.rss;
  }

  markStart(label: string): void {
    const mark = this.marks.get(label) ?? {};
    mark.startNs = process.hrtime.bigint();
    mark.startCpu = process.cpuUsage();
    this.marks.set(label, mark);
  }

  markEnd(label: string): void {
    const mark = this.marks.get(label);
    if (!mark || mark.startNs === undefined || !mark.startCpu) {
      throw new Error(`markEnd called for "${label}" without prior markStart`);
    }
    mark.endNs = process.hrtime.bigint();
    mark.endCpu = process.cpuUsage(mark.startCpu);
  }

  private durationMs(label: string): number {
    const mark = this.marks.get(label);
    if (!mark || mark.startNs === undefined || mark.endNs === undefined) return 0;
    return Number(mark.endNs - mark.startNs) / 1_000_000;
  }

  getMetrics(): BenchmarkMetrics {
    const total = this.marks.get("total");
    const cpu = total?.endCpu ?? { user: 0, system: 0 };
    return {
      wallClockMs: this.durationMs("total"),
      parseOnlyMs: this.durationMs("parse"),
      peakHeapUsedBytes: this.peakHeap,
      peakRssBytes: this.peakRss,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
    };
  }

  // For worker-thread results: merge peak memory from a remote sampler.
  mergePeakMemory(heapBytes: number, rssBytes: number): void {
    if (heapBytes > this.peakHeap) this.peakHeap = heapBytes;
    if (rssBytes > this.peakRss) this.peakRss = rssBytes;
  }
}
