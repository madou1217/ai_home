/**
 * Real Network Ping & Latency Tracker
 * 吸收 dsh 2.0 生产级链路度量，针对 aih-server 进行真实物理往返时延（RTT）采样
 */

class RealLatencyTracker {
  private lastLatencyMs: number | null = null;
  private isChecking: boolean = false;
  private listeners: Set<(latencyMs: number | null) => void> = new Set();
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.startSampling();
    }
  }

  public getLatency(): number | null {
    return this.lastLatencyMs;
  }

  public subscribe(cb: (latencyMs: number | null) => void): () => void {
    this.listeners.add(cb);
    cb(this.lastLatencyMs);
    return () => {
      this.listeners.delete(cb);
    };
  }

  public async probeNow(): Promise<number | null> {
    if (this.isChecking || typeof window === 'undefined') return this.lastLatencyMs;
    this.isChecking = true;
    const start = performance.now();
    try {
      const resp = await fetch('/healthz', {
        method: 'GET',
        cache: 'no-store',
      });
      if (resp.ok) {
        const duration = Math.round(performance.now() - start);
        this.lastLatencyMs = duration;
        this.notify();
        return duration;
      }
    } catch {
      // Offline or network error
      this.lastLatencyMs = null;
      this.notify();
    } finally {
      this.isChecking = false;
    }
    return this.lastLatencyMs;
  }

  private startSampling(): void {
    // WebUI 轮询已删除：只在启动时探测一次，后续由页面手动刷新。
    this.probeNow();
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb(this.lastLatencyMs));
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const realLatencyTracker = new RealLatencyTracker();
