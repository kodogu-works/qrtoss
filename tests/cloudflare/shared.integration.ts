import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createCloudflareRelay } from './fixture.ts';
import { SC } from '../../packages/protocol/src/shared-constants.ts';

const ORIGIN = 'https://qrtoss.test';
const token = (bytes: number) => randomBytes(bytes).toString('base64url');

async function socket(url: string, path: string, protocol: string) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + path, protocol, { origin: ORIGIN });
  ws.on('error', () => {});
  await once(ws, 'open');
  return ws;
}

async function next(ws: WebSocket, type: string) {
  while (true) {
    const [raw] = await once(ws, 'message');
    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (value.type === type) return value;
  }
}

async function nextRaw(ws: WebSocket, type: string) {
  while (true) {
    const [raw] = await once(ws, 'message');
    const wire = raw.toString();
    const value = JSON.parse(wire) as Record<string, unknown>;
    if (value.type === type) return { value, bytes: Buffer.byteLength(wire) };
  }
}

test('shared pairing and network use isolated Cloudflare routes and Durable Objects', async (t) => {
  const relay = await createCloudflareRelay({ publicOrigin: ORIGIN });
  const url = await relay.listen();
  t.after(() => relay.close());

  const pairingResponse = await fetch(url + '/api/v2/pairings', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{"v":1}',
  });
  assert.equal(pairingResponse.status, 201);
  const pairing = (await pairingResponse.json()) as {
    pair: string;
    receiverCap: string;
    controllerJoinCap: string;
  };
  const receiver = await socket(url, '/api/v2/pairings/socket', 'qrtoss.share-pair.v1');
  receiver.send(
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'receiver',
      room: pairing.pair,
      cap: pairing.receiverCap,
    }),
  );
  assert.equal((await next(receiver, 'auth.ok')).room, pairing.pair);

  const controllerId = token(16);
  const networkResponse = await fetch(url + '/api/v2/networks', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, controllerId }),
  });
  assert.equal(networkResponse.status, 201);
  const network = (await networkResponse.json()) as {
    network: string;
    controllerCap: string;
  };
  const controller = await socket(url, '/api/v2/networks/socket', 'qrtoss.share.v1');
  controller.send(
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'controller',
      network: network.network,
      cap: network.controllerCap,
    }),
  );
  const authenticated = await next(controller, 'auth.ok');
  assert.equal(authenticated.network, network.network);
  assert.equal(authenticated.controllerId, controllerId);

  const memberId = token(16);
  const publicKey = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
  controller.send(
    JSON.stringify({
      v: 1,
      type: 'member.invite',
      memberId,
      idPub: publicKey,
      labelB64: Buffer.from('PC-A').toString('base64url'),
      sig: token(64),
    }),
  );
  const invitation = await next(controller, 'member.invited');
  assert.equal(invitation.memberId, memberId);
  assert.equal(typeof invitation.memberCap, 'string');

  const staleMemberId = token(16);
  controller.send(
    JSON.stringify({
      v: 1,
      type: 'member.invite',
      memberId: staleMemberId,
      idPub: publicKey,
      labelB64: Buffer.from('PC-stale').toString('base64url'),
      sig: token(64),
    }),
  );
  const staleInvitation = await next(controller, 'member.invited');
  assert.equal(staleInvitation.memberId, staleMemberId);

  const member = await socket(url, '/api/v2/networks/socket', 'qrtoss.share.v1');
  const revoked = next(controller, 'member.revoked');
  const added = next(controller, 'member.added');
  member.send(
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'member',
      network: network.network,
      cap: invitation.memberCap,
    }),
  );
  const memberAuthenticated = await next(member, 'auth.ok');
  assert.equal(memberAuthenticated.memberId, memberId);
  assert.equal(memberAuthenticated.epoch, 1);
  assert.deepEqual(
    [(await revoked).memberId, (await revoked).code, (await added).memberId],
    [staleMemberId, 'REVOKED', memberId],
  );

  const staleMember = await socket(url, '/api/v2/networks/socket', 'qrtoss.share.v1');
  const staleClosed = once(staleMember, 'close');
  staleMember.send(
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'member',
      network: network.network,
      cap: staleInvitation.memberCap,
    }),
  );
  assert.equal((await next(staleMember, 'error')).code, 'AUTH_FAILED');
  assert.equal((await staleClosed)[0], 1008);

  receiver.close();
  controller.close();
  member.close();
});

