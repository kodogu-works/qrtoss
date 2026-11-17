import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createCloudflareRelay } from './fixture.ts';
import { Peer, pair } from '../interop/peer.ts';
import { responseHeaders } from '../../packages/relay-core/src/http.ts';
import { C } from '../../packages/protocol/src/constants.ts';
import { MAX_SOCKET_SEND_BYTES } from '../../server/cloudflare/src/limits.ts';
import { websocketUpgrade } from '../helpers/upgrade.ts';
const ORIGIN = 'https://qrtoss.test';
const token = (n = 32) => randomBytes(n).toString('base64url');
async function setup(
  t: test.TestContext,
  options: Parameters<typeof createCloudflareRelay>[0] = { publicOrigin: ORIGIN },
  settings: Parameters<typeof createCloudflareRelay>[1] = {},
) {
  const relay = await createCloudflareRelay(options, settings);
  const url = await relay.listen();
  t.after(() => relay.close());
  const create = async () => {
    const response = await fetch(url + '/api/v1/rooms', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{"v":1}',
    });
    assert.equal(response.status, 201);
    return (await response.json()) as { room: string; receiverCap: string; senderJoinCap: string };
  };
  return { relay, url, create };
}
async function socket(url: string, ip?: string) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', 'qrtoss.v1', {
    origin: ORIGIN,
    headers: ip ? { 'x-test-ip': ip } : {},
  });
  ws.on('error', () => {});
  await once(ws, 'open');
  return ws;
}

test('TD04: invalid first messages never reach RoomDO; compression is disabled', async (t) => {
  const { relay, url, create } = await setup(t);
  const room = await create();
  // Miniflare's outer development proxy negotiates its own compression.
  // Inspect workerd's native Worker socket, with the deployment's flags.
  const direct = await relay.mf.unsafeGetDirectURL();
  const upgrade = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(
      {
        host: direct.hostname,
        port: direct.port,
        path: ORIGIN + '/ws',
        headers: {
          Host: new URL(ORIGIN).host,
          Origin: ORIGIN,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          'Sec-WebSocket-Protocol': 'qrtoss.v1',
          'Sec-WebSocket-Extensions': 'permessage-deflate',
        },
      },
      (response) => {
        response.resume();
        resolve(response);
      },
    );
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(upgrade.statusCode, 101);
  assert.equal(upgrade.headers['sec-websocket-extensions'], undefined);
  for (const [payload, expected] of [
    [JSON.stringify({ v: 1, type: 'hb.ping', id: 0 }), 1008],
    [
      JSON.stringify({
        v: 1,
        type: 'auth',
        role: 'receiver',
        room: room.room,
        cap: room.receiverCap,
        extra: true,
      }),
      1008,
    ],
    [Buffer.from('{}'), 1008],
    ['x'.repeat(2049), 1009],
    ['{', 1008],
  ] as const) {
    const ws = await socket(url);
    assert.equal(ws.extensions, '');
    const closed = once(ws, 'close');
    ws.send(payload);
    assert.equal((await closed)[0], expected);
  }
  const stats = (await relay.control()) as unknown as { upgrades: number };
  assert.equal(stats.upgrades, 0);
});

test('TD04: subprotocol offers are validated before acquiring socket capacity', async (t) => {
  const { relay } = await setup(t, {
    publicOrigin: ORIGIN,
    maxSockets: 1,
    maxUnauthenticatedSockets: 1,
  });
  const direct = await relay.mf.unsafeGetDirectURL();
  for (const protocol of [
    undefined,
    '',
    'wrong.v1',
    'qrtoss.v1, other.v1',
    'other.v1, qrtoss.v1',
    'qrtoss.v1, qrtoss.v1',
    ',qrtoss.v1',
    'qrtoss.v1,',
  ]) {
    const response = await websocketUpgrade(direct.href, ORIGIN, protocol, ORIGIN + '/ws');
    assert.equal(response.status, 400, JSON.stringify(protocol));
    assert.deepEqual(JSON.parse(response.body), { v: 1, error: { code: 'VERSION_UNSUPPORTED' } });
  }
  assert.equal((await relay.control()).capacity.sockets, 0);
  const accepted = await websocketUpgrade(direct.href, ORIGIN, 'qrtoss.v1', ORIGIN + '/ws');
  assert.equal(accepted.status, 101);
  assert.equal(accepted.headers['sec-websocket-protocol'], 'qrtoss.v1');
});

