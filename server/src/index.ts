import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BlockList } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import C from '../../protocol/constants.json' with { type: 'json' };
import closeReasons from '../../protocol/close-reasons.json' with { type: 'json' };

type Json = Record<string, unknown>;
type State = 'CREATED' | 'WAITING' | 'CANDIDATE' | 'COMMITTED' | 'ACTIVE' | 'CLOSED';
type Bucket = { tokens: number; at: number };
type IpRecord = { at: number; create: Bucket; failures: Bucket };
type Client = {
  ws: WebSocket; ip: string; connected: number; heartbeat: number;
  room?: Room; role?: 'receiver' | 'sender'; peer?: string;
  lastPing: number; messages: Bucket; bytes: Bucket;
};
type Room = {
  id: string; state: State; pairing: number; receiverHash?: Buffer; joinHash?: Buffer;
  receiver?: Client; sender?: Client; peer?: string; candidate: number; ready: number; idle: number;
  challenge: boolean; proof: boolean; confirm: boolean; seq: { s2r: bigint; r2s: bigint };
  candidates: Bucket;
};
export interface RelayOptions {
  publicOrigin: string;
  staticDir?: string;
  now?: () => number;
  wallNow?: () => number;
  allowHttpLoopback?: boolean;
  maxRooms?: number;
  maxSockets?: number;
  maxUnauthenticatedSockets?: number;
  maxSocketsPerIp?: number;
  trustProxyCidrs?: string[];
}
const random = (n: number) => randomBytes(n).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest();
function b64(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return (bytes === undefined || decoded.length === bytes) && decoded.toString('base64url') === value;
}
function exact(o: Json, keys: string[]) {
  return Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
}
function bucket(at: number, tokens: number): Bucket { return { tokens, at }; }
function take(b: Bucket, now: number, rate: number, burst: number, amount = 1) {
  b.tokens = Math.min(burst, b.tokens + Math.max(0, now - b.at) * rate / 1000);
  b.at = now;
  if (b.tokens < amount) return false;
  b.tokens -= amount;
  return true;
}
function origin(value: string, allowHttp: boolean) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('PUBLIC_ORIGIN_INVALID');
  }
  return url;
}

