import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createRelay } from '../../server/src/index.ts';
import { createTestRelay } from '../helpers/relay.ts';
import { websocketUpgrade } from '../helpers/upgrade.ts';

const ORIGIN = 'https://qrtoss.test';
const token = (n = 32) => randomBytes(n).toString('base64url');
type Message = Record<string, any>;
class Peer {
  ws: WebSocket;
  queue: Message[] = [];
  waiters: Array<{ type: string; resolve: (m: Message) => void }> = [];
  constructor(url: string, origin = ORIGIN) {
    this.ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', 'qrtoss.v1', { origin });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const index = this.waiters.findIndex((w) => w.type === m.type);
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(m);
      else this.queue.push(m);
    });
  }
  async open() {
    await once(this.ws, 'open');
  }
  send(type: string, fields: Message = {}) {
    this.ws.send(JSON.stringify({ v: 1, type, ...fields }));
  }
  async next(type: string): Promise<Message> {
    const index = this.queue.findIndex((m) => m.type === type);
    if (index >= 0) return this.queue.splice(index, 1)[0]!;
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2000);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}
async function setup(options: Parameters<typeof createRelay>[0] = { publicOrigin: ORIGIN }) {
  const relay = await createTestRelay(options);
  const url = await relay.listen();
  const create = async (body = '{"v":1}', origin = ORIGIN) =>
    fetch(url + '/api/v1/rooms', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body,
    });
  return { relay, url, create };
}
async function pair(url: string, room: Message, activate = true) {
  const receiver = new Peer(url);
  await receiver.open();
  receiver.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  await receiver.next('auth.ok');
  const sender = new Peer(url);
  await sender.open();
  sender.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  const auth = await sender.next('auth.ok');
  const candidate = await receiver.next('pair.candidate');
  assert.equal(auth.peer, candidate.peer);
  const peer = auth.peer;
  receiver.send('pair.challenge', { peer, rNonce: token() });
  await sender.next('pair.challenge');
  sender.send('pair.proof', { peer, sNonce: token(), proof: token() });
  await receiver.next('pair.proof');
  receiver.send('pair.commit', { peer });
  await receiver.next('pair.committed');
  await sender.next('pair.committed');
  receiver.send('pair.confirm', { peer, proof: token() });
  await sender.next('pair.confirm');
  const cipher = (client: Peer, dir: string, seq: string) =>
    client.send('cipher', { room: room.room, peer, dir, seq, ct: token(32) });
  if (!activate) return { receiver, sender, peer, cipher };
  cipher(sender, 's2r', '0');
  await receiver.next('cipher');
  cipher(receiver, 'r2s', '0');
  await sender.next('cipher');
  receiver.send('pair.active', { peer });
  await receiver.next('pair.active');
  await sender.next('pair.active');
  return { receiver, sender, peer, cipher };
}

test('HTTP routes enforce exact origin, bounded schema and safe headers', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  assert.equal((await create('{"v":1}', 'https://evil.test')).status, 403);
  assert.equal((await create('{"v":1,"psk":"secret"}')).status, 400);
  assert.equal((await create('{"v":2}')).status, 400);
  assert.equal((await create('"MESSAGE_TOO_LARGE"')).status, 400);
  const res = await create();
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const room = (await res.json()) as Message;
  assert.equal(room.room.length, 22);
  assert.equal(room.receiverCap.length, 43);
  assert.equal(room.senderJoinCap.length, 43);
  assert.notEqual(room.receiverCap, room.senderJoinCap);
  assert.ok(room.pairingExpiresAt - room.serverTime >= 59990);
  assert.ok(room.pairingExpiresAt - room.serverTime <= 60000);
  assert.deepEqual(await (await fetch(url + '/healthz')).json(), { status: 'ok' });
  assert.deepEqual(await (await fetch(url + '/readyz')).json(), { status: 'ready' });
  assert.equal((await fetch(url + '/missing')).status, 404);
});