test('TD05: unknown rooms and closed rooms have identical unavailable authentication', async (t) => {
  const { url, create } = await setup(t);
  const room = await create();
  const receiver = await Peer.connect(url, 'receiver', room.room, room.receiverCap, ORIGIN);
  const closed = once(receiver.ws, 'close');
  receiver.send({ type: 'room.close', reason: 'user_end' });
  await closed;
  for (const id of [room.room, token(16)]) {
    const ws = await socket(url),
      peer = new Peer(ws);
    peer.send({ type: 'auth', role: 'receiver', room: id, cap: room.receiverCap });
    assert.equal((await peer.next('error')).code, 'PAIR_UNAVAILABLE');
    peer.close();
  }
});

test('TD06: simultaneous candidates produce one winner; commit consumes the join capability', async (t) => {
  const { url, create } = await setup(t);
  const room = await create();
  const receiver = await Peer.connect(url, 'receiver', room.room, room.receiverCap, ORIGIN);
  const contenders = await Promise.all(
    Array.from({ length: 5 }, async () => new Peer(await socket(url))),
  );
  const replies = contenders.map((peer) =>
    Promise.race([peer.next('auth.ok'), peer.next('error')]),
  );
  for (const peer of contenders)
    peer.send({ type: 'auth', role: 'sender', room: room.room, cap: room.senderJoinCap });
  const results = await Promise.all(replies);
  assert.equal(results.filter((result) => result.type === 'auth.ok').length, 1);
  assert.equal(results.filter((result) => result.code === 'PEER_BUSY').length, 4);
  const winner = contenders[results.findIndex((result) => result.type === 'auth.ok')];
  const { peer } = await receiver.next('pair.candidate');
  receiver.send({ type: 'pair.challenge', peer, rNonce: token() });
  await winner.next('pair.challenge');
  winner.send({ type: 'pair.proof', peer, sNonce: token(), proof: token() });
  await receiver.next('pair.proof');
  receiver.send({ type: 'pair.commit', peer });
  await receiver.next('pair.committed');
  await winner.next('pair.committed');
  const reuse = new Peer(await socket(url));
  reuse.send({ type: 'auth', role: 'sender', room: room.room, cap: room.senderJoinCap });
  assert.equal((await reuse.next('error')).code, 'PAIR_UNAVAILABLE');
  receiver.close();
  reuse.close();
  for (const contender of contenders) contender.close();
});

test('TD07/TD08/TD09: restarting volatile RoomDOs closes sockets with valid codes and loses created rooms', async (t) => {
  const { relay, url, create } = await setup(t);
  const waiting = await create();
  const connected = await create();
  const receiver = await Peer.connect(
    url,
    'receiver',
    connected.room,
    connected.receiverCap,
    ORIGIN,
  );
  const closed = once(receiver.ws, 'close');
  await relay.control('restart-rooms');
  assert.equal((await closed)[0], 1011);
  for (const room of [waiting, connected]) {
    const peer = new Peer(await socket(url));
    peer.send({ type: 'auth', role: 'receiver', room: room.room, cap: room.receiverCap });
    assert.equal((await peer.next('error')).code, 'PAIR_UNAVAILABLE');
    peer.close();
  }
  const fresh = await create();
  const freshReceiver = await Peer.connect(url, 'receiver', fresh.room, fresh.receiverCap, ORIGIN);
  freshReceiver.close();
});

