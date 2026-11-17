import {
  C,
  CipherChannel,
  decodeBase64,
  deriveKeys,
  makeProof,
  randomToken,
  verifyProof,
  type AppMessage,
  type Keys,
} from '../../packages/protocol/src/index';
import errorCodes from '../../protocol/error-codes.json';
import { createAppPaths, type AppPaths } from './paths';

export type Mode = 'auto_open' | 'display_only' | 'stdout';
export type Phase = 'creating' | 'waiting' | 'pairing' | 'connected' | 'disconnected';
export interface SessionHooks {
  phase(phase: Phase): void;
  pairing?(url: string, expires: number): void;
  message(message: AppMessage): Promise<void> | void;
  error(code: string): void;
}
type Control = Record<string, unknown> & { v: number; type: string };
const time = () => performance.now();
const schema: Record<string, string[]> = {
  'pair.candidate': ['peer', 'serverTime', 'candidateExpiresAt'],
  'pair.challenge': ['peer', 'rNonce'],
  'pair.proof': ['peer', 'sNonce', 'proof'],
  'pair.committed': ['peer', 'serverTime', 'readyExpiresAt', 'idleExpiresAt'],
  'pair.confirm': ['peer', 'proof'],
  'pair.active': ['peer', 'serverTime', 'idleExpiresAt'],
  'pair.candidate_closed': ['peer', 'code'],
  'room.touched': ['peer', 'serverTime', 'idleExpiresAt'],
  'room.closed': ['code'],
  error: ['code', 'scope'],
  'hb.pong': ['id', 'serverTime'],
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PROTOCOL_ERROR');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some((key) => !(key in value)))
    throw new Error('PROTOCOL_ERROR');
}
export function parseControl(value: unknown): Control {
  const m = object(value);
  if (m.v !== 1 || typeof m.type !== 'string') throw new Error('PROTOCOL_ERROR');
  if (m.type === 'auth.ok') {
    if (m.role !== 'receiver' && m.role !== 'sender') throw new Error('PROTOCOL_ERROR');
    exact(m, [
      'v',
      'type',
      'role',
      'room',
      'serverTime',
      'pairingExpiresAt',
      ...(m.role === 'sender' ? ['peer', 'candidateExpiresAt'] : []),
    ]);
    decodeBase64(String(m.room), 16);
  } else {
    const fields = schema[m.type];
    if (!fields) throw new Error('PROTOCOL_ERROR');
    exact(m, ['v', 'type', ...fields]);
  }
  for (const field of [
    'serverTime',
    'pairingExpiresAt',
    'candidateExpiresAt',
    'readyExpiresAt',
    'idleExpiresAt',
  ]) {
    if (field in m && (!Number.isSafeInteger(m[field]) || Number(m[field]) < 0))
      throw new Error('PROTOCOL_ERROR');
  }
  if ('peer' in m) decodeBase64(String(m.peer), 16);
  for (const field of ['rNonce', 'sNonce', 'proof'])
    if (field in m) decodeBase64(String(m[field]), 32);
  if ('code' in m && (typeof m.code !== 'string' || !errorCodes.includes(m.code)))
    throw new Error('PROTOCOL_ERROR');
  if (m.type === 'error' && !['socket', 'candidate', 'room'].includes(String(m.scope)))
    throw new Error('PROTOCOL_ERROR');
  if ('id' in m && (!Number.isInteger(m.id) || Number(m.id) < 0 || Number(m.id) > 2147483647))
    throw new Error('PROTOCOL_ERROR');
  return m as Control;
}

