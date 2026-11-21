import { SC, SHARE_NETWORK_SUBPROTOCOL } from '../../packages/protocol/src/shared.ts';
import { C } from '../../packages/protocol/src/constants.ts';
import {
  validateSharedControlMessage,
  type SharedControlMessage,
  type SharedMemberEntry,
  type SharedRole,
} from '../../packages/protocol/src/shared-control.ts';
import { decodeBase64, exact } from '../../packages/protocol/src/validation.ts';
import type { AppPaths } from './paths.ts';

type ServerMessage = Exclude<SharedControlMessage, { type: 'auth' | 'hb.ping' | 'flow.ack' }>;

export type NetworkHooks = {
  authenticated(message: Extract<SharedControlMessage, { type: 'auth.ok' }>): Promise<void> | void;
  message(message: ServerMessage): Promise<void> | void;
  closed(code: string): void;
};

export type NetworkCredentials = Readonly<{
  role: SharedRole;
  network: string;
  cap: string;
}>;

const encoder = new TextEncoder();

function websocketURL(path: string): URL {
  const url = new URL(path, location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

/** A single volatile network connection. Deliberately has no reconnect path. */
export class SharedNetworkClient {
  private socket?: WebSocket;
  private closed = false;
  private authenticated = false;
  private generation = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private touchTimer?: ReturnType<typeof setTimeout>;
  private touchPending = false;
  private lastTouch = Number.NEGATIVE_INFINITY;
  private lastPong = performance.now();
  private heartbeatId = 0;
  private queue = Promise.resolve();
  private queuedMessages = 0;
  private queuedBytes = 0;
  private receivedWireBytes = 0;
  private ackedWireBytes = 0;
  private memberId?: string;
  private memberAlias?: string;
  private pendingMemberAlias?: string;
  constructor(
    private credentials: NetworkCredentials,
    private readonly hooks: NetworkHooks,
    private readonly paths: Pick<AppPaths, 'networkSocket'>,
  ) {
    decodeBase64(credentials.network, 16);
    decodeBase64(credentials.cap, 32);
  }
  get role(): SharedRole {
    return this.credentials.role;
  }
  get network(): string {
    return this.credentials.network;
  }
  get ownMemberId(): string | undefined {
    return this.memberAlias ?? this.memberId;
  }
  connect(): void {
    if (this.socket || this.closed) throw new Error('PROTOCOL_ERROR');
    const generation = this.generation;
    const ws = new WebSocket(websocketURL(this.paths.networkSocket), SHARE_NETWORK_SUBPROTOCOL);
    this.socket = ws;
    ws.onopen = () => {
      if (!this.current(generation)) return;
      if (ws.protocol !== SHARE_NETWORK_SUBPROTOCOL) return this.fail('VERSION_UNSUPPORTED');
      this.sendControl({
        v: 1,
        type: 'auth',
        role: this.credentials.role,
        network: this.credentials.network,
        cap: this.credentials.cap,
      });
      this.credentials = { ...this.credentials, cap: '' };
    };
    ws.onmessage = (event) => this.enqueue(event.data, generation);
    ws.onerror = () => this.fail('NETWORK_DISCONNECTED');
    ws.onclose = () => {
      void this.queue.finally(() => {
        if (this.current(generation)) this.fail('NETWORK_DISCONNECTED', false);
      });
    };
  }
  private current(generation: number): boolean {
    return generation === this.generation && !this.closed;
  }
  private enqueue(raw: unknown, generation: number): void {
    if (!this.current(generation)) return;
    if (typeof raw !== 'string') {
      this.fail('PROTOCOL_ERROR');
      return;
    }
    const bytes = encoder.encode(raw).byteLength;
    this.queuedMessages++;
    this.queuedBytes += bytes;
    if (
      bytes > SC.NETWORK_MAX_WS_MESSAGE_BYTES ||
      this.queuedMessages > SC.NETWORK_MESSAGE_BURST ||
      this.queuedBytes > SC.MAX_OUTSTANDING_BYTES
    ) {
      this.fail('MESSAGE_TOO_LARGE');
      return;
    }
    this.queue = this.queue
      .then(async () => {
        if (!this.current(generation)) return;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          throw new Error('PROTOCOL_ERROR');
        }
        const wireType = (value as { type?: unknown })?.type;
        if (
          wireType !== 'ucast' &&
          wireType !== 'bcast' &&
          bytes > SC.NETWORK_MAX_CONTROL_MESSAGE_BYTES
        )
          throw new Error('MESSAGE_TOO_LARGE');
        const message = validateSharedControlMessage(value, this.credentials.role);
        const forwarded = message.type === 'ucast' || message.type === 'bcast';
        await this.handle(message);
        if (forwarded) {
          this.receivedWireBytes += bytes;
          this.flushFlowAck();
        }
      })
      .catch((error) => this.fail(error instanceof Error ? error.message : 'PROTOCOL_ERROR'))
      .finally(() => {
        this.queuedMessages--;
        this.queuedBytes -= bytes;
      });
  }
  private async handle(message: SharedControlMessage): Promise<void> {
    if (message.type === 'auth.ok') {
      if (
        this.authenticated ||
        message.role !== this.credentials.role ||
        message.network !== this.credentials.network
      )
        throw new Error('PROTOCOL_ERROR');
      this.authenticated = true;
      if (message.role === 'member') this.memberId = message.memberId;
      this.lastPong = performance.now();
      this.heartbeat = setInterval(() => {
        try {
          if (performance.now() - this.lastPong >= C.HEARTBEAT_TIMEOUT_SECONDS * 1000)
            return this.fail('NETWORK_DISCONNECTED');
          this.sendControl({ v: 1, type: 'hb.ping', id: this.heartbeatId++ });
        } catch (error) {
          this.fail(error instanceof Error ? error.message : 'NETWORK_DISCONNECTED');
        }
      }, C.HEARTBEAT_INTERVAL_SECONDS * 1000);
      await this.hooks.authenticated(message);
      return;
    }
    if (!this.authenticated) throw new Error('PROTOCOL_ERROR');
    if (message.type === 'hb.pong') {
      if (message.id >= this.heartbeatId) throw new Error('PROTOCOL_ERROR');
      this.lastPong = performance.now();
      return;
    }
    if (message.type === 'error') {
      if (message.scope === 'member') this.pendingMemberAlias = undefined;
      if (message.scope === 'socket' || message.scope === 'network') this.fail(message.code);
      else await this.hooks.message(message as ServerMessage);
      return;
    }
    if (message.type === 'net.closed') {
      await this.hooks.message(message);
      this.fail(message.code);
      return;
    }
    if (message.type === 'member.added' && message.memberId === this.pendingMemberAlias) {
      this.memberAlias = message.memberId;
      this.pendingMemberAlias = undefined;
    } else if (message.type === 'member.removed' && message.memberId === this.memberAlias)
      this.memberAlias = undefined;
    await this.hooks.message(message as ServerMessage);
  }
  private flushFlowAck(): void {
    if (this.receivedWireBytes === this.ackedWireBytes || !this.authenticated) return;
    this.ackedWireBytes = this.receivedWireBytes;
    this.sendControl({ v: 1, type: 'flow.ack', bytes: this.ackedWireBytes });
  }
  private sendControl(message: SharedControlMessage): void {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('NETWORK_DISCONNECTED');
    validateSharedControlMessage(message, 'server');
    const data = JSON.stringify(message);
    const bytes = encoder.encode(data).byteLength;
    const forwarded = message.type === 'ucast' || message.type === 'bcast';
    if (
      bytes > SC.NETWORK_MAX_WS_MESSAGE_BYTES ||
      (!forwarded && bytes > SC.NETWORK_MAX_CONTROL_MESSAGE_BYTES) ||
      this.socket.bufferedAmount + bytes > SC.MAX_OUTSTANDING_BYTES
    )
      throw new Error('SLOW_PEER');
    this.socket.send(data);
  }
  invite(entry: SharedMemberEntry): void {
    this.sendControl({ v: 1, type: 'member.invite', ...entry });
  }
  revoke(memberId: string): void {
    this.sendControl({ v: 1, type: 'member.revoke', memberId });
  }
  kick(memberId: string): void {
    this.sendControl({ v: 1, type: 'member.kick', memberId });
  }
  admissions(open: boolean): void {
    this.sendControl({ v: 1, type: 'net.admissions', open });
  }
  end(): void {
    this.sendControl({ v: 1, type: 'net.close' });
  }
  join(entry: SharedMemberEntry): void {
    if (this.pendingMemberAlias || this.memberAlias) throw new Error('FORBIDDEN');
    this.pendingMemberAlias = entry.memberId;
    try {
      this.sendControl({ v: 1, type: 'controller.join', ...entry });
    } catch (error) {
      this.pendingMemberAlias = undefined;
      throw error;
    }
  }
  part(): void {
    this.sendControl({ v: 1, type: 'controller.part' });
  }
  leave(): void {
    this.sendControl({ v: 1, type: 'net.leave' });
  }
  activity(): void {
    if (!this.authenticated || this.closed) return;
    this.touchPending = true;
    const delay = Math.max(0, this.lastTouch + C.TOUCH_COALESCE_SECONDS * 1000 - performance.now());
    if (delay === 0) this.flushTouch();
    else if (this.touchTimer === undefined)
      this.touchTimer = setTimeout(() => {
        this.touchTimer = undefined;
        try {
          this.flushTouch();
        } catch (error) {
          this.fail(error instanceof Error ? error.message : 'NETWORK_DISCONNECTED');
        }
      }, delay);
  }
  private flushTouch(): void {
    if (!this.touchPending || !this.authenticated || this.closed) return;
    this.touchPending = false;
    this.lastTouch = performance.now();
    this.sendControl({ v: 1, type: 'net.touch' });
  }
  ucast(as: SharedRole, to: string, seq: string, ct: string): void {
    this.sendControl({ v: 1, type: 'ucast', as, to, seq, ct });
  }
  bcast(epoch: number, seq: string, ct: string): void {
    this.sendControl({ v: 1, type: 'bcast', epoch, seq, ct });
  }
  close(notify = true): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    clearInterval(this.heartbeat);
    clearTimeout(this.touchTimer);
    this.touchTimer = undefined;
    this.touchPending = false;
    this.socket?.close(1000);
    this.socket = undefined;
    this.pendingMemberAlias = undefined;
    this.credentials = { ...this.credentials, cap: '' };
    if (notify) this.hooks.closed('PEER_CLOSED');
  }
  private fail(code: string, closeSocket = true): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    clearInterval(this.heartbeat);
    clearTimeout(this.touchTimer);
    this.touchTimer = undefined;
    this.touchPending = false;
    if (closeSocket) this.socket?.close(1008);
    this.socket = undefined;
    this.pendingMemberAlias = undefined;
    this.credentials = { ...this.credentials, cap: '' };
    this.hooks.closed(code);
  }
}

