import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createRelay, type RelayOptions } from '../../server/src/index.ts';
import { ipLimitKey, normalizeIp } from '../../server/src/ip.ts';

const ORIGIN = 'https://qrtoss.test';
const token = (size: number) => randomBytes(size).toString('base64url');

async function setup(t: test.TestContext, options: Partial<RelayOptions> = {}) {
  const relay = createRelay({ publicOrigin: ORIGIN, now: () => 0, trustProxyCidrs: ['127.0.0.1/32'], ...options });
  const url = await relay.listen();
  t.after(() => relay.close());
  const create = async (ip: string) => {
    // Invalid versions consume the IP bucket without retaining thousands of rooms.
    const response = await fetch(url + '/api/v1/rooms', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{"v":0}',
    });
    await response.arrayBuffer();
    return response.status;
  };
  const socket = (ip: string) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', 'qrtoss.v1', { origin: ORIGIN, headers: { 'x-forwarded-for': ip } });
    ws.on('error', () => {});
    t.after(() => ws.terminate());
    return ws;
  };
  return { create, socket };
}

test('IP normalization handles compressed, expanded, scoped and mapped IPv6', () => {
  const key = (ip: string, prefix = 64) => ipLimitKey(normalizeIp(ip)!, prefix);
  assert.equal(key('2001:DB8:1234:5601::1'), key('2001:0db8:1234:5601:ffff:ffff:ffff:ffff'));
  assert.notEqual(key('2001:db8:1234:5601::1'), key('2001:db8:1234:5602::1'));
  assert.equal(key('2001:db8:1234:5601::1', 56), key('2001:db8:1234:56ff::2', 56));
  assert.notEqual(key('2001:db8:1234:56ff::1', 56), key('2001:db8:1234:5700::1', 56));
  assert.equal(key('2001:db8:1234:5600::1', 57), key('2001:db8:1234:567f::2', 57));
  assert.notEqual(key('2001:db8:1234:567f::1', 57), key('2001:db8:1234:5680::1', 57));
  assert.notEqual(key('::1', 128), key('::2', 128));
  assert.equal(normalizeIp('fe80::1%eth0'), normalizeIp('fe80::1'));
  for (const ip of ['192.0.2.1', '::ffff:192.0.2.1', '::FFFF:c000:201', '0:0:0:0:0:ffff:c000:0201']) {
    assert.equal(normalizeIp(ip), '192.0.2.1');
    assert.equal(key(ip), '192.0.2.1');
  }
  for (const ip of ['', 'unknown', '::::', '2001:db8::g', '127.1', '192.0.2.999', '192.0.2.1:80']) {
    assert.equal(normalizeIp(ip), undefined);
  }
  for (const prefix of [0, -1, 129, 56.5, NaN]) {
    assert.throws(() => createRelay({ publicOrigin: ORIGIN, ipv6PrefixLength: prefix }), /IPV6_PREFIX_LENGTH_INVALID/);
  }
});

test('room creation shares a bucket across an IPv6 /64 and permits a different prefix', async t => {
  const { create } = await setup(t);
  for (let i = 1; i <= 5; i++) assert.equal(await create(`2001:db8:1:2::${i}`), 400);
  assert.equal(await create('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'), 429);
  assert.equal(await create('2001:db8:1:3::1'), 400);
});

test('configured IPv6 /56 aggregates adjacent /64 prefixes', async t => {
  const { create } = await setup(t, { ipv6PrefixLength: 56 });
  for (let i = 1; i <= 5; i++) assert.equal(await create(`2001:db8:1:12${i.toString(16).padStart(2, '0')}::1`), 400);
  assert.equal(await create('2001:db8:1:12ff::2'), 429);
  assert.equal(await create('2001:db8:1:1300::1'), 400);
});

test('IPv4-mapped IPv6 spellings cannot reset the IPv4 creation bucket', async t => {
  const { create } = await setup(t);
  for (const ip of ['192.0.2.1', '::ffff:192.0.2.1', '::ffff:c000:201', '::FFFF:C000:0201', '0:0:0:0:0:ffff:c000:201']) {
    assert.equal(await create(ip), 400);
  }
  assert.equal(await create('192.0.2.1'), 429);
  assert.equal(await create('192.0.2.2'), 400);
});

test('forwarded headers only affect limits behind a trusted proxy and must contain valid addresses', async t => {
  for (const trusted of [false, true]) {
    const { create } = await setup(t, { trustProxyCidrs: trusted ? ['127.0.0.1/32'] : [] });
    for (let i = 1; i <= 5; i++) assert.equal(await create(trusted ? `2001:db8:::${i}` : `192.0.2.${i}`), 400);
    assert.equal(await create(trusted ? '192.0.2.999' : '192.0.2.100'), 429);
  }
});

test('authentication failures share the IPv6 prefix bucket', async t => {
  const { socket } = await setup(t);
  for (let i = 1; i <= 21; i++) {
    const ws = socket(`2001:db8:1:2::${i.toString(16)}`);
    await once(ws, 'open');
    const response = once(ws, 'message');
    ws.send(JSON.stringify({ v: 1, type: 'auth', role: 'sender', room: token(16), cap: token(32) }));
    const [raw] = await response;
    assert.equal(JSON.parse(raw.toString()).code, i === 21 ? 'RATE_LIMITED' : 'PAIR_UNAVAILABLE');
    await once(ws, 'close');
  }
  const other = socket('2001:db8:1:3::1');
  await once(other, 'open');
  const response = once(other, 'message');
  other.send(JSON.stringify({ v: 1, type: 'auth', role: 'sender', room: token(16), cap: token(32) }));
  assert.equal(JSON.parse((await response)[0].toString()).code, 'PAIR_UNAVAILABLE');
});

test('concurrent sockets share the same IPv6 prefix and IPv4-mapped keys', async t => {
  for (const [firstIp, sameIp, otherIp] of [
    ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:3::1'],
    ['192.0.2.1', '::ffff:c000:201', '192.0.2.2'],
  ]) {
    const { socket } = await setup(t, { maxSocketsPerIp: 1 });
    const first = socket(firstIp);
    await once(first, 'open');
    const blocked = socket(sameIp);
    const [, response] = await once(blocked, 'unexpected-response');
    assert.equal(response.statusCode, 503);
    response.resume(); blocked.close();
    await once(socket(otherIp), 'open');
  }
});

test('bounded IP records evict the least recently accessed bucket', async t => {
  const { create } = await setup(t);
  const recent = '192.0.2.1', cold = '192.0.2.2';
  for (const ip of [recent, cold]) {
    for (let i = 0; i < 5; i++) assert.equal(await create(ip), 400);
    assert.equal(await create(ip), 429);
  }
  for (let i = 0; i < 4094; i++) assert.equal(await create(`198.18.${i >> 8}.${i & 255}`), 400);
  assert.equal(await create(recent), 429);
  assert.equal(await create('198.19.0.1'), 400);
  assert.equal(await create(recent), 429);
  assert.equal(await create(cold), 400);
});
