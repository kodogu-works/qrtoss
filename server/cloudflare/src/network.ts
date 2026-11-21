import { DurableObject } from 'cloudflare:workers';
import { createNetworkCore } from '../../../packages/relay-core/src/network.ts';
import { maintainLease } from '../../../packages/relay-core/src/lease.ts';
import { capacity, type Env } from './env.ts';
import { random, digest, equal, bestEffort } from './runtime.ts';
import { MAX_SOCKET_SEND_BYTES } from './limits.ts';

/** Volatile shared-network coordinator. It deliberately uses no storage, alarms or hibernation. */
export class NetworkDO extends DurableObject<Env> {
  protected readonly core: ReturnType<typeof createNetworkCore>;
  private initialized = false;
  private capacityKey?: string;
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private cancelLease?: () => void;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = createNetworkCore({
      now: () => this.now(),
      wallNow: () => this.wallNow(),
      random,
      digest,
      equal,
      // Forwarded frames use flow.ack. This lifetime allowance bounds all other
      // replies on Workers, whose WebSocket implementation has no bufferedAmount.
      maxUntrackedSendBytes: MAX_SOCKET_SEND_BYTES,
      // The entry Worker performs global authentication admission.
      canAuthenticate: () => true,
      authenticationFailed: (ip) =>
        this.ctx.waitUntil(bestEffort(capacity(this.env).authenticationFailed(ip))),
      onNetworkClosed: (id) => {
        if (this.sweepTimer !== undefined) clearTimeout(this.sweepTimer);
        this.cancelLease?.();
        this.ctx.waitUntil(bestEffort(capacity(this.env).releaseNetwork(this.capacityKey ?? id)));
      },
    });
  }

  protected now() {
    return Date.now();
  }

  protected wallNow() {
    return Date.now();
  }

  create(id: string, controllerId: string, controllerHash: Uint8Array, capacityKey = id) {
    if (this.initialized || controllerHash.byteLength !== 32)
      throw new Error('NETWORK_UNAVAILABLE');
    this.initialized = true;
    this.capacityKey = capacityKey;
    const deadlines = this.core.createNetwork(id, controllerId, controllerHash);
    this.cancelLease = maintainLease(
      () => {
        this.ctx.waitUntil(bestEffort(capacity(this.env).renewNetwork(capacityKey)));
      },
      (callback, ms) => this.leaseTimeout(callback, ms),
    );
    this.scheduleSweep();
    return deadlines;
  }

  protected leaseTimeout(callback: () => void, ms: number) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  }

  private scheduleSweep() {
    if (this.sweepTimer !== undefined) clearTimeout(this.sweepTimer);
    if (!this.core.stats().networks && !this.core.stats().sockets) return;
    this.sweepTimer = setTimeout(() => {
      this.core.sweep();
      this.scheduleSweep();
    }, 1000);
  }

  fetch(request: Request) {
    if (
      request.method !== 'GET' ||
      new URL(request.url).pathname !== '/ws' ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
    )
      return new Response(null, { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const connection = this.core.connect(server, request.headers.get('X-Qrtoss-IP') ?? 'unknown');
    server.addEventListener('message', (event) => {
      const processing = this.core
        .message(
          connection,
          typeof event.data === 'string' ? event.data : new Uint8Array(event.data),
          typeof event.data !== 'string',
        )
        .catch(() => this.core.fail(connection, 'SERVER_ERROR', 1011));
      this.ctx.waitUntil(processing);
    });
    const disconnected = () => {
      this.core.disconnect(connection);
      this.scheduleSweep();
    };
    server.addEventListener('close', (event) => {
      if (event.reason === 'MESSAGE_TOO_LARGE' && event.code === 1009)
        this.core.fail(connection, 'MESSAGE_TOO_LARGE', 1009);
      else if (event.reason === 'PROTOCOL_ERROR' && event.code === 1008)
        this.core.fail(connection, 'PROTOCOL_ERROR', 1008);
      disconnected();
    });
    server.addEventListener('error', () => {
      this.core.fail(connection, 'SERVER_ERROR', 1011);
      disconnected();
    });
    this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: client });
  }
}
