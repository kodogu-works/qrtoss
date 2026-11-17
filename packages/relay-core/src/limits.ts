/** A lifetime send allowance. Time and successful sends never replenish it. */
export class SendBudget {
  private bytes = 0;

  constructor(
    private readonly limit: number,
    private readonly closingReserve: number,
  ) {}

  take(bytes: number, closing = false) {
    const limit = this.limit - (closing ? 0 : this.closingReserve);
    if (this.bytes + bytes > limit) return false;
    this.bytes += bytes;
    return true;
  }
}

export type Bucket = { tokens: number; at: number };

export function bucket(at: number, tokens: number): Bucket {
  return { tokens, at };
}

export function take(b: Bucket, now: number, rate: number, burst: number, amount = 1) {
  b.tokens = Math.min(burst, b.tokens + (Math.max(0, now - b.at) * rate) / 1000);
  b.at = now;
  if (b.tokens < amount) return false;
  b.tokens -= amount;
  return true;
}

export class IpLimits {
  private readonly entries = new Map<string, { at: number; create: Bucket; failures: Bucket }>();

  record(ip: string, now: number) {
    this.sweep(now);
    let entry = this.entries.get(ip);
    if (!entry) {
      if (this.entries.size >= 4096) this.entries.delete(this.entries.keys().next().value!);
      entry = { at: now, create: bucket(now, 5), failures: bucket(now, 20) };
    }
    entry.at = now;
    this.entries.delete(ip);
    this.entries.set(ip, entry);
    return entry;
  }

  canAuthenticate(ip: string, now: number) {
    const entry = this.record(ip, now);
    return take(entry.failures, now, 20 / 60, 20, 0) && entry.failures.tokens >= 1;
  }

  authenticationFailed(ip: string, now: number) {
    take(this.record(ip, now).failures, now, 20 / 60, 20);
  }

  sweep(now: number) {
    for (const [ip, entry] of this.entries) if (now - entry.at >= 60000) this.entries.delete(ip);
  }

  get size() {
    return this.entries.size;
  }
}