test('relay forwards opaque envelopes only after mutual ready exchange; closes on seq replay', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const { receiver, sender, peer, cipher } = await pair(url, room);
  cipher(sender, 's2r', '1');
  const forwarded = await receiver.next('cipher');
  assert.equal(forwarded.seq, '1');
  assert.equal(forwarded.peer, peer);
  cipher(sender, 's2r', '1');
  assert.equal((await receiver.next('room.closed')).code, 'PROTOCOL_ERROR');
  assert.equal((await relay.stats()).rooms, 0);
});

test('candidate rejection preserves pairing QR and existing receiver', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const r = new Peer(url);
  await r.open();
  r.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  await r.next('auth.ok');
  const s = new Peer(url);
  await s.open();
  s.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  const { peer } = await s.next('auth.ok');
  await r.next('pair.candidate');
  const extra = new Peer(url);
  await extra.open();
  extra.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  assert.equal((await extra.next('error')).code, 'PEER_BUSY');
  r.send('pair.reject', { peer, code: 'AUTH_FAILED' });
  assert.equal((await r.next('pair.candidate_closed')).code, 'AUTH_FAILED');
  assert.equal((await relay.stats()).rooms, 1);
  const replacement = new Peer(url);
  await replacement.open();
  replacement.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  assert.notEqual((await replacement.next('auth.ok')).peer, peer);
});

test('invalid capability is generic and cannot replace authenticated receiver', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const r = new Peer(url);
  await r.open();
  r.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  await r.next('auth.ok');
  const invalid = new Peer(url);
  await invalid.open();
  invalid.send('auth', { role: 'receiver', room: room.room, cap: room.senderJoinCap });
  assert.equal((await invalid.next('error')).code, 'PAIR_UNAVAILABLE');
  const duplicate = new Peer(url);
  await duplicate.open();
  duplicate.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  assert.equal((await duplicate.next('error')).code, 'DUPLICATE_ROLE');
  assert.equal(r.ws.readyState, WebSocket.OPEN);
});

test('pairing deadlines use monotonic time and do not let late auth revive a room', async (t) => {
  let clock = 0;
  const { relay, url, create } = await setup({
    publicOrigin: ORIGIN,
    now: () => clock,
    wallNow: () => 1700000000000,
  });
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  clock = 60000;
  const r = new Peer(url);
  await r.open();
  r.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  assert.equal((await r.next('error')).code, 'PAIR_UNAVAILABLE');
  assert.equal((await relay.stats()).rooms, 0);
});

test('committed QR expires independently from active session; heartbeat does not extend idle', async (t) => {
  let clock = 0;
  const { relay, url, create } = await setup({ publicOrigin: ORIGIN, now: () => clock });
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const { receiver, sender, peer } = await pair(url, room);
  // Advance in heartbeat-sized increments so only idle, not liveness, expires.
  for (let step = 1; step <= 9; step++) {
    clock = step * 15000;
    receiver.send('hb.ping', { id: step });
    sender.send('hb.ping', { id: step });
    if (step < 8) {
      await receiver.next('hb.pong');
      await sender.next('hb.pong');
    } else break;
  }
  assert.equal((await receiver.next('room.closed')).code, 'SESSION_EXPIRED');
  assert.equal((await relay.stats()).rooms, 0);
  assert.ok(peer);
});

test('capacity and create rate limits are bounded', async (t) => {
  const { relay, create } = await setup({ publicOrigin: ORIGIN, maxRooms: 1 });
  t.after(() => relay.close());
  assert.equal((await create()).status, 201);
  assert.equal((await create()).status, 503);
  await create();
  await create();
  await create();
  const limited = await create();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '6');
});

test('rejects unsafe production origins and serves only local static paths', () => {
  assert.throws(() => createRelay({ publicOrigin: 'http://example.com' }));
  assert.throws(() => createRelay({ publicOrigin: 'https://example.com/' }));
  assert.throws(() => createRelay({ publicOrigin: 'https://user@example.com' }));
});

