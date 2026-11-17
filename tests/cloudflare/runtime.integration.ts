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
  assert.equal(upgrade.headers['sec-websocket-extensions'] ?? '', '');
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
