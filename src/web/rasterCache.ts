/** Export-job scoped sampled images only. Never retains originals or survives a job. */
export class RasterCache {
  private entries = new Map<string, string>();
  private bytes = 0;
  constructor(private readonly limit = 16 * 1024 * 1024) {}
  get(key: string) {
    const value = this.entries.get(key);
    if (value !== undefined) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: string) {
    const old = this.entries.get(key);
    if (old !== undefined) { this.bytes -= old.length * 2; this.entries.delete(key); }
    const size = value.length * 2;
    if (size > this.limit) return;
    while (this.bytes + size > this.limit && this.entries.size) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.length * 2; this.entries.delete(oldest);
    }
    this.entries.set(key, value); this.bytes += size;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