/** In-memory, opaque ciphertext relay. No request, capability, or payload logging. */
export function createRelay(options: RelayOptions) {
  const publicUrl = origin(options.publicOrigin, options.allowHttpLoopback === true);
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const rooms = new Map<string, Room>();
  const clients = new Set<Client>();
  const ips = new Map<string, IpRecord>();
  const trusted = new BlockList();
  for (const cidr of options.trustProxyCidrs ?? []) {
    const [address, prefix] = cidr.split('/');
    if (!address || !prefix || !/^\d+$/.test(prefix)) throw new Error('TRUST_PROXY_CIDRS_INVALID');
    trusted.addSubnet(address, Number(prefix), address.includes(':') ? 'ipv6' : 'ipv4');
  }
  let stopping = false;
  const maxRooms = options.maxRooms ?? 1000;
  const maxSockets = options.maxSockets ?? 2200;
  const maxUnauthenticated = options.maxUnauthenticatedSockets ?? 100;
  const maxPerIp = options.maxSocketsPerIp ?? 60;
  for (const limit of [maxRooms, maxSockets, maxUnauthenticated, maxPerIp]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('LIMIT_INVALID');
  }
  const server = createServer((req, res) => { void http(req, res).catch(() => {
    if (!res.headersSent) reply(res, 500, 'SERVER_ERROR'); else res.destroy();
  }); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: C.MAX_WS_MESSAGE_BYTES, perMessageDeflate: false });
  function ipOf(req: IncomingMessage) {
    let ip = req.socket.remoteAddress ?? 'unknown';
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (trusted.check(normalized, normalized.includes(':') ? 'ipv6' : 'ipv4')) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') {
        // The trusted edge must overwrite this header. Use its immediate client.
        const candidate = forwarded.split(',').at(-1)?.trim();
        if (candidate && /^[a-fA-F0-9:.]+$/.test(candidate)) ip = candidate;
      }
    }
    return ip;
  }
  function ipRecord(ip: string) {
    let entry = ips.get(ip);
    if (!entry) {
      if (ips.size >= 4096) ips.delete(ips.keys().next().value!);
      const t = now();
      entry = { at: t, create: bucket(t, 5), failures: bucket(t, 20) };
      ips.set(ip, entry);
    }
    entry.at = now();
    return entry;
  }
  function headers(res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${publicUrl.host}; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (publicUrl.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  function reply(res: ServerResponse, status: number, code?: string, data?: unknown) {
    headers(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(code ? { v: 1, error: { code } } : data));
  }
  async function http(req: IncomingMessage, res: ServerResponse) {
    const path = req.url?.split('?')[0];
    if (req.url?.includes('?') && path === '/api/v1/rooms') return reply(res, 400, 'PROTOCOL_ERROR');
    if (path === '/healthz' || path === '/readyz') {
      if (req.method !== 'GET') return reply(res, 405, 'PROTOCOL_ERROR');
      return path === '/readyz' && stopping ? reply(res, 503, 'SERVER_SHUTDOWN') : reply(res, 200, undefined, { status: path === '/healthz' ? 'ok' : 'ready' });
    }
    if (path === '/api/v1/rooms') {
      if (req.method !== 'POST') return reply(res, 405, 'PROTOCOL_ERROR');
      if (req.headers.origin !== options.publicOrigin) return reply(res, 403, 'ORIGIN_DENIED');
      if (stopping) return reply(res, 503, 'SERVER_SHUTDOWN');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return reply(res, 400, 'PROTOCOL_ERROR');
      const ip = ipRecord(ipOf(req));
      if (!take(ip.create, now(), 10 / 60, 5)) {
        res.setHeader('Retry-After', '6');
        return reply(res, 429, 'RATE_LIMITED');
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > C.MAX_CONTROL_MESSAGE_BYTES) { reply(res, 413, 'MESSAGE_TOO_LARGE'); req.resume(); return; }
        chunks.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, 'PROTOCOL_ERROR'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !exact(body as Json, ['v'])) return reply(res, 400, 'PROTOCOL_ERROR');
      if ((body as Json).v !== 1) return reply(res, 400, 'VERSION_UNSUPPORTED');
      sweep();
      if (rooms.size >= maxRooms) return reply(res, 503, 'CAPACITY');
      const t = now();
      const id = random(16), receiverCap = random(32), senderJoinCap = random(32);
      const room: Room = { id, state: 'CREATED', pairing: t + C.PAIRING_TTL_SECONDS * 1000,
        receiverHash: digest(receiverCap), joinHash: digest(senderJoinCap), candidate: 0, ready: 0, idle: 0,
        challenge: false, proof: false, confirm: false, seq: { s2r: -1n, r2s: -1n }, candidates: bucket(t, 10) };
      rooms.set(id, room);
      return reply(res, 201, undefined, { v: 1, room: id, receiverCap, senderJoinCap, serverTime: wallNow(), pairingExpiresAt: epoch(room.pairing) });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'PROTOCOL_ERROR');
    if (!options.staticDir) return reply(res, 404, 'PROTOCOL_ERROR');
    const requested = path === '/' || path === '/send' ? 'index.html' : path?.startsWith('/assets/') ? path.slice(1) : null;
    if (!requested || requested.includes('..') || requested.includes('%') || requested.includes('\\')) return reply(res, 404, 'PROTOCOL_ERROR');
    const root = resolve(options.staticDir), file = resolve(root, requested);
    if (!file.startsWith(root + sep)) return reply(res, 404, 'PROTOCOL_ERROR');
    let content: Buffer;
    try { content = await readFile(file); } catch { return reply(res, 404, 'PROTOCOL_ERROR'); }
    headers(res);
    if (requested.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/.test(requested)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    const ext = requested.split('.').at(-1) ?? '';
    const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', wasm: 'application/wasm' };
    res.writeHead(200, { 'Content-Type': `${types[ext] ?? 'application/octet-stream'}${['html', 'js', 'css', 'json'].includes(ext) ? '; charset=utf-8' : ''}` });
    res.end(req.method === 'HEAD' ? undefined : content);
  }
  function epoch(deadline: number) { return Math.round(wallNow() + Math.max(0, deadline - now())); }
  function send(c: Client | undefined, message: Json): boolean {
    if (!c || c.ws.readyState !== WebSocket.OPEN) return false;
    const encoded = JSON.stringify(message);
    if (c.ws.bufferedAmount + Buffer.byteLength(encoded) > C.MAX_SOCKET_BUFFER_BYTES) {
      if (c.room) closeRoom(c.room, 'SLOW_PEER'); else c.ws.close(1008);
      return false;
    }
    c.ws.send(encoded);
    return true;
  }
  function notification(c: Client | undefined, type: string, fields: Json = {}) { return send(c, { v: 1, type, ...fields }); }
  function closeRoom(room: Room, code: string, initiator?: Client, closeCode = 1000) {
    if (room.state === 'CLOSED') return;
    const beforeCommit = room.state !== 'COMMITTED' && room.state !== 'ACTIVE';
    room.state = 'CLOSED';
    rooms.delete(room.id);
    room.receiverHash = undefined;
    room.joinHash = undefined;
    for (const c of [room.receiver, room.sender]) {
      if (!c) continue;
      c.room = undefined;
      if (c !== initiator) notification(c, 'room.closed', { code: c.role === 'sender' && beforeCommit ? 'PAIR_UNAVAILABLE' : code });
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
    notification(c, 'error', { code, scope: c.room ? c.role === 'sender' && c.room.state === 'CANDIDATE' ? 'candidate' : 'room' : 'socket' });
    if (c.room) {
      if (c.role === 'sender' && c.room.state === 'CANDIDATE') closeCandidate(c.room, code);
      else closeRoom(c.room, code, undefined, close);
    }
    c.ws.close(close);
  }
  function live(room: Room) {
    const t = now();
    if (room.state === 'CLOSED') return false;
    if (['CREATED', 'WAITING', 'CANDIDATE'].includes(room.state) && t >= room.pairing) { closeRoom(room, 'PAIR_EXPIRED'); return false; }
    if (room.state === 'CANDIDATE' && t >= room.candidate) closeCandidate(room, 'PAIR_TIMEOUT');
    if (room.state === 'COMMITTED' && t >= room.ready) { closeRoom(room, 'READY_TIMEOUT'); return false; }
    if (room.state === 'ACTIVE' && t >= room.idle) { closeRoom(room, 'SESSION_EXPIRED'); return false; }
    return rooms.has(room.id);
  }
  function sweep() {
    for (const room of rooms.values()) live(room);
    const t = now();
    for (const c of clients) {
      if ((!c.role && t - c.connected >= C.AUTH_TIMEOUT_SECONDS * 1000) ||
          (c.role && t - c.heartbeat >= C.HEARTBEAT_TIMEOUT_SECONDS * 1000)) fail(c, c.role ? 'PEER_CLOSED' : 'PAIR_UNAVAILABLE');
    }
    for (const [ip, value] of ips) if (t - value.at >= 60000) ips.delete(ip);
  }
  function auth(c: Client, m: Json) {
    if (!exact(m, ['v', 'type', 'role', 'room', 'cap']) || !['receiver', 'sender'].includes(String(m.role)) || !b64(m.room, 16) || !b64(m.cap, 32)) return fail(c);
    const limits = ipRecord(c.ip);
    take(limits.failures, now(), 20 / 60, 20, 0);
    if (limits.failures.tokens < 1) return fail(c, 'RATE_LIMITED');
    const room = rooms.get(m.room);
    if (room && !live(room)) return fail(c, 'PAIR_UNAVAILABLE');
    const hash = m.role === 'receiver' ? room?.receiverHash : room?.joinHash;
    if (!room || !hash || !timingSafeEqual(hash, digest(m.cap))) {
      take(limits.failures, now(), 20 / 60, 20);
      return fail(c, 'PAIR_UNAVAILABLE');
    }
    if (m.role === 'receiver') {
      if (room.receiver || room.state !== 'CREATED') return fail(c, 'DUPLICATE_ROLE');
      c.role = 'receiver'; c.room = room; room.receiver = c; room.state = 'WAITING';
      notification(c, 'auth.ok', { role: c.role, room: room.id, serverTime: wallNow(), pairingExpiresAt: epoch(room.pairing) });
    } else {
      if (!room.receiver || room.state === 'CREATED') return fail(c, 'PAIR_UNAVAILABLE');
      if (room.sender) return fail(c, 'PEER_BUSY');
      if (room.state !== 'WAITING') return fail(c, 'PAIR_UNAVAILABLE');
      if (!take(room.candidates, now(), 10 / 60, 10)) return fail(c, 'RATE_LIMITED');
      c.role = 'sender'; c.room = room; c.peer = random(16);
      room.sender = c; room.peer = c.peer; room.state = 'CANDIDATE';
      room.candidate = Math.min(room.pairing, now() + C.CANDIDATE_TTL_SECONDS * 1000);
      const fields = { peer: c.peer, serverTime: wallNow(), candidateExpiresAt: epoch(room.candidate) };
      notification(c, 'auth.ok', { role: c.role, room: room.id, pairingExpiresAt: epoch(room.pairing), ...fields });
      notification(room.receiver, 'pair.candidate', fields);
    }
    c.heartbeat = now();
  }
  function message(c: Client, raw: Buffer, binary: boolean) {
    if (!c.role && now() - c.connected >= C.AUTH_TIMEOUT_SECONDS * 1000) return fail(c, 'PAIR_UNAVAILABLE');
    if (binary) return fail(c);
    const length = raw.length;
    if (!take(c.messages, now(), 20, 40) || !take(c.bytes, now(), 262144, 524288, length)) return fail(c, 'RATE_LIMITED');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return fail(c); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(c);
    const m = parsed as Json;
    if (m.v !== 1) return fail(c, 'VERSION_UNSUPPORTED');
    if (m.type !== 'cipher' && length > C.MAX_CONTROL_MESSAGE_BYTES) return fail(c, 'MESSAGE_TOO_LARGE', 1009);
    if (!c.role) return m.type === 'auth' ? auth(c, m) : fail(c);
    const room = c.room;
    if (!room || !live(room) || c.room !== room) return;
    if (m.type === 'hb.ping') {
      if (!exact(m, ['v', 'type', 'id']) || !Number.isInteger(m.id) || (m.id as number) < 0 || (m.id as number) > 2147483647 || (m.id as number) <= c.lastPing) return fail(c);
      c.lastPing = m.id as number; c.heartbeat = now();
      return void notification(c, 'hb.pong', { id: m.id, serverTime: wallNow() });
    }
    if (m.type === 'room.close') {
      if (!exact(m, ['v', 'type', 'reason']) || typeof m.reason!=='string' || !Object.hasOwn(closeReasons,m.reason)) return fail(c);
      const codes: Record<string, string> = closeReasons;
      if (c.role === 'sender' && room.state === 'CANDIDATE') return closeCandidate(room, 'PEER_CLOSED', 1000, false);
      return closeRoom(room, codes[m.reason as string]!, c);
    }
    if (m.type === 'cipher') {
      if (!exact(m, ['v', 'type', 'room', 'peer', 'dir', 'seq', 'ct']) || !['COMMITTED', 'ACTIVE'].includes(room.state) || m.room !== room.id || m.peer !== room.peer || m.dir !== (c.role === 'sender' ? 's2r' : 'r2s') || typeof m.seq !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(m.seq) || !b64(m.ct)) return fail(c);
      const ciphertext = Buffer.from(m.ct, 'base64url');
      const seq = BigInt(m.seq), dir = m.dir as 's2r' | 'r2s';
      if (ciphertext.length < 16 || ciphertext.length > C.MAX_PLAINTEXT_BYTES + 16 || seq > 18446744073709551615n || seq !== room.seq[dir] + 1n || !room.confirm || (room.state === 'COMMITTED' && seq !== 0n) || (c.role === 'receiver' && seq === 0n && room.seq.s2r !== 0n)) return fail(c);
      const target = c.role === 'sender' ? room.receiver : room.sender;
      if (!target || target.ws.readyState !== WebSocket.OPEN) return closeRoom(room, 'PEER_CLOSED');
      room.seq[dir] = seq;
      return void send(target, m);
    }
    if (m.peer !== room.peer || !b64(m.peer, 16)) return fail(c);
    switch (m.type) {
      case 'pair.challenge':
        if (!exact(m, ['v', 'type', 'peer', 'rNonce']) || c.role !== 'receiver' || room.state !== 'CANDIDATE' || room.challenge || !b64(m.rNonce, 32)) return fail(c);
        room.challenge = true; return void send(room.sender, m);
      case 'pair.proof':
        if (!exact(m, ['v', 'type', 'peer', 'sNonce', 'proof']) || c.role !== 'sender' || room.state !== 'CANDIDATE' || !room.challenge || room.proof || !b64(m.sNonce, 32) || !b64(m.proof, 32)) return fail(c);
        room.proof = true; return void send(room.receiver, m);
      case 'pair.reject':
        if (!exact(m, ['v', 'type', 'peer', 'code']) || c.role !== 'receiver' || room.state !== 'CANDIDATE' || m.code !== 'AUTH_FAILED') return fail(c);
        return closeCandidate(room, 'AUTH_FAILED');
      case 'pair.commit': {
        if (!exact(m, ['v', 'type', 'peer']) || c.role !== 'receiver' || room.state !== 'CANDIDATE' || !room.proof || now() >= room.candidate || now() >= room.pairing || room.sender?.ws.readyState !== WebSocket.OPEN) return fail(c);
        room.state = 'COMMITTED'; room.joinHash = undefined;
        room.ready = now() + C.READY_TIMEOUT_SECONDS * 1000;
        room.idle = now() + C.SESSION_IDLE_SECONDS * 1000;
        const fields = { peer: room.peer, serverTime: wallNow(), readyExpiresAt: epoch(room.ready), idleExpiresAt: epoch(room.idle) };
        notification(room.receiver, 'pair.committed', fields); notification(room.sender, 'pair.committed', fields); return;
      }
      case 'pair.confirm':
        if (!exact(m, ['v', 'type', 'peer', 'proof']) || c.role !== 'receiver' || room.state !== 'COMMITTED' || room.confirm || !b64(m.proof, 32)) return fail(c);
        room.confirm = true; return void send(room.sender, m);
      case 'pair.active': {
        if (!exact(m, ['v', 'type', 'peer']) || c.role !== 'receiver' || room.state !== 'COMMITTED' || room.seq.s2r !== 0n || room.seq.r2s !== 0n) return fail(c);
        const fields = { peer: room.peer, serverTime: wallNow(), idleExpiresAt: epoch(room.idle) };
        notification(room.receiver, 'pair.active', fields); notification(room.sender, 'pair.active', fields);
        if (rooms.has(room.id)) room.state = 'ACTIVE';
        return;
      }
      case 'room.touch': {
        if (!exact(m, ['v', 'type', 'peer']) || c.role !== 'receiver' || room.state !== 'ACTIVE') return fail(c);
        room.idle = now() + C.SESSION_IDLE_SECONDS * 1000;
        const fields = { peer: room.peer, serverTime: wallNow(), idleExpiresAt: epoch(room.idle) };
        notification(room.receiver, 'room.touched', fields); notification(room.sender, 'room.touched', fields); return;
      }
      default: return fail(c);
    }
  }
  server.on('upgrade', (req, socket, head) => {
    function reject(status: number, code: string) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n${JSON.stringify({ v: 1, error: { code } })}`);
    }
    if (req.url !== '/ws') return reject(404, 'PROTOCOL_ERROR');
    if (req.headers.origin !== options.publicOrigin) return reject(403, 'ORIGIN_DENIED');
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(x => x.trim());
    if (!protocols || protocols.length !== 1 || protocols[0] !== 'qrtoss.v1') return reject(400, 'VERSION_UNSUPPORTED');
    if (stopping) return reject(503, 'SERVER_SHUTDOWN');
    const ip = ipOf(req);
    if (clients.size >= maxSockets || [...clients].filter(c => !c.role).length >= maxUnauthenticated || [...clients].filter(c => c.ip === ip).length >= maxPerIp) return reject(503, 'CAPACITY');
    wss.handleUpgrade(req, socket, head, ws => {
      const t = now();
      const client: Client = { ws, ip, connected: t, heartbeat: t, lastPing: -1, messages: bucket(t, 40), bytes: bucket(t, 524288) };
      clients.add(client);
      ws.on('message', (raw, binary) => {
        try { message(client, Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer), binary); } catch { fail(client, 'SERVER_ERROR', 1011); }
      });
      ws.on('error', error => {
        const oversized = (error as Error & { code?: string }).code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
        if (client.room) fail(client, oversized ? 'MESSAGE_TOO_LARGE' : 'PROTOCOL_ERROR', oversized ? 1009 : 1008);
      });
      ws.on('close', () => {
        clients.delete(client);
        const room = client.room;
        if (room) {
          if (client.role === 'sender' && room.state === 'CANDIDATE') closeCandidate(room, 'PEER_CLOSED');
          else closeRoom(room, 'PEER_CLOSED');
        }
      });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const interval = setInterval(sweep, 1000);
  interval.unref();
  return {
    server,
    sweep,
    stats: () => ({ rooms: rooms.size, sockets: clients.size }),
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
      return `http://${host}:${address.port}`;
    },
    async close() {
      stopping = true;
      clearInterval(interval);
      for (const room of rooms.values()) closeRoom(room, 'SERVER_SHUTDOWN');
      for (const client of clients) { notification(client, 'error', { code: 'SERVER_SHUTDOWN', scope: 'socket' }); client.ws.close(1000); }
      const timer = setTimeout(() => { for (const c of clients) c.ws.terminate(); }, 1000);
      timer.unref();
      await Promise.all([
        new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => wss.close(() => resolve())),
      ]);
      clearTimeout(timer);
    },
  };
}