test('TD10: authentication frees unauthenticated capacity and per-IP socket limits return 429', async (t) => {
  const { relay, url, create } = await setup(t, {
    publicOrigin: ORIGIN,
    maxSockets: 2,
    maxUnauthenticatedSockets: 1,
    maxSocketsPerIp: 2,
  });
  const room = await create();
  const receiver = await Peer.connect(url, 'receiver', room.room, room.receiverCap, ORIGIN);
  const pending = await socket(url);
  const response = await relay.mf.dispatchFetch(ORIGIN + '/ws', {
    headers: {
      Origin: ORIGIN,
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': 'qrtoss.v1',
      'CF-Connecting-IP': '127.0.0.1',
    },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '6');
  assert.equal((await relay.control()).capacity.unauthenticated, 1);
  const otherIp = () =>
    relay.mf.dispatchFetch(ORIGIN + '/ws', {
      headers: {
        Origin: ORIGIN,
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': 'qrtoss.v1',
        'CF-Connecting-IP': '192.0.2.1',
      },
    });
  assert.equal((await otherIp()).status, 503);
  const sender = new Peer(pending);
  sender.send({ type: 'auth', role: 'sender', room: room.room, cap: room.senderJoinCap });
  await sender.next('auth.ok');
  assert.equal((await relay.control()).capacity.unauthenticated, 0);
  assert.equal((await otherIp()).status, 503);
  pending.terminate();
  receiver.close();
});

test('Cloudflare IP limits normalize mapped addresses, honor the IPv6 prefix and ignore forwarded headers', async (t) => {
  const { relay } = await setup(t, { publicOrigin: ORIGIN, now: () => 0, ipv6PrefixLength: 56 });
  const create = (ip: string, forwarded = '198.51.100.250') =>
    relay.mf.dispatchFetch(ORIGIN + '/api/v1/rooms', {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': ip,
        'X-Forwarded-For': forwarded,
      },
      body: '{"v":1}',
    });
  for (let i = 0; i < 5; i++)
    assert.equal((await create(`2001:db8:1:12${i.toString(16).padStart(2, '0')}::1`)).status, 201);
  const limited = await create('2001:db8:1:12ff::2');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '6');
  assert.equal((await create('2001:db8:1:1300::1')).status, 201);
  for (const ip of [
    '192.0.2.1',
    '::ffff:192.0.2.1',
    '::ffff:c000:201',
    '::FFFF:C000:0201',
    '0:0:0:0:0:ffff:c000:201',
  ])
    assert.equal((await create(ip)).status, 201);
  assert.equal((await create('192.0.2.1')).status, 429);
  for (let i = 0; i < 5; i++)
    assert.equal((await create('198.51.100.1', `192.0.2.${i}`)).status, 201);
  assert.equal((await create('198.51.100.1', '192.0.2.99')).status, 429);
});

test('TD10: CapacityDO restart and failed or timed-out admission preserve existing sockets', async (t) => {
  const { relay, url, create } = await setup(t);
  const room = await create();
  const receiver = await Peer.connect(url, 'receiver', room.room, room.receiverCap, ORIGIN);
  await relay.control('restart-capacity');
  assert.equal((await relay.control()).capacity.rooms, 0);
  for (const mode of ['unavailable', 'timeout']) {
    await relay.control('capacity-' + mode);
    const started = Date.now();
    const response = await fetch(url + '/api/v1/rooms', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{"v":1}',
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as any).error.code, 'CAPACITY');
    assert.ok(Date.now() - started < 5000);
    receiver.send({ type: 'hb.ping', id: mode === 'unavailable' ? 0 : 1 });
    await receiver.next('hb.pong');
  }
  await relay.control('capacity-normal');
  receiver.close();
});

test('TD10: room and authenticated socket leases recover within the 60-second renewal interval', async (t) => {
  let clock = 0;
  const { relay, url, create } = await setup(t, { publicOrigin: ORIGIN, now: () => clock });
  const room = await create();
  const receiver = await Peer.connect(url, 'receiver', room.room, room.receiverCap, ORIGIN);
  await relay.control('restart-capacity');
  assert.equal((await relay.control()).capacity.sockets, 0);
  for (let id = 0; id < 4; id++) {
    clock += 15_000;
    receiver.send({ type: 'hb.ping', id });
    await receiver.next('hb.pong');
  }
  let capacity = (await relay.control()).capacity;
  for (let tries = 0; tries < 100 && (!capacity.rooms || !capacity.sockets); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    capacity = (await relay.control()).capacity;
  }
  assert.equal(capacity.rooms, 1);
  assert.equal(capacity.sockets, 1);
  assert.equal(capacity.unauthenticated, 0);
  receiver.close();
});

