import { C } from '../../packages/protocol/src/constants.ts';
import { validateControlMessage } from '../../packages/protocol/src/control.ts';
import {
  SHARE_PAIR_SUBPROTOCOL,
  SharedPairingCipher,
  deriveSharedPairingKeys,
  makeSharedPairingProof,
  verifySharedPairingProof,
  type PairingAppMessage,
  type SharedPairingKeys,
} from '../../packages/protocol/src/shared.ts';
import { decodeBase64, exact } from '../../packages/protocol/src/validation.ts';
import { randomToken } from '../../packages/protocol/src/index.ts';
import type { AppPaths } from './paths.ts';
import { sharedInvitationURL, type SharedInvitation } from './shared-link.ts';

export type SharedPairingPhase = 'creating' | 'waiting' | 'pairing' | 'connected' | 'disconnected';
export type SharedPairingHooks = {
  phase(value: SharedPairingPhase): void;
  invitation?(url: string, expiresAt: number): void;
  message(message: PairingAppMessage): Promise<void> | void;
  error(code: string): void;
};

type Role = 'receiver' | 'sender';
type Control = Record<string, unknown> & { v: number; type: string };
const now = () => performance.now();
const encoder = new TextEncoder();

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PROTOCOL_ERROR');
  return value as Record<string, unknown>;
}