type ApiError = { error?: { code?: unknown } };

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: abort.signal,
    });
  } catch {
    throw new Error('SERVER_ERROR');
  } finally {
    clearTimeout(timer);
  }
  let value: ApiError & Record<string, unknown>;
  try {
    value = (await response.json()) as ApiError & Record<string, unknown>;
  } catch {
    throw new Error('PROTOCOL_ERROR');
  }
  if (!response.ok)
    throw new Error(typeof value.error?.code === 'string' ? value.error.code : 'SERVER_ERROR');
  return value;
}

export type CreatedNetwork = {
  network: string;
  controllerCap: string;
  serverTime: number;
  idleExpiresAt: number;
  maxExpiresAt: number;
};

export async function createSharedNetwork(
  path: string,
  controllerId: string,
): Promise<CreatedNetwork> {
  decodeBase64(controllerId, 16);
  const value = await post(path, { v: 1, controllerId });
  try {
    exact(value, ['v', 'network', 'controllerCap', 'serverTime', 'idleExpiresAt', 'maxExpiresAt']);
  } catch {
    throw new Error('PROTOCOL_ERROR');
  }
  if (
    value.v !== 1 ||
    typeof value.network !== 'string' ||
    typeof value.controllerCap !== 'string' ||
    !Number.isSafeInteger(value.serverTime) ||
    !Number.isSafeInteger(value.idleExpiresAt) ||
    !Number.isSafeInteger(value.maxExpiresAt)
  )
    throw new Error('PROTOCOL_ERROR');
  decodeBase64(value.network, 16);
  decodeBase64(value.controllerCap, 32);
  return value as CreatedNetwork;
}
