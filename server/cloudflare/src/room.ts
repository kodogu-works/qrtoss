import { DurableObject } from 'cloudflare:workers';
import { createRelayCore } from '../../../packages/relay-core/src/index.ts';
import { maintainLease } from '../../../packages/relay-core/src/lease.ts';
import { capacity, type Env } from './env.ts';
import { random, digest, equal, bestEffort } from './runtime.ts';

export class RoomDO extends DurableObject<Env> {
  protected readonly core: ReturnType<typeof createRelayCore>;
  private initialized = false;
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private cancelLease?: () => void;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = createRelayCore({
      now: () => this.now(),
      wallNow: () => this.wallNow(),
      random,
      digest,
      equal,
      // The trusted entry Worker performs global authentication admission.
      canAuthenticate: () => true,
      authenticationFailed: (ip) =>
        this.ctx.waitUntil(bestEffort(capacity(this.env).authenticationFailed(ip))),
      onRoomClosed: (id) => {
        if (this.sweepTimer !== undefined) clearTimeout(this.sweepTimer);
        this.cancelLease?.();
        this.ctx.waitUntil(bestEffort(capacity(this.env).releaseRoom(id)));
      },
    });
  }
  protected now() {
    return Date.now();
  }
  protected wallNow() {
    return Date.now();
  }

  create(id: string, receiverHash: Uint8Array, joinHash: Uint8Array) {
    if (this.initialized || receiverHash.byteLength !== 32 || joinHash.byteLength !== 32)
      throw new Error('ROOM_UNAVAILABLE');
    this.initialized = true;
    const deadlines = this.core.createRoom(id, receiverHash, joinHash);
    this.cancelLease = maintainLease(
      () => {
        this.ctx.waitUntil(bestEffort(capacity(this.env).renewRoom(id)));
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
    if (!this.core.stats().rooms && !this.core.stats().sockets) return;
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
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const connection = this.core.connect(server, request.headers.get('X-Qrtoss-IP') ?? 'unknown');
    server.addEventListener('message', (event) => {
      this.ctx.waitUntil(
        this.core
          .message(
            connection,
            typeof event.data === 'string' ? event.data : new Uint8Array(event.data),
            typeof event.data !== 'string',
          )
          .catch(() => this.core.fail(connection, 'SERVER_ERROR', 1011)),
      );
    });
    const disconnected = () => {
      this.core.disconnect(connection);
      this.scheduleSweep();
    };
    server.addEventListener('close', (event) => {
      // The entry Worker rejects binary/oversized traffic before forwarding it.
      // Preserve its fixed failure for the peer, just like Node's socket adapter.
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
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Extensions': '' },
    });
  }
}