function socketURL(path: string): URL {
  const url = new URL(path, location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

export class SharedPairingSession {
  phase: SharedPairingPhase = 'creating';
  private socket?: WebSocket;
  private generation = 0;
  private closed = false;
  private pair = '';
  private cap = '';
  private join = '';
  private psk = '';
  private peer = '';
  private rNonce = '';
  private keys?: SharedPairingKeys;
  private channel?: SharedPairingCipher;
  private committed = false;
  private ready = false;
  private active = false;
  private pairingDeadline = 0;
  private candidateDeadline = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatId = 0;
  private lastPong = now();
  private incoming = Promise.resolve();
  private outgoing = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private abort?: AbortController;
  constructor(
    readonly role: Role,
    private readonly hooks: SharedPairingHooks,
    private readonly paths: Pick<AppPaths, 'pairings' | 'pairingSocket' | 'sender'>,
  ) {}
  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.closed;
  }
  private move(phase: SharedPairingPhase): void {
    this.phase = phase;
    this.hooks.phase(phase);
  }
  async startReceiver(): Promise<void> {
    const generation = this.generation;
    try {
      this.move('creating');
      this.abort = new AbortController();
      const timeout = setTimeout(() => this.abort?.abort(), 15_000);
      let response: Response;
      try {
        response = await fetch(this.paths.pairings, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"v":1}',
          cache: 'no-store',
          redirect: 'error',
          signal: this.abort.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!this.isCurrent(generation)) return;
      const value = record(await response.json());
      if (!response.ok) {
        const error = record(value.error);
        throw new Error(typeof error.code === 'string' ? error.code : 'SERVER_ERROR');
      }
      exact(value, [
        'v',
        'pair',
        'receiverCap',
        'controllerJoinCap',
        'serverTime',
        'pairingExpiresAt',
      ]);
      if (
        value.v !== 1 ||
        !Number.isSafeInteger(value.serverTime) ||
        !Number.isSafeInteger(value.pairingExpiresAt)
      )
        throw new Error('PROTOCOL_ERROR');
      this.pair = String(value.pair);
      this.cap = String(value.receiverCap);
      this.join = String(value.controllerJoinCap);
      decodeBase64(this.pair, 16);
      decodeBase64(this.cap, 32);
      decodeBase64(this.join, 32);
      this.psk = randomToken(32);
      this.pairingDeadline = now() + Number(value.pairingExpiresAt) - Number(value.serverTime);
      this.connect(generation);
    } catch (error) {
      this.fail(error, generation);
    }
  }
  startSender(invitation: SharedInvitation): void {
    try {
      this.pair = invitation.pair;
      this.cap = invitation.join;
      this.psk = invitation.psk;
      decodeBase64(this.pair, 16);
      decodeBase64(this.cap, 32);
      decodeBase64(this.psk, 32);
      this.connect(this.generation);
    } catch {
      this.fail(new Error('PAIR_LINK_INVALID'), this.generation);
    }
  }
  private connect(generation: number): void {
    const ws = new WebSocket(socketURL(this.paths.pairingSocket), SHARE_PAIR_SUBPROTOCOL);
    this.socket = ws;
    ws.onopen = () => {
      if (!this.isCurrent(generation)) return;
      if (ws.protocol !== SHARE_PAIR_SUBPROTOCOL)
        return this.fail(new Error('VERSION_UNSUPPORTED'), generation);
      this.control('auth', { role: this.role, room: this.pair, cap: this.cap });
      this.cap = '';
    };
    ws.onmessage = (event) => {
      if (!this.isCurrent(generation) || typeof event.data !== 'string') return;
      const bytes = encoder.encode(event.data).byteLength;
      this.queued++;
      this.queuedBytes += bytes;
      if (
        bytes > C.MAX_WS_MESSAGE_BYTES ||
        this.queued > C.MAX_RECEIVE_QUEUE_MESSAGES ||
        this.queuedBytes > C.MAX_SOCKET_BUFFER_BYTES
      )
        return this.fail(new Error('MESSAGE_TOO_LARGE'), generation);
      this.incoming = this.incoming
        .then(async () => {
          if (!this.isCurrent(generation)) return;
          const message = record(JSON.parse(event.data));
          if (message.type !== 'cipher' && bytes > C.MAX_CONTROL_MESSAGE_BYTES)
            throw new Error('MESSAGE_TOO_LARGE');
          await this.handle(message, generation);
        })
        .catch((error) => this.fail(error, generation))
        .finally(() => {
          this.queued--;
          this.queuedBytes -= bytes;
        });
    };
    ws.onerror = () => this.fail(new Error('NETWORK_DISCONNECTED'), generation);
    ws.onclose = () => {
      void this.incoming.finally(() => {
        if (this.isCurrent(generation)) this.fail(new Error('NETWORK_DISCONNECTED'), generation);
      });
    };
  }
  private control(type: string, fields: Record<string, unknown> = {}): void {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('NETWORK_DISCONNECTED');
    const value = JSON.stringify({ v: 1, type, ...fields });
    if (this.socket.bufferedAmount + encoder.encode(value).byteLength > C.MAX_SOCKET_BUFFER_BYTES)
      throw new Error('SLOW_PEER');
    this.socket.send(value);
  }
  send(message: PairingAppMessage): Promise<void> {
    const generation = this.generation;
    const result = this.outgoing.then(async () => {
      if (!this.isCurrent(generation) || !this.channel) throw new Error('PROTOCOL_ERROR');
      if (!this.active && !['ready', 'ready_ack'].includes(message.type))
        throw new Error('PROTOCOL_ERROR');
      const encrypted = await this.channel.encrypt(message);
      if (!this.isCurrent(generation)) return;
      const { v: _v, type: _type, ...fields } = encrypted;
      this.control('cipher', fields);
    });
    this.outgoing = result.catch((error) => this.fail(error, generation));
    return result;
  }
  private async handle(raw: Record<string, unknown>, generation: number): Promise<void> {
    if (raw.type === 'cipher') {
      if (!this.channel || !this.committed) throw new Error('PROTOCOL_ERROR');
      const message = await this.channel.decrypt(raw);
      if (!this.isCurrent(generation)) return;
      if (!this.active) {
        if (this.role === 'receiver' && message.type === 'ready' && !this.ready) {
          this.ready = true;
          await this.send({ type: 'ready_ack' });
          this.control('pair.active', { peer: this.peer });
        } else if (this.role === 'sender' && message.type === 'ready_ack' && !this.ready) {
          this.ready = true;
          this.markConnected();
        } else throw new Error('PROTOCOL_ERROR');
        return;
      }
      if (message.type === 'ready' || message.type === 'ready_ack')
        throw new Error('PROTOCOL_ERROR');
      const allowed = this.role === 'sender' ? ['p.hello', 'p.accept', 'p.reject'] : ['p.invite'];
      if (!allowed.includes(message.type)) throw new Error('PROTOCOL_ERROR');
      await this.hooks.message(message);
      return;
    }
    const message = validateControlMessage(raw, this.role) as Control;
    if (message.type === 'auth.ok') {
      if (message.role !== this.role || message.room !== this.pair || this.heartbeat)
        throw new Error('PROTOCOL_ERROR');
      this.lastPong = now();
      this.heartbeat = setInterval(() => {
        try {
          if (now() - this.lastPong >= C.HEARTBEAT_TIMEOUT_SECONDS * 1000)
            return this.fail(new Error('NETWORK_DISCONNECTED'), generation);
          this.control('hb.ping', { id: this.heartbeatId++ });
        } catch (error) {
          this.fail(error, generation);
        }
      }, C.HEARTBEAT_INTERVAL_SECONDS * 1000);
      this.pairingDeadline = now() + Number(message.pairingExpiresAt) - Number(message.serverTime);
      if (this.role === 'receiver') {
        this.move('waiting');
        const invitation = { pair: this.pair, join: this.join, psk: this.psk };
        this.hooks.invitation?.(
          sharedInvitationURL(location.origin, this.paths, invitation),
          this.pairingDeadline,
        );
      } else {
        this.peer = String(message.peer);
        this.candidateDeadline =
          now() + Number(message.candidateExpiresAt) - Number(message.serverTime);
        this.move('pairing');
      }
      return;
    }
    if (message.type === 'error' || message.type === 'room.closed') {
      this.close(false);
      this.hooks.error(String(message.code));
      return;
    }
    if (!this.heartbeat) throw new Error('PROTOCOL_ERROR');
    if (message.type === 'hb.pong') {
      if (Number(message.id) >= this.heartbeatId) throw new Error('PROTOCOL_ERROR');
      this.lastPong = now();
      return;
    }
    if (message.type === 'pair.candidate') {
      if (this.role !== 'receiver' || this.committed) throw new Error('PROTOCOL_ERROR');
      this.peer = String(message.peer);
      this.candidateDeadline =
        now() + Number(message.candidateExpiresAt) - Number(message.serverTime);
      this.rNonce = randomToken(32);
      this.keys = undefined;
      this.channel = undefined;
      this.move('pairing');
      this.control('pair.challenge', { peer: this.peer, rNonce: this.rNonce });
      return;
    }
    if (message.peer !== this.peer) throw new Error('PROTOCOL_ERROR');
    if (message.type === 'pair.candidate_closed') {
      if (this.role !== 'receiver' || this.committed) throw new Error('PROTOCOL_ERROR');
      this.peer = this.rNonce = '';
      this.keys = undefined;
      this.channel = undefined;
      this.move('waiting');
      return;
    }
    if (message.type === 'pair.challenge') {
      if (this.role !== 'sender' || this.keys) throw new Error('PROTOCOL_ERROR');
      this.rNonce = String(message.rNonce);
      const sNonce = randomToken(32);
      this.keys = await deriveSharedPairingKeys(
        this.psk,
        this.pair,
        this.peer,
        this.rNonce,
        sNonce,
      );
      if (!this.isCurrent(generation)) return;
      this.channel = new SharedPairingCipher(this.pair, this.peer, this.role, this.keys);
      const proof = await makeSharedPairingProof(this.keys, 'sender');
      this.control('pair.proof', { peer: this.peer, sNonce, proof });
      return;
    }
    if (message.type === 'pair.proof') {
      if (this.role !== 'receiver' || this.keys || this.committed)
        throw new Error('PROTOCOL_ERROR');
      const candidate = this.peer;
      this.keys = await deriveSharedPairingKeys(
        this.psk,
        this.pair,
        this.peer,
        this.rNonce,
        String(message.sNonce),
      );
      const valid = await verifySharedPairingProof(this.keys, 'sender', String(message.proof));
      if (!this.isCurrent(generation)) return;
      if (
        candidate !== this.peer ||
        now() >= this.candidateDeadline ||
        now() >= this.pairingDeadline
      )
        return;
      if (!valid) {
        this.control('pair.reject', { peer: this.peer, code: 'AUTH_FAILED' });
        this.keys = undefined;
        return;
      }
      this.channel = new SharedPairingCipher(this.pair, this.peer, this.role, this.keys);
      this.control('pair.commit', { peer: this.peer });
      return;
    }
    if (message.type === 'pair.committed') {
      if (this.committed || !this.channel || !this.keys) throw new Error('PROTOCOL_ERROR');
      this.committed = true;
      if (this.role === 'receiver') {
        const proof = await makeSharedPairingProof(this.keys, 'receiver');
        this.control('pair.confirm', { peer: this.peer, proof });
      }
      return;
    }
    if (message.type === 'pair.confirm') {
      if (this.role !== 'sender' || !this.committed || !this.keys)
        throw new Error('PROTOCOL_ERROR');
      if (!(await verifySharedPairingProof(this.keys, 'receiver', String(message.proof))))
        throw new Error('AUTH_FAILED');
      await this.send({ type: 'ready' });
      return;
    }
    if (message.type === 'pair.active') {
      if (this.active || !this.committed || !this.ready) throw new Error('PROTOCOL_ERROR');
      this.active = true;
      this.markConnected();
      return;
    }
    if (message.type === 'room.touched') return;
    throw new Error('PROTOCOL_ERROR');
  }
  private markConnected(): void {
    if (!this.active || !this.ready || this.phase === 'connected') return;
    this.psk = this.join = this.rNonce = '';
    this.keys = undefined;
    this.move('connected');
  }
  close(notify = true): void {
    if (this.closed) return;
    try {
      if (this.socket?.readyState === WebSocket.OPEN)
        this.control('room.close', { reason: 'user_end' });
    } catch {
      /* best effort */
    }
    this.closed = true;
    this.generation++;
    clearInterval(this.heartbeat);
    this.abort?.abort();
    this.socket?.close(1000);
    this.socket = undefined;
    this.channel = undefined;
    this.keys = undefined;
    this.cap = this.join = this.psk = this.rNonce = '';
    if (notify) this.move('disconnected');
  }
  private fail(error: unknown, generation: number): void {
    if (!this.isCurrent(generation)) return;
    const raw = error instanceof Error ? error.message : 'PROTOCOL_ERROR';
    this.close(false);
    this.move('disconnected');
    this.hooks.error(/^[A-Z_]+$/.test(raw) ? raw : 'PROTOCOL_ERROR');
  }
}
