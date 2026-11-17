import { IpLimits, take } from './limits.ts';

export const LEASE_TTL_MS = 120_000;
export const LEASE_RENEW_MS = 60_000;
export interface CapacityOptions {
  maxRooms: number;
  maxSockets: number;
  maxUnauthenticatedSockets: number;
  maxSocketsPerIp: number;
}
export type Admission =
  | { ok: true }
  | { ok: false; status: 429 | 503; code: 'RATE_LIMITED' | 'CAPACITY'; retryAfter?: number };
export type SocketLease = { ip: string; authenticated: boolean };

/** The rate check and reservation form one synchronous mutation. */
export class CapacityState {
  private readonly rooms = new Map<string, number>();
  private readonly sockets = new Map<string, SocketLease & { expires: number }>();
  private readonly ips = new IpLimits();

  constructor(
    private readonly limits: CapacityOptions,
    private readonly now: () => number,
  ) {}

  acquireRoom(id: string, ip: string): Admission {
    this.sweep();
    if (!take(this.ips.record(ip, this.now()).create, this.now(), 10 / 60, 5))
      return { ok: false, status: 429, code: 'RATE_LIMITED', retryAfter: 6 };
    if (this.rooms.size >= this.limits.maxRooms)
      return { ok: false, status: 503, code: 'CAPACITY' };
    this.renewRoom(id);
    return { ok: true };
  }

  renewRoom(id: string) {
    this.sweep();
    this.rooms.set(id, this.now() + LEASE_TTL_MS);
  }
  releaseRoom(id: string) {
    this.rooms.delete(id);
  }

  acquireSocket(id: string, ip: string): Admission {
    this.sweep();
    let unauthenticated = 0,
      perIp = 0;
    for (const lease of this.sockets.values()) {
      if (!lease.authenticated) unauthenticated++;
      if (lease.ip === ip) perIp++;
    }
    if (perIp >= this.limits.maxSocketsPerIp)
      return { ok: false, status: 429, code: 'RATE_LIMITED', retryAfter: 6 };
    if (
      this.sockets.size >= this.limits.maxSockets ||
      unauthenticated >= this.limits.maxUnauthenticatedSockets
    )
      return { ok: false, status: 503, code: 'CAPACITY' };
    this.renewSocket(id, { ip, authenticated: false });
    return { ok: true };
  }
  renewSocket(id: string, lease: SocketLease) {
    this.sweep();
    this.sockets.set(id, { ...lease, expires: this.now() + LEASE_TTL_MS });
  }
  authenticateSocket(id: string) {
    const lease = this.sockets.get(id);
    if (lease) lease.authenticated = true;
  }
  releaseSocket(id: string) {
    this.sockets.delete(id);
  }
  canAuthenticate(ip: string) {
    return this.ips.canAuthenticate(ip, this.now());
  }
  authenticationFailed(ip: string) {
    this.ips.authenticationFailed(ip, this.now());
  }

  sweep() {
    const now = this.now();
    for (const [id, expires] of this.rooms) if (expires <= now) this.rooms.delete(id);
    for (const [id, lease] of this.sockets) if (lease.expires <= now) this.sockets.delete(id);
    this.ips.sweep(now);
  }
  stats() {
    this.sweep();
    return {
      rooms: this.rooms.size,
      sockets: this.sockets.size,
      unauthenticated: [...this.sockets.values()].filter((lease) => !lease.authenticated).length,
      ips: this.ips.size,
    };
  }
}