test('network capacity is independent from room and pairing capacity', async (t) => {
  const relay = await createCloudflareRelay({
    publicOrigin: ORIGIN,
    maxRooms: 2,
    maxNetworks: 1,
  });
  const url = await relay.listen();
  t.after(() => relay.close());
  const create = (path: string, body: object) =>
    fetch(url + path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await create('/api/v2/networks', { v: 1, controllerId: token(16) })).status, 201);
  assert.equal((await create('/api/v2/networks', { v: 1, controllerId: token(16) })).status, 503);
  assert.equal((await create('/api/v1/rooms', { v: 1 })).status, 201);
  assert.equal((await create('/api/v2/pairings', { v: 1 })).status, 201);
  const stats = await relay.stats();
  assert.equal(stats.capacity.networks, 1);
  assert.equal(stats.capacity.rooms, 2);
});

test('network flow acknowledgement and touch coalescing work through the Cloudflare bridge', async (t) => {
  let clock = 0;
  const relay = await createCloudflareRelay({
    publicOrigin: ORIGIN,
    now: () => clock,
    wallNow: () => 1700000000000 + clock,
  });
  const url = await relay.listen();
  t.after(() => relay.close());

  const controllerId = token(16);
  const response = await fetch(url + '/api/v2/networks', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, controllerId }),
  });
  assert.equal(response.status, 201);
  const credentials = (await response.json()) as { network: string; controllerCap: string };
  const controller = await socket(url, '/api/v2/networks/socket', 'qrtoss.share.v1');
  t.after(() => controller.close());
  const controllerAuthenticated = next(controller, 'auth.ok');
  controller.send(
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'controller',
      network: credentials.network,
      cap: credentials.controllerCap,
    }),
  );
  await controllerAuthenticated;

  const memberId = token(16);
  const invitationReply = next(controller, 'member.invited');
  controller.send(
    JSON.stringify({
      v: 1,
      type: 'member.invite',
      memberId,
      idPub: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
      labelB64: Buffer.from('flow-target').toString('base64url'),
      sig: token(64),
    }),
  );
  const invitation = await invitationReply;
  const member = await socket(url, '/api/v2/networks/socket', 'qrtoss.share.v1');
  t.after(() => member.close());
  const memberAuthenticated = next(member, 'auth.ok');
  member.send(
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'member',
      network: credentials.network,
      cap: invitation.memberCap,
    }),
  );
  await memberAuthenticated;

  let touchedReplies = 0;
  member.on('message', (raw) => {
    if ((JSON.parse(raw.toString()) as { type?: string }).type === 'net.touched') touchedReplies++;
  });
  const firstTouched = next(member, 'net.touched');
  member.send(JSON.stringify({ v: 1, type: 'net.touch' }));
  await firstTouched;
  assert.equal(touchedReplies, 1);

  clock = 5_000;
  const firstPong = next(member, 'hb.pong');
  member.send(JSON.stringify({ v: 1, type: 'net.touch' }));
  member.send(JSON.stringify({ v: 1, type: 'hb.ping', id: 0 }));
  await firstPong;
  assert.equal(touchedReplies, 1, 'touch responses inside 15 seconds are coalesced');

  clock = 15_000;
  const secondTouched = next(member, 'net.touched');
  member.send(JSON.stringify({ v: 1, type: 'net.touch' }));
  await secondTouched;
  assert.equal(touchedReplies, 2);

  let acknowledgedBytes = 0;
  const ciphertext = token(16_000);
  for (let sequence = 0; acknowledgedBytes <= SC.MAX_OUTSTANDING_BYTES; sequence++) {
    const forwarded = nextRaw(member, 'ucast');
    controller.send(
      JSON.stringify({
        v: 1,
        type: 'ucast',
        as: 'controller',
        to: memberId,
        seq: String(sequence),
        ct: ciphertext,
      }),
    );
    acknowledgedBytes += (await forwarded).bytes;
    const pong = next(member, 'hb.pong');
    member.send(JSON.stringify({ v: 1, type: 'flow.ack', bytes: acknowledgedBytes }));
    member.send(JSON.stringify({ v: 1, type: 'hb.ping', id: sequence + 1 }));
    await pong;
  }
  assert.ok(acknowledgedBytes > SC.MAX_OUTSTANDING_BYTES);
  assert.equal(member.readyState, WebSocket.OPEN);

  const protocolError = next(member, 'error');
  const memberClosed = once(member, 'close');
  member.send(JSON.stringify({ v: 1, type: 'flow.ack', bytes: acknowledgedBytes + 1 }));
  assert.equal((await protocolError).code, 'PROTOCOL_ERROR');
  assert.equal((await memberClosed)[0], 1008);

  const controllerPong = next(controller, 'hb.pong');
  controller.send(JSON.stringify({ v: 1, type: 'hb.ping', id: 0 }));
  await controllerPong;
  assert.equal(controller.readyState, WebSocket.OPEN, 'a member flow error is isolated');
});
