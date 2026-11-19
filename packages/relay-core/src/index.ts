import { C } from '../../protocol/src/constants.ts';
import { validateControlMessage } from '../../protocol/src/control.ts';
import type { ControlMessage } from '../../protocol/src/control.generated.ts';
import { validateEnvelope } from '../../protocol/src/validation.ts';
import closeReasons from '../../../protocol/close-reasons.json' with { type: 'json' };
import { bucket, take, SendBudget, type Bucket } from './limits.ts';

type Json = Record<string, unknown>;
type State = 'CREATED' | 'WAITING' | 'CANDIDATE' | 'COMMITTED' | 'ACTIVE' | 'CLOSED';
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(message: string): void;
  close(code?: number): void;
}
export type Client = {
  ws: RelaySocket;
  ip: string;
  connected: number;
  heartbeat: number;
  room?: Room;
  role?: 'receiver' | 'sender';
  peer?: string;
  lastPing: number;
  messages: Bucket;
  bytes: Bucket;
  sendBudget?: SendBudget;
  authenticating: boolean;
  closed: boolean;
};
export type Room = {
  id: string;
  state: State;
  pairing: number;
  receiverHash?: Uint8Array;
  joinHash?: Uint8Array;
  receiver?: Client;
  sender?: Client;
  peer?: string;
  candidate: number;
  ready: number;
  idle: number;
  challenge: boolean;
  proof: boolean;
  confirm: boolean;
  seq: { s2r: bigint; r2s: bigint };
  candidates: Bucket;
};
export interface CoreOptions {
  now(): number;
  wallNow(): number;
  random(bytes: number): string;
  digest(capability: string): Promise<Uint8Array>;
  equal(a: Uint8Array, b: Uint8Array): Promise<boolean>;
  canAuthenticate(ip: string): boolean | Promise<boolean>;
  authenticationFailed(ip: string): void;
  /** Adapters without bufferedAmount can bound all bytes sent over a socket's lifetime. */
  maxSocketSendBytes?: number;
  onRoomClosed?(id: string): void;
}