/** One socket/room generation. No reconnection or secret persistence. */
export class Session {
  phase: Phase = 'creating';
  role: 'receiver' | 'sender';
  mode: Mode;
  private socket?: WebSocket;
  private generation = 0;
  private closed = false;
  private room = '';
  private cap = '';
  private join = '';
  private psk = '';
  private peer = '';
  private rNonce = '';
  private keys?: Keys;
  private channel?: CipherChannel;
  private committed = false;
  private ready = false;
  private active = false;
  private pairingDeadline = 0;
  private candidateDeadline = 0;
  private idleDeadline = 0;
  private lastActivity = 0;
  private lastTouch = -Infinity;
  private touchPending = false;
  private hb = 0;
  private lastPong = time();
  private heartbeat?: ReturnType<typeof setInterval>;
  private incoming = Promise.resolve();
  private outgoing = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private fetchAbort?: AbortController;
  constructor(
    role: 'receiver' | 'sender',
    private hooks: SessionHooks,
    mode: Mode = 'auto_open',
    private paths: AppPaths = createAppPaths('/'),
  ) {
    this.role = role;
    this.mode = mode;
  }
  private current(g: number) {
    if (g !== this.generation || this.closed) throw new Error('STALE_SESSION');
  }
  private phaseTo(phase: Phase) {
    this.phase = phase;
    this.hooks.phase(phase);
  }
  async startReceiver(): Promise<void> {
    const g = this.generation;
    try {
      this.phaseTo('creating');
      this.fetchAbort = new AbortController();
      const timer = setTimeout(() => this.fetchAbort?.abort(), 15000);
      let response: Response;
      try {
        response = await fetch(this.paths.rooms, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"v":1}',
          cache: 'no-store',
          redirect: 'error',
          signal: this.fetchAbort.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      this.current(g);
      if (!response.ok) {
        const data = object(await response.json());
        throw new Error(
          typeof object(data.error).code === 'string'
            ? String(object(data.error).code)
            : 'SERVER_ERROR',
        );
      }
      const data = object(await response.json());
      this.current(g);
      exact(data, ['v', 'room', 'receiverCap', 'senderJoinCap', 'serverTime', 'pairingExpiresAt']);
      if (
        data.v !== 1 ||
        !Number.isSafeInteger(data.serverTime) ||
        !Number.isSafeInteger(data.pairingExpiresAt)
      )
        throw new Error('PROTOCOL_ERROR');
      this.room = String(data.room);
      decodeBase64(this.room, 16);
      this.cap = String(data.receiverCap);
      decodeBase64(this.cap, 32);
      this.join = String(data.senderJoinCap);
      decodeBase64(this.join, 32);
      this.psk = randomToken(32);
      this.pairingDeadline = time() + Number(data.pairingExpiresAt) - Number(data.serverTime);
      this.connect(g);
    } catch (error) {
      this.failed(error, g);
    }
  }
  startSender(fragment: string): void {
    try {
      if (fragment.length > 2048 || !fragment.startsWith('#')) throw new Error('PAIR_LINK_INVALID');
      const params = new URLSearchParams(fragment.slice(1));
      if (
        [...params.keys()].length !== 4 ||
        [...params.keys()].some((k) => !['v', 'r', 'j', 'k'].includes(k)) ||
        params.get('v') !== '1'
      )
        throw new Error('PAIR_LINK_INVALID');
      this.room = params.get('r')!;
      this.cap = params.get('j')!;
      this.psk = params.get('k')!;
      // Canonical text only: URLSearchParams must not silently admit alternate encodings.
      if (/[%+\s]/.test(fragment)) throw new Error('PAIR_LINK_INVALID');
      decodeBase64(this.room, 16);
      decodeBase64(this.cap, 32);
      decodeBase64(this.psk, 32);
      this.connect(this.generation);
    } catch {
      this.failed(new Error('PAIR_LINK_INVALID'), this.generation);
    }
  }
  private connect(g: number): void {
    const url = new URL(this.paths.socket, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, 'qrtoss.v1');
    this.socket = ws;
    ws.onopen = () => {
      if (g !== this.generation || this.closed) return;
      if (ws.protocol !== 'qrtoss.v1') {
        this.failed(new Error('VERSION_UNSUPPORTED'), g);
        return;
      }
      this.control('auth', { role: this.role, room: this.room, cap: this.cap });
      this.cap = '';
    };
    ws.onmessage = (event) => {
      if (g !== this.generation || this.closed) return;
      const raw = event.data;
      if (typeof raw !== 'string') {
        this.failed(new Error('PROTOCOL_ERROR'), g);
        return;
      }
      const bytes = new TextEncoder().encode(raw).length;
      if (bytes > C.MAX_WS_MESSAGE_BYTES || ++this.queued > C.MAX_RECEIVE_QUEUE_MESSAGES) {
        this.failed(new Error('MESSAGE_TOO_LARGE'), g);
        return;
      }
      this.queuedBytes += bytes;
      if (this.queuedBytes > C.MAX_SOCKET_BUFFER_BYTES) {
        this.failed(new Error('MESSAGE_TOO_LARGE'), g);
        return;
      }
      this.incoming = this.incoming
        .then(async () => {
          this.current(g);
          const message = object(JSON.parse(raw));
          if (message.type !== 'cipher' && bytes > C.MAX_CONTROL_MESSAGE_BYTES)
            throw new Error('MESSAGE_TOO_LARGE');
          await this.handle(message, g);
          this.current(g);
        })
        .catch((error) => this.failed(error, g))
        .finally(() => {
          this.queued--;
          this.queuedBytes -= bytes;
        });
    };
    ws.onclose = () => {
      void this.incoming.finally(() => {
        // A final control message can be delivered immediately before the close event.
        // Let it provide the specific reason instead of overwriting it with a network error.
        if (g === this.generation && !this.closed) {
          this.close();
          this.hooks.error('NETWORK_DISCONNECTED');
        }
      });
    };
    ws.onerror = () => {
      if (g === this.generation && !this.closed) this.failed(new Error('NETWORK_DISCONNECTED'), g);
    };
  }
  private control(type: string, fields: Record<string, unknown> = {}): void {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('NETWORK_DISCONNECTED');
    const data = JSON.stringify({ v: 1, type, ...fields });
    if (
      this.socket.bufferedAmount + new TextEncoder().encode(data).length >
      C.MAX_SOCKET_BUFFER_BYTES
    )
      throw new Error('SLOW_PEER');
    this.socket.send(data);
  }
  send(message: AppMessage): Promise<void> {
    const g = this.generation;
    const result = this.outgoing.then(async () => {
      this.current(g);
      if (!this.channel || (!this.active && !['ready', 'ready_ack'].includes(message.type)))
        throw new Error('PROTOCOL_ERROR');
      const envelope = await this.channel.encrypt(message);
      this.current(g);
      const { v: _v, type: _type, ...fields } = envelope;
      this.control('cipher', fields);
    });
    this.outgoing = result.catch((error) => this.failed(error, g));
    return result;
  }
  private async handle(raw: Record<string, unknown>, g: number): Promise<void> {
    if (raw.type === 'cipher') {
      if (!this.channel || !this.committed) throw new Error('PROTOCOL_ERROR');
      const app = await this.channel.decrypt(raw);
      this.current(g);
      if (!this.active) {
        if (this.role === 'receiver' && app.type === 'ready' && !this.ready) {
          this.ready = true;
          await this.send({ type: 'ready_ack' });
          this.current(g);
          this.control('pair.active', { peer: this.peer });
        } else if (this.role === 'sender' && app.type === 'ready_ack' && !this.ready) {
          this.ready = true;
          this.markConnected();
        } else throw new Error('PROTOCOL_ERROR');
        return;
      }
      if (['ready', 'ready_ack'].includes(app.type)) throw new Error('PROTOCOL_ERROR');
      const allowed =
        this.role === 'receiver' ? ['activity', 'status', 'data', 'ack_seen'] : ['mode', 'ack'];
      if (!allowed.includes(app.type)) throw new Error('PROTOCOL_ERROR');
      if (this.role === 'receiver' && ['activity', 'status', 'data'].includes(app.type))
        this.activity();
      await this.hooks.message(app);
      return;
    }
    const m = parseControl(raw);
    if (m.type === 'auth.ok') {
      if (m.role !== this.role || m.room !== this.room || this.heartbeat)
        throw new Error('PROTOCOL_ERROR');
      this.lastPong = time();
      this.heartbeat = setInterval(() => {
        try {
          if (time() - this.lastPong >= C.HEARTBEAT_TIMEOUT_SECONDS * 1000)
            throw new Error('NETWORK_DISCONNECTED');
          if (
            this.role === 'receiver' &&
            this.active &&
            time() - this.lastActivity >= C.SESSION_IDLE_SECONDS * 1000
          ) {
            this.close('idle_timeout');
            this.hooks.error('SESSION_EXPIRED');
            return;
          }
          if (this.touchPending) this.flushTouch();
          this.control('hb.ping', { id: this.hb++ });
        } catch (error) {
          this.failed(error, g);
        }
      }, C.HEARTBEAT_INTERVAL_SECONDS * 1000);
      this.pairingDeadline = time() + Number(m.pairingExpiresAt) - Number(m.serverTime);
      if (this.role === 'receiver') {
        this.phaseTo('waiting');
        this.hooks.pairing?.(
          `${location.origin}${this.paths.sender}#v=1&r=${this.room}&j=${this.join}&k=${this.psk}`,
          this.pairingDeadline,
        );
      } else {
        this.peer = String(m.peer);
        this.candidateDeadline = time() + Number(m.candidateExpiresAt) - Number(m.serverTime);
        this.phaseTo('pairing');
      }
      return;
    }
    if (m.type === 'error') {
      this.close();
      this.hooks.error(String(m.code));
      return;
    }
    if (!this.heartbeat) throw new Error('PROTOCOL_ERROR');
    if (m.type === 'hb.pong') {
      if (Number(m.id) >= this.hb) throw new Error('PROTOCOL_ERROR');
      this.lastPong = time();
      return;
    }
    if (m.type === 'room.closed') {
      this.close();
      this.hooks.error(String(m.code));
      return;
    }
    if (m.type === 'pair.candidate') {
      if (this.role !== 'receiver' || this.committed) throw new Error('PROTOCOL_ERROR');
      this.peer = String(m.peer);
      this.candidateDeadline = time() + Number(m.candidateExpiresAt) - Number(m.serverTime);
      this.rNonce = randomToken(32);
      this.keys = undefined;
      this.channel = undefined;
      this.phaseTo('pairing');
      this.control('pair.challenge', { peer: this.peer, rNonce: this.rNonce });
      return;
    }
    if (m.peer !== this.peer) throw new Error('PROTOCOL_ERROR');
    if (m.type === 'pair.candidate_closed') {
      if (this.role !== 'receiver' || this.committed) throw new Error('PROTOCOL_ERROR');
      this.peer = '';
      this.rNonce = '';
      this.keys = undefined;
      this.channel = undefined;
      this.phaseTo('waiting');
      return;
    }
    if (m.type === 'pair.challenge') {
      if (this.role !== 'sender' || this.keys) throw new Error('PROTOCOL_ERROR');
      this.rNonce = String(m.rNonce);
      const sNonce = randomToken(32);
      this.keys = await deriveKeys(this.psk, this.room, this.peer, this.rNonce, sNonce);
      this.current(g);
      this.channel = new CipherChannel(this.room, this.peer, this.role, this.keys);
      const proof = await makeProof(this.keys, 'sender');
      this.current(g);
      this.control('pair.proof', { peer: this.peer, sNonce, proof });
      return;
    }
    if (m.type === 'pair.proof') {
      if (this.role !== 'receiver' || this.keys || this.committed)
        throw new Error('PROTOCOL_ERROR');
      const candidate = this.peer;
      this.keys = await deriveKeys(this.psk, this.room, this.peer, this.rNonce, String(m.sNonce));
      this.current(g);
      const valid = await verifyProof(this.keys, 'sender', String(m.proof));
      this.current(g);
      if (
        candidate !== this.peer ||
        time() >= this.candidateDeadline ||
        time() >= this.pairingDeadline
      )
        return;
      if (!valid) {
        this.control('pair.reject', { peer: this.peer, code: 'AUTH_FAILED' });
        this.keys = undefined;
        return;
      }
      this.channel = new CipherChannel(this.room, this.peer, this.role, this.keys);
      this.control('pair.commit', { peer: this.peer });
      return;
    }
    if (m.type === 'pair.committed') {
      if (this.committed || !this.channel || !this.keys) throw new Error('PROTOCOL_ERROR');
      this.committed = true;
      this.idleDeadline = time() + Number(m.idleExpiresAt) - Number(m.serverTime);
      if (this.role === 'receiver') {
        const proof = await makeProof(this.keys, 'receiver');
        this.current(g);
        this.control('pair.confirm', { peer: this.peer, proof });
      }
      return;
    }
    if (m.type === 'pair.confirm') {
      if (this.role !== 'sender' || !this.committed || !this.keys)
        throw new Error('PROTOCOL_ERROR');
      const valid = await verifyProof(this.keys, 'receiver', String(m.proof));
      this.current(g);
      if (!valid) throw new Error('AUTH_FAILED');
      await this.send({ type: 'ready' });
      return;
    }
    if (m.type === 'pair.active') {
      if (this.active || !this.committed || !this.ready) throw new Error('PROTOCOL_ERROR');
      this.active = true;
      this.idleDeadline = time() + Number(m.idleExpiresAt) - Number(m.serverTime);
      this.markConnected();
      return;
    }
    if (m.type === 'room.touched') {
      if (!this.active) throw new Error('PROTOCOL_ERROR');
      this.idleDeadline = time() + Number(m.idleExpiresAt) - Number(m.serverTime);
      return;
    }
    throw new Error('PROTOCOL_ERROR');
  }
  private markConnected(): void {
    if (!this.active || !this.ready || this.phase === 'connected') return;
    this.psk = '';
    this.join = '';
    this.rNonce = '';
    this.keys = undefined;
    this.phaseTo('connected');
    if (this.role === 'receiver') {
      this.activity();
      void this.send({ type: 'mode', value: this.mode }).catch(() => {});
    }
  }
  async setMode(mode: Mode): Promise<void> {
    this.mode = mode;
    if (this.active) {
      this.activity();
      await this.send({ type: 'mode', value: mode });
    }
  }
  activity(): void {
    if (!this.active || this.role !== 'receiver') return;
    this.lastActivity = time();
    this.touchPending = true;
    if (
      time() - this.lastTouch >= C.TOUCH_COALESCE_SECONDS * 1000 ||
      this.idleDeadline - time() <= C.TOUCH_URGENT_REMAINING_SECONDS * 1000
    )
      this.flushTouch();
  }
  private flushTouch(): void {
    if (!this.touchPending || !this.active) return;
    this.control('room.touch', { peer: this.peer });
    this.lastTouch = time();
    this.touchPending = false;
  }
  close(reason = 'user_end'): void {
    if (this.closed) return;
    try {
      if (this.socket?.readyState === WebSocket.OPEN) this.control('room.close', { reason });
    } catch {
      /* best effort */
    }
    this.closed = true;
    this.generation++;
    clearInterval(this.heartbeat);
    this.fetchAbort?.abort();
    this.socket?.close();
    this.socket = undefined;
    this.channel = undefined;
    this.keys = undefined;
    this.cap = '';
    this.join = '';
    this.psk = '';
    this.rNonce = '';
    this.phaseTo('disconnected');
  }
  private failed(error: unknown, g: number): void {
    if (this.closed || g !== this.generation) return;
    const raw = error instanceof Error ? error.message : 'PROTOCOL_ERROR';
    const value = raw === 'CRYPTO_ERROR' ? 'PROTOCOL_ERROR' : raw;
    this.close('client_error');
    this.hooks.error(/^[A-Z_]+$/.test(value) ? value : 'PROTOCOL_ERROR');
  }
}