test('TD10: delayed renewal after release does not consume capacity or per-IP socket slots', async (t) => {
  const { relay, url, create } = await setup(t, {
    publicOrigin: ORIGIN,
    now: () => 0,
    maxRooms: 1,
    maxSockets: 1,
    maxUnauthenticatedSockets: 1,
    maxSocketsPerIp: 1,
  });
  const { capacity } = await relay.control('release-before-renew');
  assert.equal(capacity.rooms, 0);
  assert.equal(capacity.sockets, 0);
  assert.equal(capacity.unauthenticated, 0);
  const room = await create();
  const receiver = await Peer.connect(url, 'receiver', room.room, room.receiverCap, ORIGIN);
  t.after(() => receiver.close());
  receiver.send({ type: 'hb.ping', id: 0 });
  await receiver.next('hb.pong');
  const current = (await relay.control()).capacity;
  assert.equal(current.rooms, 1);
  assert.equal(current.sockets, 1);
  assert.equal(current.unauthenticated, 0);
});

test('TD12/TD13: origin enforcement, route boundaries, security headers and asset bytes match', async (t) => {
  const { relay } = await setup(t);
  const expected = responseHeaders(new URL(ORIGIN));
  for (const path of ['/', '/send', '/healthz', '/readyz', '/not-found']) {
    const response = await relay.mf.dispatchFetch(ORIGIN + path);
    assert.equal(response.status, path === '/not-found' ? 404 : 200);
    for (const [name, value] of Object.entries(expected))
      assert.equal(response.headers.get(name), value);
    if (path === '/' || path === '/send') {
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        await readFile(path === '/' ? 'dist/web/index.html' : 'dist/web/send/index.html'),
      );
    }
  }
  for (const name of await readdir('dist/web/assets')) {
    const response = await relay.mf.dispatchFetch(ORIGIN + '/assets/' + name);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await readFile('dist/web/assets/' + name),
    );
  }
  for (const host of ['qrtoss.workers.dev', 'preview-qrtoss.workers.dev', 'wrong.example'])
    assert.equal((await relay.mf.dispatchFetch('https://' + host + '/')).status, 404);
  for (const path of ['/send/', '/send/index.html', '/LICENSE.md', '/api/v1/rooms?room=secret']) {
    const response = await relay.mf.dispatchFetch(ORIGIN + path);
    assert.equal(response.status, path.startsWith('/api') ? 400 : 404);
  }
});

test('TD12/TD13: a workers.dev origin supports encrypted transfer and rejects alternate hosts', async (t) => {
  const origin = 'https://qrtoss.my-account.workers.dev';
  const { relay, url } = await setup(t, { publicOrigin: origin });
  const { r, s } = await pair(url, origin);
  t.after(() => {
    r.close();
    s.close();
  });
  const response = await relay.mf.dispatchFetch(origin + '/');
  assert.equal(response.status, 200);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    await readFile('dist/web/index.html'),
  );
  for (const [name, value] of Object.entries(responseHeaders(new URL(origin))))
    assert.equal(response.headers.get(name), value);
  const message = {
    type: 'data' as const,
    id: token(16),
    textB64: Buffer.from('workers.dev transfer 日本語').toString('base64url'),
  };
  await s.app(message);
  assert.deepEqual(await r.receive(), message);
  await r.app({ type: 'ack', id: message.id, status: 'received' });
  assert.deepEqual(await s.receive(), { type: 'ack', id: message.id, status: 'received' });
  await s.app({ type: 'ack_seen', id: message.id });
  assert.deepEqual(await r.receive(), { type: 'ack_seen', id: message.id });
  for (const host of [
    'qrtoss.test',
    'qrtoss.other-account.workers.dev',
    'other-worker.my-account.workers.dev',
    'version-qrtoss.my-account.workers.dev',
  ])
    assert.equal((await relay.mf.dispatchFetch('https://' + host + '/')).status, 404);
  const denied = await relay.mf.dispatchFetch(origin + '/api/v1/rooms', {
    method: 'POST',
    headers: {
      Origin: 'https://qrtoss.other-account.workers.dev',
      'Content-Type': 'application/json',
    },
    body: '{"v":1}',
  });
  assert.equal(denied.status, 403);
});