/** Shared state machine. Adapters supply I/O, clocks, crypto, timers and admission. */
export function createRelayCore(options: CoreOptions) {
  const { now, wallNow } = options;
  const encoder = new TextEncoder();
  const rooms = new Map<string, Room>();
  const clients = new Set<Client>();
  function createRoom(id: string, receiverHash: Uint8Array, joinHash: Uint8Array) {
    if (rooms.has(id)) throw new Error('ROOM_ALREADY_CREATED');
    const t = now();
    const room: Room = {
      id,
      state: 'CREATED',
      pairing: t + C.PAIRING_TTL_SECONDS * 1000,
      receiverHash,
      joinHash,
      candidate: 0,
      ready: 0,
      idle: 0,
      challenge: false,
      proof: false,
      confirm: false,
      seq: { s2r: -1n, r2s: -1n },
      candidates: bucket(t, 10),
    };
    rooms.set(id, room);
    const serverTime = wallNow();
    return {
      serverTime,
      pairingExpiresAt: Math.round(serverTime + Math.max(0, room.pairing - now())),
    };
  }
  function connect(ws: RelaySocket, ip: string) {
    const t = now();
    const client: Client = {
      ws,
      ip,
      connected: t,
      heartbeat: t,
      lastPing: -1,
      messages: bucket(t, 40),
      bytes: bucket(t, 524288),
      sendBudget:
        options.maxSocketSendBytes === undefined
          ? undefined
          : new SendBudget(options.maxSocketSendBytes, 2 * C.MAX_CONTROL_MESSAGE_BYTES),
      authenticating: false,
      closed: false,
    };
    clients.add(client);
    return client;
  }
  function disconnect(client: Client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    const room = client.room;
    if (room) {
      if (client.role === 'sender' && room.state === 'CANDIDATE')
        closeCandidate(room, 'PEER_CLOSED');
      else closeRoom(room, 'PEER_CLOSED');
    }
  }
  function epoch(deadline: number) {
    return Math.round(wallNow() + Math.max(0, deadline - now()));
  }
  function send(c: Client | undefined, message: Json): boolean {
    if (c?.ws.readyState !== 1) return false;
    const encoded = JSON.stringify(message);
    const bytes = encoder.encode(encoded).byteLength;
    if (
      c.sendBudget &&
      !c.sendBudget.take(bytes, message.type === 'room.closed' || message.type === 'error')
    ) {
      if (c.room) closeRoom(c.room, 'SLOW_PEER', undefined, 1008);
      else c.ws.close(1008);
      return false;
    }
    if ((c.ws.bufferedAmount ?? 0) + bytes > C.MAX_SOCKET_BUFFER_BYTES) {
      if (c.room) closeRoom(c.room, 'SLOW_PEER');
      else c.ws.close(1008);
      return false;
    }
    c.ws.send(encoded);
    return true;
  }
  function notification(c: Client | undefined, type: string, fields: Json = {}) {
    return send(c, { v: 1, type, ...fields });
  }
  function closeRoom(room: Room, code: string, initiator?: Client, closeCode = 1000) {
    if (room.state === 'CLOSED') return;
    const beforeCommit = room.state !== 'COMMITTED' && room.state !== 'ACTIVE';
    room.state = 'CLOSED';
    rooms.delete(room.id);
    options.onRoomClosed?.(room.id);
    room.receiverHash = undefined;
    room.joinHash = undefined;
    for (const c of [room.receiver, room.sender]) {
      if (!c) continue;
      c.room = undefined;
      if (c !== initiator)
        notification(c, 'room.closed', {
          code: c.role === 'sender' && beforeCommit ? 'PAIR_UNAVAILABLE' : code,
        });
      c.ws.close(closeCode);
    }
    room.receiver = room.sender = undefined;
  }
  function closeCandidate(room: Room, code: string, closeCode = 1008, notifySender = true) {
    const sender = room.sender;
    room.sender = undefined;
    room.peer = undefined;
    room.challenge = room.proof = room.confirm = false;
    room.state = room.receiver ? 'WAITING' : 'CREATED';
    if (sender) {
      sender.room = undefined;
      if (notifySender) notification(sender, 'error', { code, scope: 'candidate' });
      sender.ws.close(closeCode);
      notification(room.receiver, 'pair.candidate_closed', { peer: sender.peer, code });
    }
  }
  function fail(c: Client, code = 'PROTOCOL_ERROR', close = 1008) {
    if (c.closed) return;
    notification(c, 'error', {
      code,
      scope: c.room
        ? c.role === 'sender' && c.room.state === 'CANDIDATE'
          ? 'candidate'
          : 'room'
        : 'socket',
    });
    if (c.room) {
      if (c.role === 'sender' && c.room.state === 'CANDIDATE')
        closeCandidate(c.room, code, close, false);
      else closeRoom(c.room, code, undefined, close);
    }
    c.ws.close(close);
  }
  function live(room: Room) {
    const t = now();
    if (room.state === 'CLOSED') return false;
    if (['CREATED', 'WAITING', 'CANDIDATE'].includes(room.state) && t >= room.pairing) {
      closeRoom(room, 'PAIR_EXPIRED');
      return false;
    }
    if (room.state === 'CANDIDATE' && t >= room.candidate) closeCandidate(room, 'PAIR_TIMEOUT');
    if (room.state === 'COMMITTED' && t >= room.ready) {
      closeRoom(room, 'READY_TIMEOUT');
      return false;
    }
    if (room.state === 'ACTIVE' && t >= room.idle) {
      closeRoom(room, 'SESSION_EXPIRED');
      return false;
    }
    return rooms.has(room.id);
  }
  function sweep() {
    for (const room of rooms.values()) live(room);
    const t = now();
    for (const c of clients) {
      if (
        (!c.role && t - c.connected >= C.AUTH_TIMEOUT_SECONDS * 1000) ||
        (c.role && t - c.heartbeat >= C.HEARTBEAT_TIMEOUT_SECONDS * 1000)
      )
        fail(c, c.role ? 'PEER_CLOSED' : 'PAIR_UNAVAILABLE');
    }
  }
  async function auth(c: Client, m: Extract<ControlMessage, { type: 'auth' }>) {
    // Complete all asynchronous work before checking and changing room state.
    if (!(await options.canAuthenticate(c.ip))) return fail(c, 'RATE_LIMITED');
    const actual = await options.digest(m.cap);
    const expectedRoom = rooms.get(m.room);
    const expectedHash =
      m.role === 'receiver' ? expectedRoom?.receiverHash : expectedRoom?.joinHash;
    const matches =
      !!expectedHash &&
      expectedHash.byteLength === actual.byteLength &&
      (await options.equal(expectedHash, actual));
    if (c.closed || c.ws.readyState !== 1) return;
    if (now() - c.connected >= C.AUTH_TIMEOUT_SECONDS * 1000) return fail(c, 'PAIR_UNAVAILABLE');
    const room = rooms.get(m.room);
    const available = room && live(room);
    const hash = m.role === 'receiver' ? room?.receiverHash : room?.joinHash;
    if (!available || room !== expectedRoom || hash !== expectedHash || !matches) {
      options.authenticationFailed(c.ip);
      return fail(c, 'PAIR_UNAVAILABLE');
    }
    if (m.role === 'receiver') {
      if (room.receiver || room.state !== 'CREATED') return fail(c, 'DUPLICATE_ROLE');
      c.role = 'receiver';
      c.room = room;
      room.receiver = c;
      room.state = 'WAITING';
      notification(c, 'auth.ok', {
        role: c.role,
        room: room.id,
        serverTime: wallNow(),
        pairingExpiresAt: epoch(room.pairing),
      });
    } else {
      if (!room.receiver || room.state === 'CREATED') return fail(c, 'PAIR_UNAVAILABLE');
      if (room.sender) return fail(c, 'PEER_BUSY');
      if (room.state !== 'WAITING') return fail(c, 'PAIR_UNAVAILABLE');
      if (!take(room.candidates, now(), 10 / 60, 10)) return fail(c, 'RATE_LIMITED');
      c.role = 'sender';
      c.room = room;
      c.peer = options.random(16);
      room.sender = c;
      room.peer = c.peer;
      room.state = 'CANDIDATE';
      room.candidate = Math.min(room.pairing, now() + C.CANDIDATE_TTL_SECONDS * 1000);
      const fields = {
        peer: c.peer,
        serverTime: wallNow(),
        candidateExpiresAt: epoch(room.candidate),
      };
      notification(c, 'auth.ok', {
        role: c.role,
        room: room.id,
        pairingExpiresAt: epoch(room.pairing),
        ...fields,
      });
      notification(room.receiver, 'pair.candidate', fields);
    }
    c.heartbeat = now();
  }
  async function message(c: Client, raw: Uint8Array | string, binary = false) {
    if (c.closed || c.ws.readyState !== 1) return;
    if (c.authenticating) return fail(c);
    const bytes = typeof raw === 'string' ? encoder.encode(raw) : raw;
    if (bytes.byteLength > C.MAX_WS_MESSAGE_BYTES) return fail(c, 'MESSAGE_TOO_LARGE', 1009);
    if (!c.role && now() - c.connected >= C.AUTH_TIMEOUT_SECONDS * 1000)
      return fail(c, 'PAIR_UNAVAILABLE');
    if (binary) return fail(c);
    const length = bytes.byteLength;
    if (!take(c.messages, now(), 20, 40) || !take(c.bytes, now(), 262144, 524288, length))
      return fail(c, 'RATE_LIMITED');
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
      );
    } catch {
      return fail(c);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(c);
    const m = parsed as Json;
    if (m.v !== 1) return fail(c, 'VERSION_UNSUPPORTED');
    if (m.type !== 'cipher' && length > C.MAX_CONTROL_MESSAGE_BYTES)
      return fail(c, 'MESSAGE_TOO_LARGE', 1009);
    if (!c.role) {
      let control: ControlMessage;
      try {
        control = validateControlMessage(m, 'server');
      } catch {
        return fail(c);
      }
      if (control.type !== 'auth') return fail(c);
      c.authenticating = true;
      try {
        return await auth(c, control);
      } finally {
        c.authenticating = false;
      }
    }
    const room = c.room;
    if (!room || !live(room) || c.room !== room) return;
    try {
      if (m.type === 'cipher') validateEnvelope(m);
      else validateControlMessage(m, 'server');
    } catch {
      return fail(c);
    }
    if (m.type === 'hb.ping') {
      if ((m.id as number) <= c.lastPing) return fail(c);
      c.lastPing = m.id as number;
      c.heartbeat = now();
      return void notification(c, 'hb.pong', { id: m.id, serverTime: wallNow() });
    }
    if (m.type === 'room.close') {
      const codes: Record<string, string> = closeReasons;
      if (c.role === 'sender' && room.state === 'CANDIDATE')
        return closeCandidate(room, 'PEER_CLOSED', 1000, false);
      return closeRoom(room, codes[m.reason as string]!, c);
    }
    if (m.type === 'cipher') {
      if (
        !['COMMITTED', 'ACTIVE'].includes(room.state) ||
        m.room !== room.id ||
        m.peer !== room.peer ||
        m.dir !== (c.role === 'sender' ? 's2r' : 'r2s')
      )
        return fail(c);
      const seq = BigInt(m.seq as string),
        dir = m.dir as 's2r' | 'r2s';
      if (
        seq !== room.seq[dir] + 1n ||
        !room.confirm ||
        (room.state === 'COMMITTED' && seq !== 0n) ||
        (c.role === 'receiver' && seq === 0n && room.seq.s2r !== 0n)
      )
        return fail(c);
      const target = c.role === 'sender' ? room.receiver : room.sender;
      if (target?.ws.readyState !== 1) return closeRoom(room, 'PEER_CLOSED');
      room.seq[dir] = seq;
      return void send(target, m);
    }
    if (m.peer !== room.peer) return fail(c);
    switch (m.type) {
      case 'pair.challenge':
        if (c.role !== 'receiver' || room.state !== 'CANDIDATE' || room.challenge) return fail(c);
        room.challenge = true;
        return void send(room.sender, m);
      case 'pair.proof':
        if (c.role !== 'sender' || room.state !== 'CANDIDATE' || !room.challenge || room.proof)
          return fail(c);
        room.proof = true;
        return void send(room.receiver, m);
      case 'pair.reject':
        if (c.role !== 'receiver' || room.state !== 'CANDIDATE') return fail(c);
        return closeCandidate(room, 'AUTH_FAILED');
      case 'pair.commit': {
        if (
          c.role !== 'receiver' ||
          room.state !== 'CANDIDATE' ||
          !room.proof ||
          now() >= room.candidate ||
          now() >= room.pairing ||
          room.sender?.ws.readyState !== 1
        )
          return fail(c);
        room.state = 'COMMITTED';
        room.joinHash = undefined;
        room.ready = now() + C.READY_TIMEOUT_SECONDS * 1000;
        room.idle = now() + C.SESSION_IDLE_SECONDS * 1000;
        const fields = {
          peer: room.peer,
          serverTime: wallNow(),
          readyExpiresAt: epoch(room.ready),
          idleExpiresAt: epoch(room.idle),
        };
        notification(room.receiver, 'pair.committed', fields);
        notification(room.sender, 'pair.committed', fields);
        return;
      }
      case 'pair.confirm':
        if (c.role !== 'receiver' || room.state !== 'COMMITTED' || room.confirm) return fail(c);
        room.confirm = true;
        return void send(room.sender, m);
      case 'pair.active': {
        if (
          c.role !== 'receiver' ||
          room.state !== 'COMMITTED' ||
          room.seq.s2r !== 0n ||
          room.seq.r2s !== 0n
        )
          return fail(c);
        const fields = { peer: room.peer, serverTime: wallNow(), idleExpiresAt: epoch(room.idle) };
        notification(room.receiver, 'pair.active', fields);
        notification(room.sender, 'pair.active', fields);
        if (rooms.has(room.id)) room.state = 'ACTIVE';
        return;
      }
      case 'room.touch': {
        if (c.role !== 'receiver' || room.state !== 'ACTIVE') return fail(c);
        room.idle = now() + C.SESSION_IDLE_SECONDS * 1000;
        const fields = { peer: room.peer, serverTime: wallNow(), idleExpiresAt: epoch(room.idle) };
        notification(room.receiver, 'room.touched', fields);
        notification(room.sender, 'room.touched', fields);
        return;
      }
      default:
        return fail(c);
    }
  }
  return {
    createRoom,
    connect,
    disconnect,
    message,
    fail,
    sweep,
    clients,
    stats: () => ({ rooms: rooms.size, sockets: clients.size }),
    shutdown() {
      for (const room of rooms.values()) closeRoom(room, 'SERVER_SHUTDOWN');
      for (const client of clients) {
        notification(client, 'error', { code: 'SERVER_SHUTDOWN', scope: 'socket' });
        client.ws.close(1000);
      }
    },
  };
}
