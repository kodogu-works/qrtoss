import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createRelay } from '../../server/src/index.ts';
import { websocketUpgrade } from '../helpers/upgrade.ts';

const ORIGIN = 'https://qrtoss.test';
const token = (bytes: number) => randomBytes(bytes).toString('base64url');
const label = (value: string) => Buffer.from(value).toString('base64url');
const publicKey = () => Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');

class Peer {
  readonly queue: Record<string, any>[] = [];
  readonly history: Record<string, any>[] = [];
  readonly waiters: Array<{ type: string; resolve: (message: Record<string, any>) => void }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.history.push(message);
      const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (index < 0) this.queue.push(message);
      else this.waiters.splice(index, 1)[0]!.resolve(message);
    });
  }
  static async connect(base: string, path: string, protocol: string) {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + path, protocol, { origin: ORIGIN });
    const peer = new Peer(ws);
    await once(ws, 'open');
    return peer;
  }
  send(type: string, fields: Record<string, unknown> = {}) {
    this.ws.send(JSON.stringify({ v: 1, type, ...fields }));
  }
  next(type: string): Promise<Record<string, any>> {
    const index = this.queue.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${type}`)), 2_000);
      this.waiters.push({
        type,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }
}

async function post(base: string, path: string, body: unknown) {
  return fetch(base + path, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('shared pairing uses a separate API and websocket subprotocol', async (t) => {
  const relay = createRelay({ publicOrigin: ORIGIN });
  const base = await relay.listen();
  t.after(() => relay.close());
  const response = await post(base, '/api/v2/pairings', { v: 1 });
  assert.equal(response.status, 201);
  const pairing = (await response.json()) as Record<string, any>;
  assert.equal(pairing.pair.length, 22);
  assert.equal(pairing.receiverCap.length, 43);
  assert.equal(pairing.controllerJoinCap.length, 43);
  assert.equal(pairing.room, undefined);
  const receiver = await Peer.connect(base, '/api/v2/pairings/socket', 'qrtoss.share-pair.v1');
  receiver.send('auth', { role: 'receiver', room: pairing.pair, cap: pairing.receiverCap });
  assert.equal((await receiver.next('auth.ok')).room, pairing.pair);
  assert.equal((await relay.stats()).pairings, 1);
  const rejected = await websocketUpgrade(base, ORIGIN, 'qrtoss.v1', '/api/v2/pairings/socket');
  assert.equal(rejected.status, 400);
});

test('network API binds authenticated identities and relays opaque traffic', async (t) => {
  const relay = createRelay({ publicOrigin: ORIGIN });
  const base = await relay.listen();
  t.after(() => relay.close());
  const controllerId = token(16);
  const response = await post(base, '/api/v2/networks', { v: 1, controllerId });
  assert.equal(response.status, 201);
  const created = (await response.json()) as Record<string, any>;
  assert.equal(created.network.length, 22);
  assert.equal(created.controllerCap.length, 43);
  assert.ok(created.idleExpiresAt > created.serverTime);
  const controller = await Peer.connect(base, '/api/v2/networks/socket', 'qrtoss.share.v1');
  controller.send('auth', {
    role: 'controller',
    network: created.network,
    cap: created.controllerCap,
  });
  assert.equal((await controller.next('auth.ok')).controllerId, controllerId);
  const memberId = token(16);
  controller.send('member.invite', {
    memberId,
    idPub: publicKey(),
    labelB64: label('PC A'),
    sig: token(64),
  });
  const invitation = await controller.next('member.invited');
  const member = await Peer.connect(base, '/api/v2/networks/socket', 'qrtoss.share.v1');
  member.send('auth', { role: 'member', network: created.network, cap: invitation.memberCap });
  assert.equal((await member.next('auth.ok')).memberId, memberId);
  controller.send('ucast', { as: 'controller', to: memberId, seq: '0', ct: token(16) });
  const forwarded = await member.next('ucast');
  assert.equal(forwarded.from, controllerId);
  assert.equal(forwarded.to, memberId);
  assert.equal((await relay.stats()).networks, 1);
});

test('network membership changes revoke capabilities issued for the previous epoch', async (t) => {
  const relay = createRelay({ publicOrigin: ORIGIN });
  const base = await relay.listen();
  t.after(() => relay.close());
  const response = await post(base, '/api/v2/networks', { v: 1, controllerId: token(16) });
  assert.equal(response.status, 201);
  const created = (await response.json()) as Record<string, any>;
  const controller = await Peer.connect(base, '/api/v2/networks/socket', 'qrtoss.share.v1');
  controller.send('auth', {
    role: 'controller',
    network: created.network,
    cap: created.controllerCap,
  });
  await controller.next('auth.ok');

  const acceptedId = token(16);
  controller.send('member.invite', {
    memberId: acceptedId,
    idPub: publicKey(),
    labelB64: label('accepted'),
    sig: token(64),
  });
  const accepted = await controller.next('member.invited');
  const staleId = token(16);
  controller.send('member.invite', {
    memberId: staleId,
    idPub: publicKey(),
    labelB64: label('stale'),
    sig: token(64),
  });
  const stale = await controller.next('member.invited');

  const member = await Peer.connect(base, '/api/v2/networks/socket', 'qrtoss.share.v1');
  member.send('auth', { role: 'member', network: created.network, cap: accepted.memberCap });
  assert.equal((await member.next('auth.ok')).memberId, acceptedId);
  assert.equal((await controller.next('member.revoked')).memberId, staleId);
  assert.equal((await controller.next('member.added')).memberId, acceptedId);
  const membershipEvents = controller.history.filter(
    (message) => message.type === 'member.revoked' || message.type === 'member.added',
  );
  assert.deepEqual(
    membershipEvents.map((message) => [message.type, message.memberId, message.code]),
    [
      ['member.revoked', staleId, 'REVOKED'],
      ['member.added', acceptedId, undefined],
    ],
  );

  const rejected = await Peer.connect(base, '/api/v2/networks/socket', 'qrtoss.share.v1');
  const closed = once(rejected.ws, 'close');
  rejected.send('auth', { role: 'member', network: created.network, cap: stale.memberCap });
  assert.equal((await rejected.next('error')).code, 'AUTH_FAILED');
  assert.equal((await closed)[0], 1008);
});

test('shared creation APIs reject unknown fields and malformed controller IDs', async (t) => {
  const relay = createRelay({ publicOrigin: ORIGIN });
  const base = await relay.listen();
  t.after(() => relay.close());
  assert.equal((await post(base, '/api/v2/pairings', { v: 1, psk: 'secret' })).status, 400);
  assert.equal((await post(base, '/api/v2/networks', { v: 1, controllerId: 'bad' })).status, 400);
  assert.equal(
    (await post(base, '/api/v2/networks', { v: 1, controllerId: token(16), extra: true })).status,
    400,
  );
});

test('legacy rooms and v2 pairings share capacity while networks use their own pool', async (t) => {
  const relay = createRelay({ publicOrigin: ORIGIN, maxRooms: 1, maxNetworks: 1 });
  const base = await relay.listen();
  t.after(() => relay.close());

  assert.equal((await post(base, '/api/v1/rooms', { v: 1 })).status, 201);
  assert.equal((await post(base, '/api/v2/pairings', { v: 1 })).status, 503);
  assert.equal(
    (await post(base, '/api/v2/networks', { v: 1, controllerId: token(16) })).status,
    201,
  );
  assert.equal(
    (await post(base, '/api/v2/networks', { v: 1, controllerId: token(16) })).status,
    503,
  );
});