test('TD11/TD14: encrypted transfer leaves no SQLite data or sensitive runtime logs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'qrtoss-do-persistence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { relay, url } = await setup(t, { publicOrigin: ORIGIN }, { persist: directory });
  const peers = await pair(url, ORIGIN);
  const marker = 'synthetic-private-transfer-keep-out-of-logs';
  await peers.s.app({
    type: 'data',
    id: token(16),
    textB64: Buffer.from(marker).toString('base64url'),
  });
  const envelope = await peers.r.next('cipher');
  const message = await peers.r.channel!.decrypt(envelope);
  assert.equal(message.type, 'data');
  peers.r.close();
  peers.s.close();
  await relay.close();
  const logs = relay.logs.join('\n');
  for (const secret of [
    marker,
    envelope.ct,
    peers.room,
    peers.peer,
    peers.psk,
    peers.receiverCap,
    peers.senderJoinCap,
  ])
    assert.equal(logs.includes(secret), false);
  async function inspect(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        await inspect(file);
        continue;
      }
      const content = await readFile(file);
      for (const secret of [
        marker,
        envelope.ct,
        peers.room,
        peers.peer,
        peers.psk,
        peers.receiverCap,
        peers.senderJoinCap,
      ])
        assert.equal(
          content.includes(Buffer.from(secret)),
          false,
          'sensitive data reached persistence',
        );
      if (!entry.name.endsWith('.sqlite')) {
        // workerd creates empty SQLite namespaces plus WAL/SHM metadata even
        // without application writes. Inspect their tables and bytes instead.
        assert.match(entry.name, /\.sqlite-(?:wal|shm)$/);
        continue;
      }
      const database = new DatabaseSync(file, { readOnly: true });
      try {
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        for (const { name } of tables) {
          assert.equal(typeof name, 'string');
          assert.equal(
            database
              .prepare('SELECT COUNT(*) AS n FROM "' + String(name).replaceAll('"', '""') + '"')
              .get()!.n,
            0,
            'DO table contains persisted data',
          );
        }
      } finally {
        database.close();
      }
    }
  }
  await inspect(directory);
});

test('invalid PUBLIC_ORIGIN or IPv6 prefix returns fixed configuration errors', async (t) => {
  for (const bindings of [
    { PUBLIC_ORIGIN: 'http://example.com' },
    { IPV6_PREFIX_LENGTH: '129' },
  ] as Record<string, string>[]) {
    const { relay } = await setup(t, { publicOrigin: ORIGIN }, { bindings });
    const response = await relay.mf.dispatchFetch(ORIGIN + '/');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { v: 1, error: { code: 'SERVER_ERROR' } });
  }
});