test('upgrade refuses missing or mismatched origin and subprotocol', async (t) => {
  const { relay, url } = await setup();
  t.after(() => relay.close());
  for (const [origin, protocol, expected] of [
    [undefined, 'qrtoss.v1', 403],
    ['https://evil.test', 'qrtoss.v1', 403],
    [ORIGIN, 'wrong.v1', 400],
  ] as const) {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', protocol, { origin });
    ws.on('error', () => {});
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode!);
        ws.close();
      });
    });
    assert.equal(status, expected);
  }
});

test('upgrade accepts only a single qrtoss.v1 offer, including across repeated headers', async (t) => {
  const { relay, url } = await setup();
  t.after(() => relay.close());
  // Miniflare's fetch adapter parses offers as a WebSocket client. Bypass it
  // and the fixture's WS proxy when sending malformed headers to workerd.
  const direct = 'mf' in relay ? await relay.mf.unsafeGetDirectURL() : undefined;
  const upgrade = (protocols?: string | string[]) =>
    websocketUpgrade(
      direct?.href ?? url + '/ws',
      ORIGIN,
      protocols,
      direct ? ORIGIN + '/ws' : undefined,
    );
  const invalid: (string | string[] | undefined)[] = [
    undefined,
    '',
    'wrong.v1',
    'QRTOSS.v1',
    'qrtoss.v10',
    'qrtoss.v1, other.v1',
    'other.v1, qrtoss.v1',
    'qrtoss.v1, qrtoss.v1',
    ',qrtoss.v1',
    'qrtoss.v1,',
    ['qrtoss.v1', 'other.v1'],
    ['qrtoss.v1', 'qrtoss.v1'],
  ];
  for (const protocols of invalid)
    assert.equal((await upgrade(protocols)).status, 400, JSON.stringify(protocols));
  assert.equal((await relay.stats()).sockets, 0);
  for (const protocols of ['qrtoss.v1', ' \tqrtoss.v1\t ']) {
    const response = await upgrade(protocols);
    assert.equal(response.status, 101);
    assert.equal(response.headers['sec-websocket-protocol'], 'qrtoss.v1');
  }
});

test('auth timeout is checked on late traffic as well as periodic sweep', async (t) => {
  let clock = 0;
  const { relay, url, create } = await setup({ publicOrigin: ORIGIN, now: () => clock });
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const late = new Peer(url);
  await late.open();
  clock = 5000;
  late.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  assert.equal((await late.next('error')).code, 'PAIR_UNAVAILABLE');
  const stale = new Peer(url);
  await stale.open();
  clock = 10000;
  await relay.sweep();
  assert.equal((await stale.next('error')).code, 'PAIR_UNAVAILABLE');
  assert.equal((await relay.stats()).rooms, 1);
});

test('late commit cannot revive an expired candidate', async (t) => {
  let clock = 0;
  const { relay, url, create } = await setup({ publicOrigin: ORIGIN, now: () => clock });
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const r = new Peer(url);
  await r.open();
  r.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  await r.next('auth.ok');
  const s = new Peer(url);
  await s.open();
  s.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  await s.next('auth.ok');
  const { peer } = await r.next('pair.candidate');
  clock = 10000;
  r.send('pair.commit', { peer });
  assert.equal((await r.next('pair.candidate_closed')).code, 'PAIR_TIMEOUT');
  // An old peer's commit is itself invalid; use sweep to expire without stale traffic in normal clients.
  assert.equal((await relay.stats()).rooms, 0);
});

test('late candidate timeout via sweep preserves receiver and enables new candidate', async (t) => {
  let clock = 0;
  const { relay, url, create } = await setup({ publicOrigin: ORIGIN, now: () => clock });
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const r = new Peer(url);
  await r.open();
  r.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  await r.next('auth.ok');
  const s = new Peer(url);
  await s.open();
  s.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  await s.next('auth.ok');
  await r.next('pair.candidate');
  clock = 10000;
  await relay.sweep();
  assert.equal((await r.next('pair.candidate_closed')).code, 'PAIR_TIMEOUT');
  assert.equal((await relay.stats()).rooms, 1);
  const replacement = new Peer(url);
  await replacement.open();
  replacement.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  await replacement.next('auth.ok');
});

test('binary, unknown field, double auth and overlarge control messages are rejected', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  for (const variant of ['binary', 'unknown', 'double', 'overlarge']) {
    const room = (await (await create()).json()) as Message;
    const r = new Peer(url);
    await r.open();
    r.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
    await r.next('auth.ok');
    if (variant === 'binary') r.ws.send(Buffer.from('{}'));
    if (variant === 'unknown') r.send('hb.ping', { id: 0, unexpected: true });
    if (variant === 'double')
      r.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
    if (variant === 'overlarge')
      r.ws.send(JSON.stringify({ v: 1, type: 'hb.ping', id: 0, pad: 'x'.repeat(2048) }));
    assert.equal(
      (await r.next('error')).code,
      variant === 'overlarge' ? 'MESSAGE_TOO_LARGE' : 'PROTOCOL_ERROR',
    );
  }
});

test('transport-rejected binary and oversized traffic preserve the room failure at the peer', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  for (const [payload, code, closeCode] of [
    [Buffer.from('{}'), 'PROTOCOL_ERROR', 1008],
    ['x'.repeat(32769), 'MESSAGE_TOO_LARGE', 1009],
  ] as const) {
    const room = (await (await create()).json()) as Message;
    const { receiver, sender } = await pair(url, room);
    const closed = once(sender.ws, 'close');
    sender.ws.send(payload);
    assert.equal((await receiver.next('room.closed')).code, code);
    assert.equal((await closed)[0], closeCode);
  }
});

test('sender cannot touch idle timeout, receiver cannot inject sender envelopes', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const { receiver, sender, peer } = await pair(url, room);
  sender.send('room.touch', { peer });
  assert.equal((await receiver.next('room.closed')).code, 'PROTOCOL_ERROR');
  const second = (await (await create()).json()) as Message;
  const pair2 = await pair(url, second);
  pair2.receiver.send('cipher', {
    room: second.room,
    peer: pair2.peer,
    dir: 's2r',
    seq: '1',
    ct: token(32),
  });
  assert.equal((await pair2.sender.next('room.closed')).code, 'PROTOCOL_ERROR');
});

test('HTTP body limit and hashed static assets obey cache and content boundaries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qrtoss-static-'));
  await mkdir(join(directory, 'assets'));
  await mkdir(join(directory, 'send'));
  await writeFile(join(directory, 'send', 'index.html'), '<!doctype html><title>Send</title>');
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>qrtoss</title>');
  await writeFile(join(directory, 'assets', 'main-1234abcd.js'), 'export {};');
  const { relay, url, create } = await setup({ publicOrigin: ORIGIN, staticDir: directory });
  t.after(async () => {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal((await create('{"v":1,"pad":"' + 'x'.repeat(2048) + '"}')).status, 413);
  const html = await fetch(url + '/send');
  assert.equal(await html.text(), '<!doctype html><title>Send</title>');
  assert.equal(await (await fetch(url + '/')).text(), '<!doctype html><title>qrtoss</title>');
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('cache-control'), 'no-store');
  const asset = await fetch(url + '/assets/main-1234abcd.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await fetch(url + '/assets/%2e%2e/LICENSE.md')).status, 404);
  assert.equal((await fetch(url + '/LICENSE.md')).status, 404);
});

test('sockets are released on shutdown and IPv4 trusted CIDR config validates', async () => {
  assert.throws(() => createRelay({ publicOrigin: ORIGIN, trustProxyCidrs: ['garbage'] }));
  const { relay, url } = await setup({ publicOrigin: ORIGIN, trustProxyCidrs: ['127.0.0.1/32'] });
  const peer = new Peer(url);
  await peer.open();
  const start = Date.now();
  await relay.close();
  assert.ok(Date.now() - start < 5000);
  assert.equal((await relay.stats()).rooms, 0);
});