test('TD16: stopped readers cannot keep relay queues growing with heartbeat and touch', async (t) => {
  for (const dir of ['s2r', 'r2s'] as const) {
    for (const padded of [false, true]) {
      await t.test(`${dir}: ${padded ? 'Worker input' : 'RoomDO output'} allowance`, async (t) => {
        let clock = 0;
        const { relay, url } = await setup(t, {
          publicOrigin: ORIGIN,
          now: () => clock,
        });
        const direct = await relay.mf.unsafeGetDirectURL();
        const connect: typeof Peer.connect = async (_base, role, room, cap, origin) => {
          // Bypass the fixture's draining WS proxy: pause the actual TCP reader
          // connected to workerd, while continuing to send in the other direction.
          const ws = new WebSocket(`ws://${direct.host}/ws`, 'qrtoss.v1', {
            origin,
            headers: { Host: new URL(ORIGIN).host },
            finishRequest(request) {
              request.path = ORIGIN + '/ws';
              request.end();
            },
          });
          const peer = new Peer(ws);
          t.after(() => peer.close());
          await once(ws, 'open');
          peer.send({ type: 'auth', role, room, cap });
          await peer.next('auth.ok');
          return peer;
        };
        const peers = await pair(url, ORIGIN, connect);
        const healthy = await pair(url, ORIGIN);
        t.after(() => {
          healthy.r.close();
          healthy.s.close();
        });
        const target = dir === 's2r' ? peers.r : peers.s;
        const source = dir === 's2r' ? peers.s : peers.r;
        let receivedBytes = 0;
        target.ws.on('message', (data) => {
          receivedBytes += Buffer.byteLength(data as Buffer);
        });
        target.ws.pause();
        const closed = Promise.race([source.next('room.closed'), source.next('error')]);
        const sourceClosed = once(source.ws, 'close');
        let failure: Record<string, any> | undefined;
        let sentBytes = 0;
        const ct = token(padded ? 16 : C.MAX_PLAINTEXT_BYTES + 16);
        for (let seq = 1; sentBytes <= 2 * MAX_SOCKET_SEND_BYTES && !failure; seq++) {
          clock += 250;
          await relay.control();
          const envelope = JSON.stringify({
            v: 1,
            type: 'cipher',
            room: peers.room,
            peer: peers.peer,
            dir,
            seq: String(seq),
            ct,
          });
          // Whitespace counts on Worker -> RoomDO even though the core removes
          // it on output. This isolates the entry Worker's own lifetime limit.
          const payload = padded ? envelope.padEnd(C.MAX_WS_MESSAGE_BYTES) : envelope;
          sentBytes += Buffer.byteLength(payload);
          source.ws.send(payload);
          for (let i = 0; i < 2; i++) {
            target.send({ type: 'hb.ping', id: seq * 2 + i });
            peers.r.send({ type: 'room.touch', peer: peers.peer });
          }
          source.send({ type: 'hb.ping', id: seq });
          const reply = await Promise.race([source.next('hb.pong', (m) => m.id === seq), closed]);
          if (reply.type !== 'hb.pong') failure = reply;
        }
        assert.equal(failure?.code, 'SLOW_PEER');
        assert.equal(failure.type, padded ? 'error' : 'room.closed');
        assert.equal((await sourceClosed)[0], 1008);
        assert.equal(target.ws.isPaused, true);
        assert.ok(sentBytes <= MAX_SOCKET_SEND_BYTES + C.MAX_WS_MESSAGE_BYTES);
        const targetClosed = once(target.ws, 'close');
        target.ws.resume();
        assert.equal((await targetClosed)[0], 1008);
        assert.ok(receivedBytes <= MAX_SOCKET_SEND_BYTES);
        assert.equal((await relay.stats()).rooms, 1);
        healthy.r.send({ type: 'hb.ping', id: 1 });
        await healthy.r.next('hb.pong');
        await healthy.s.app({ type: 'activity' });
        assert.deepEqual(await healthy.r.receive(), { type: 'activity' });
      });
    }
  }
});

test('TD16: lifetime allowance permits 100 maximum-text transfers and their acknowledgements', async (t) => {
  let clock = 0;
  const { relay, url } = await setup(t, { publicOrigin: ORIGIN, now: () => clock });
  const { r, s } = await pair(url, ORIGIN);
  t.after(() => {
    r.close();
    s.close();
  });
  await r.app({ type: 'mode', value: 'display_only' });
  await s.receive();
  const textB64 = Buffer.alloc(C.MAX_TEXT_UTF8_BYTES, 'x').toString('base64url');
  for (let i = 0; i < C.MAX_TRANSFERS_PER_ROOM; i++) {
    clock += 250;
    const id = token(16);
    await s.app({ type: 'status', state: 'scanned' });
    await r.receive();
    await s.app({ type: 'data', id, textB64 });
    assert.deepEqual(await r.receive(), { type: 'data', id, textB64 });
    await r.app({ type: 'ack', id, status: 'received' });
    assert.deepEqual(await s.receive(), { type: 'ack', id, status: 'received' });
    await s.app({ type: 'ack_seen', id });
    assert.deepEqual(await r.receive(), { type: 'ack_seen', id });
  }
  assert.equal((await relay.stats()).rooms, 1);
  r.send({ type: 'room.close', reason: 'transfer_limit' });
  assert.equal((await s.next('room.closed')).code, 'TRANSFER_LIMIT');
});