test('commit consumes join capability and ready deadline cannot be extended by heartbeat', async (t) => {
  let clock = 0;
  const { relay, url, create } = await setup({ publicOrigin: ORIGIN, now: () => clock });
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const { receiver, sender } = await pair(url, room, false);
  const reuse = new Peer(url);
  await reuse.open();
  reuse.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  assert.equal((await reuse.next('error')).code, 'PAIR_UNAVAILABLE');
  clock = 9999;
  receiver.send('hb.ping', { id: 0 });
  sender.send('hb.ping', { id: 0 });
  await receiver.next('hb.pong');
  await sender.next('hb.pong');
  clock = 10000;
  await relay.sweep();
  assert.equal((await receiver.next('room.closed')).code, 'READY_TIMEOUT');
  assert.equal((await sender.next('room.closed')).code, 'READY_TIMEOUT');
});

test('commit before the QR deadline permits ready exchange after the deadline', async (t) => {
  let clock = 0;
  const { relay, url, create } = await setup({ publicOrigin: ORIGIN, now: () => clock });
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  clock = 59999;
  const { receiver, sender, peer, cipher } = await pair(url, room, false);
  clock = 60001;
  await relay.sweep();
  cipher(sender, 's2r', '0');
  await receiver.next('cipher');
  cipher(receiver, 'r2s', '0');
  await sender.next('cipher');
  receiver.send('pair.active', { peer });
  await receiver.next('pair.active');
  await sender.next('pair.active');
  cipher(sender, 's2r', '1');
  assert.equal((await receiver.next('cipher')).seq, '1');
  assert.equal((await relay.stats()).rooms, 1);
});

test('ACTIVE is forbidden before both sequence-zero envelopes are relayed', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const { receiver, sender, peer } = await pair(url, room, false);
  receiver.send('pair.active', { peer });
  assert.equal((await sender.next('room.closed')).code, 'PROTOCOL_ERROR');
});

test('auth failure rate limit preserves existing authenticated receiver', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const receiver = new Peer(url);
  await receiver.open();
  receiver.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  await receiver.next('auth.ok');
  for (let i = 0; i <= 20; i++) {
    const attempt = new Peer(url);
    await attempt.open();
    attempt.send('auth', { role: 'sender', room: room.room, cap: token() });
    assert.equal(
      (await attempt.next('error')).code,
      i === 20 ? 'RATE_LIMITED' : 'PAIR_UNAVAILABLE',
    );
  }
  assert.equal(receiver.ws.readyState, WebSocket.OPEN);
});

test('candidate can end normally without closing receiver or consuming QR', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const receiver = new Peer(url);
  await receiver.open();
  receiver.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  await receiver.next('auth.ok');
  const sender = new Peer(url);
  await sender.open();
  sender.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  await sender.next('auth.ok');
  await receiver.next('pair.candidate');
  const closed = once(sender.ws, 'close');
  sender.send('room.close', { reason: 'user_end' });
  assert.equal((await receiver.next('pair.candidate_closed')).code, 'PEER_CLOSED');
  assert.equal((await closed)[0], 1000);
  assert.equal((await relay.stats()).rooms, 1);
});

test('candidate failure sends exactly one error and releases the candidate', async (t) => {
  const { relay, url, create } = await setup();
  t.after(() => relay.close());
  const room = (await (await create()).json()) as Message;
  const receiver = new Peer(url);
  await receiver.open();
  receiver.send('auth', { role: 'receiver', room: room.room, cap: room.receiverCap });
  await receiver.next('auth.ok');
  const sender = new Peer(url);
  await sender.open();
  sender.send('auth', { role: 'sender', room: room.room, cap: room.senderJoinCap });
  await sender.next('auth.ok');
  const candidate = await receiver.next('pair.candidate');
  const closed = once(sender.ws, 'close');
  sender.send('invalid');
  assert.equal((await sender.next('error')).code, 'PROTOCOL_ERROR');
  assert.equal((await receiver.next('pair.candidate_closed')).peer, candidate.peer);
  await closed;
  assert.equal(sender.queue.filter((m) => m.type === 'error').length, 0);
});
