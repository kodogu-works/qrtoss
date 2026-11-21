import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createNetworkCore,
  type NetworkClient,
  type NetworkRelaySocket,
} from '../../packages/relay-core/src/network.ts';

const token = (bytes: number) => randomBytes(bytes).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();
const label = (value: string) => Buffer.from(value).toString('base64url');
const publicKey = () => Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');

class Socket implements NetworkRelaySocket {
  readyState = 1;
  bufferedAmount = 0;
  messages: Record<string, any>[] = [];
  wireBytes: number[] = [];
  closeCode?: number;

  send(value: string) {
    this.messages.push(JSON.parse(value));
    this.wireBytes.push(Buffer.byteLength(value));
  }

  close(code?: number) {
    this.closeCode = code;
    this.readyState = 3;
  }

  take(type: string) {
    return this.messages.findLast((message) => message.type === type);
  }
}

function fixture(authenticationFailed: (ip: string) => void = () => {}) {
  let clock = 0;
  const core = createNetworkCore({
    now: () => clock,
    wallNow: () => 1700000000000 + clock,
    random: token,
    digest: async (capability) => digest(capability),
    equal: async (left, right) => timingSafeEqual(left, right),
    canAuthenticate: () => true,
    authenticationFailed,
  });
  const network = token(16);
  const controllerId = token(16);
  const controllerCap = token(32);
  core.createNetwork(network, controllerId, digest(controllerCap));
  return {
    core,
    network,
    controllerId,
    controllerCap,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
  };
}

async function connectController(context: ReturnType<typeof fixture>) {
  const socket = new Socket();
  const client = context.core.connect(socket, 'controller-ip');
  await context.core.message(
    client,
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'controller',
      network: context.network,
      cap: context.controllerCap,
    }),
  );
  assert.equal(socket.take('auth.ok')?.role, 'controller');
  return { socket, client };
}

async function invite(
  context: ReturnType<typeof fixture>,
  controller: NetworkClient,
  name: string,
) {
  const memberId = token(16);
  await context.core.message(
    controller,
    JSON.stringify({
      v: 1,
      type: 'member.invite',
      memberId,
      idPub: publicKey(),
      labelB64: label(name),
      sig: token(64),
    }),
  );
  const controllerSocket = controller.ws as Socket;
  const response = controllerSocket.messages.findLast(
    (message) => message.type === 'member.invited' && message.memberId === memberId,
  );
  assert.ok(response?.memberCap);
  return { memberId, memberCap: response.memberCap as string };
}

async function join(
  context: ReturnType<typeof fixture>,
  invitation: Awaited<ReturnType<typeof invite>>,
  ip = token(4),
) {
  const socket = new Socket();
  const client = context.core.connect(socket, ip);
  await context.core.message(
    client,
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'member',
      network: context.network,
      cap: invitation.memberCap,
    }),
  );
  return { socket, client, memberId: invitation.memberId };
}

test('member capabilities are consumed atomically and signed membership advances epochs', async () => {
  const context = fixture();
  const controller = await connectController(context);
  const invitation = await invite(context, controller.client, 'PC A');
  const sockets = [new Socket(), new Socket()];
  const clients = sockets.map((socket, index) => context.core.connect(socket, `member-${index}`));
  await Promise.all(
    clients.map((client) =>
      context.core.message(
        client,
        JSON.stringify({
          v: 1,
          type: 'auth',
          role: 'member',
          network: context.network,
          cap: invitation.memberCap,
        }),
      ),
    ),
  );

  const accepted = sockets.filter((socket) => socket.take('auth.ok'));
  assert.equal(accepted.length, 1);
  const authOk = accepted[0]!.take('auth.ok');
  assert.ok(authOk);
  assert.equal(authOk.epoch, 1);
  assert.deepEqual(
    authOk.members.map((member: any) => member.memberId),
    [invitation.memberId],
  );
  assert.equal(sockets.filter((socket) => socket.take('error')).length, 1);
  assert.equal(
    sockets.find((socket) => socket.take('error'))?.take('error')?.code,
    'MEMBER_CAP_USED',
  );
  assert.equal(context.core.networks.get(context.network)?.pending.size, 0);

  await context.core.message(
    controller.client,
    JSON.stringify({
      v: 1,
      type: 'member.invite',
      memberId: invitation.memberId,
      idPub: publicKey(),
      labelB64: label('duplicate'),
      sig: token(64),
    }),
  );
  assert.equal(controller.socket.take('error')?.code, 'MEMBER_ID_REUSED');
});

test('a membership change revokes every capability from the previous epoch before member.added', async () => {
  const context = fixture();
  const controller = await connectController(context);
  const accepted = await invite(context, controller.client, 'accepted');
  const stale = await invite(context, controller.client, 'stale');
  const beforeJoin = controller.socket.messages.length;

  const acceptedMember = await join(context, accepted);
  const membershipEvents = controller.socket.messages
    .slice(beforeJoin)
    .filter((message) => message.type === 'member.revoked' || message.type === 'member.added');
  assert.deepEqual(
    membershipEvents.map((message) => [message.type, message.memberId, message.code]),
    [
      ['member.revoked', stale.memberId, 'REVOKED'],
      ['member.added', accepted.memberId, undefined],
    ],
  );
  assert.equal(context.core.networks.get(context.network)?.pending.size, 0);

  const rejected = await join(context, stale);
  assert.equal(rejected.socket.take('error')?.code, 'AUTH_FAILED');
  assert.equal(rejected.socket.closeCode, 1008);

  const staleAfterRemoval = await invite(context, controller.client, 'stale-after-removal');
  const beforeRemoval = controller.socket.messages.length;
  await context.core.message(acceptedMember.client, JSON.stringify({ v: 1, type: 'net.leave' }));
  assert.deepEqual(
    controller.socket.messages
      .slice(beforeRemoval)
      .filter((message) => message.type === 'member.revoked' || message.type === 'member.removed')
      .map((message) => [message.type, message.memberId, message.code]),
    [
      ['member.revoked', staleAfterRemoval.memberId, 'REVOKED'],
      ['member.removed', accepted.memberId, undefined],
    ],
  );
  assert.equal((await join(context, staleAfterRemoval)).socket.take('error')?.code, 'AUTH_FAILED');

  const staleBeforeControllerJoin = await invite(
    context,
    controller.client,
    'stale-before-controller-join',
  );
  const controllerMemberId = token(16);
  const beforeControllerJoin = controller.socket.messages.length;
  await context.core.message(
    controller.client,
    JSON.stringify({
      v: 1,
      type: 'controller.join',
      memberId: controllerMemberId,
      idPub: publicKey(),
      labelB64: label('controller'),
      sig: token(64),
    }),
  );
  assert.deepEqual(
    controller.socket.messages
      .slice(beforeControllerJoin)
      .filter((message) => message.type === 'member.revoked' || message.type === 'member.added')
      .map((message) => [message.type, message.memberId, message.code]),
    [
      ['member.revoked', staleBeforeControllerJoin.memberId, 'REVOKED'],
      ['member.added', controllerMemberId, undefined],
    ],
  );
  assert.equal(
    (await join(context, staleBeforeControllerJoin)).socket.take('error')?.code,
    'AUTH_FAILED',
  );
});

test('an invite whose digest crosses an epoch change fails with EPOCH_MISMATCH', async () => {
  let clock = 0;
  const firstCapability = token(32);
  const delayedCapability = token(32);
  const generated = [firstCapability, delayedCapability];
  const delayedHash = Promise.withResolvers<Uint8Array>();
  const core = createNetworkCore({
    now: () => clock,
    wallNow: () => 1700000000000 + clock,
    random: () => generated.shift()!,
    digest: async (capability) =>
      capability === delayedCapability ? delayedHash.promise : digest(capability),
    equal: async (left, right) => timingSafeEqual(left, right),
    canAuthenticate: () => true,
    authenticationFailed: () => {},
  });
  const network = token(16);
  const controllerId = token(16);
  const controllerCap = token(32);
  core.createNetwork(network, controllerId, digest(controllerCap));
  const context = {
    core,
    network,
    controllerId,
    controllerCap,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
  };
  const controller = await connectController(context);
  const accepted = await invite(context, controller.client, 'accepted');
  assert.equal(accepted.memberCap, firstCapability);

  const delayedMemberId = token(16);
  const delayedInvite = core.message(
    controller.client,
    JSON.stringify({
      v: 1,
      type: 'member.invite',
      memberId: delayedMemberId,
      idPub: publicKey(),
      labelB64: label('delayed'),
      sig: token(64),
    }),
  );
  await Promise.resolve();
  await join(context, accepted);
  delayedHash.resolve(digest(delayedCapability));
  await delayedInvite;

  assert.equal(controller.socket.take('error')?.code, 'EPOCH_MISMATCH');
  assert.equal(controller.socket.take('error')?.scope, 'invite');
  assert.equal(
    controller.socket.messages.some(
      (message) => message.type === 'member.invited' && message.memberId === delayedMemberId,
    ),
    false,
  );
  assert.equal(core.networks.get(network)?.pending.size, 0);
});

test('authentication for an unknown network consumes the IP failure bucket', async () => {
  const failures: string[] = [];
  const context = fixture((ip) => failures.push(ip));
  const socket = new Socket();
  const client = context.core.connect(socket, 'unknown-network-ip');
  await context.core.message(
    client,
    JSON.stringify({
      v: 1,
      type: 'auth',
      role: 'member',
      network: token(16),
      cap: token(32),
    }),
  );
  assert.deepEqual(failures, ['unknown-network-ip']);
  assert.equal(socket.take('error')?.code, 'AUTH_FAILED');
  assert.equal(socket.closeCode, 1008);
});

test('members cannot manage the network and controller loss is permanent', async () => {
  const context = fixture();
  const controller = await connectController(context);
  const first = await join(context, await invite(context, controller.client, 'A'));
  const second = await join(context, await invite(context, controller.client, 'B'));

  await context.core.message(
    first.client,
    JSON.stringify({ v: 1, type: 'net.admissions', open: false }),
  );
  assert.equal(first.socket.take('error')?.code, 'FORBIDDEN');
  assert.equal(context.core.networks.get(context.network)?.admissionsOpen, true);
  assert.equal(first.socket.readyState, 1);

  context.core.disconnect(controller.client);
  assert.equal(context.core.stats().networks, 1, 'two members can continue without controller');
  assert.ok(first.socket.take('controller.gone'));
  assert.ok(second.socket.take('controller.gone'));

  context.core.disconnect(second.client);
  assert.equal(context.core.stats().networks, 0, 'an orphaned one-member network is closed');
  assert.equal(first.socket.take('net.closed')?.code, 'CONTROLLER_GONE');
});

test('epoch snapshots prevent delivery to late members and slow recipients are bounded', async () => {
  const context = fixture();
  const controller = await connectController(context);
  const sender = await join(context, await invite(context, controller.client, 'sender'));
  const receiver = await join(context, await invite(context, controller.client, 'receiver'));
  const oldEpoch = context.core.networks.get(context.network)!.epoch;
  const late = await join(context, await invite(context, controller.client, 'late'));

  await context.core.message(
    sender.client,
    JSON.stringify({ v: 1, type: 'bcast', epoch: oldEpoch, seq: '0', ct: token(16) }),
  );
  assert.equal(receiver.socket.messages.filter((message) => message.type === 'bcast').length, 1);
  assert.equal(late.socket.messages.filter((message) => message.type === 'bcast').length, 0);

  const currentEpoch = context.core.networks.get(context.network)!.epoch;
  const largeCiphertext = token(20_000);
  for (let sequence = 1; sequence < 40 && receiver.socket.readyState === 1; sequence++) {
    await context.core.message(
      sender.client,
      JSON.stringify({
        v: 1,
        type: 'bcast',
        epoch: currentEpoch,
        seq: String(sequence),
        ct: largeCiphertext,
      }),
    );
  }
  assert.equal(receiver.socket.closeCode, 1008);
  assert.ok(
    sender.socket.messages.some(
      (message) =>
        message.type === 'member.removed' &&
        message.memberId === receiver.memberId &&
        message.reason === 'slow_peer',
    ),
  );
  assert.ok(receiver.client.flowSent <= 524288);
});

test('a slow recipient is removed only after the current epoch event reaches healthy peers', async () => {
  const context = fixture();
  const controller = await connectController(context);
  const slow = await join(context, await invite(context, controller.client, 'slow'));
  const healthy = await join(context, await invite(context, controller.client, 'healthy'));
  slow.socket.bufferedAmount = 65_536;

  const newcomer = await join(context, await invite(context, controller.client, 'newcomer'));
  await Promise.resolve();

  const events = healthy.socket.messages.filter(
    (message) => message.type === 'member.added' || message.type === 'member.removed',
  );
  const [added, removed] = events.slice(-2);
  assert.deepEqual(
    [added?.type, added?.epoch, added?.memberId],
    ['member.added', 3, newcomer.memberId],
  );
  assert.deepEqual(
    [removed?.type, removed?.epoch, removed?.memberId, removed?.reason],
    ['member.removed', 4, slow.memberId, 'slow_peer'],
  );
});

test('heartbeats do not extend idle lifetime, while explicit activity does', async () => {
  const context = fixture();
  const controller = await connectController(context);
  context.advance(1_700_000);
  await context.core.message(controller.client, JSON.stringify({ v: 1, type: 'hb.ping', id: 1 }));
  context.advance(50_000);
  await context.core.message(controller.client, JSON.stringify({ v: 1, type: 'net.touch' }));
  const touched = controller.socket.take('net.touched');
  assert.ok(touched);
  const extended = touched.idleExpiresAt;
  assert.equal(extended, 1700003550000);

  context.advance(1_750_000);
  await context.core.message(controller.client, JSON.stringify({ v: 1, type: 'hb.ping', id: 2 }));
  context.core.sweep();
  assert.equal(context.core.stats().networks, 1);
  context.advance(50_000);
  context.core.sweep();
  assert.equal(context.core.stats().networks, 0);
  assert.equal(controller.socket.closeCode, 1000);
});

test('touch replies are coalesced while each touch still extends idle lifetime', async () => {
  const context = fixture();
  const controller = await connectController(context);
  await context.core.message(controller.client, JSON.stringify({ v: 1, type: 'net.touch' }));
  context.advance(5_000);
  await context.core.message(controller.client, JSON.stringify({ v: 1, type: 'net.touch' }));
  assert.equal(
    controller.socket.messages.filter((message) => message.type === 'net.touched').length,
    1,
  );
  assert.equal(context.core.networks.get(context.network)?.idle, 1_805_000);

  context.advance(10_000);
  await context.core.message(controller.client, JSON.stringify({ v: 1, type: 'net.touch' }));
  assert.equal(
    controller.socket.messages.filter((message) => message.type === 'net.touched').length,
    2,
  );
});

test('non-flow-controlled replies have a lifetime budget for adapters without bufferedAmount', async () => {
  const clock = 0;
  const core = createNetworkCore({
    now: () => clock,
    wallNow: () => 1700000000000 + clock,
    random: token,
    digest: async (capability) => digest(capability),
    equal: async (left, right) => timingSafeEqual(left, right),
    canAuthenticate: () => true,
    authenticationFailed: () => {},
    maxUntrackedSendBytes: 8192,
  });
  const network = token(16);
  const controllerId = token(16);
  const controllerCap = token(32);
  core.createNetwork(network, controllerId, digest(controllerCap));
  const socket = new Socket();
  const client = core.connect(socket, 'worker-client');
  await core.message(
    client,
    JSON.stringify({ v: 1, type: 'auth', role: 'controller', network, cap: controllerCap }),
  );
  for (let id = 0; id < 160 && socket.readyState === 1; id++) {
    await core.message(client, JSON.stringify({ v: 1, type: 'hb.ping', id }));
  }
  await Promise.resolve();
  assert.equal(socket.closeCode, 1008);
  assert.equal(socket.take('error')?.code, 'SLOW_PEER');
  assert.ok(socket.wireBytes.reduce((sum, bytes) => sum + bytes, 0) <= 8192);
});

test('member capacity errors use the shared MEMBER_LIMIT code', async () => {
  const context = fixture();
  const controller = await connectController(context);
  for (let index = 0; index < 6; index++)
    await invite(context, controller.client, `pending-${index}`);
  await context.core.message(
    controller.client,
    JSON.stringify({
      v: 1,
      type: 'member.invite',
      memberId: token(16),
      idPub: publicKey(),
      labelB64: label('over-limit'),
      sig: token(64),
    }),
  );
  assert.equal(controller.socket.take('error')?.code, 'MEMBER_LIMIT');
  assert.equal(controller.socket.take('error')?.scope, 'invite');
});

test('expired invitations are revoked without changing membership', async () => {
  const context = fixture();
  const controller = await connectController(context);
  const invitation = await invite(context, controller.client, 'expires');
  context.advance(120_000);
  await context.core.message(controller.client, JSON.stringify({ v: 1, type: 'hb.ping', id: 1 }));
  context.core.sweep();
  assert.equal(context.core.networks.get(context.network)?.pending.size, 0);
  assert.ok(
    controller.socket.messages.some(
      (message) =>
        message.type === 'member.revoked' &&
        message.memberId === invitation.memberId &&
        message.code === 'INVITE_EXPIRED',
    ),
  );
  const expired = await join(context, invitation);
  assert.equal(expired.socket.take('error')?.code, 'MEMBER_CAP_EXPIRED');
  assert.equal(expired.socket.closeCode, 1008);
});

test('messages arriving while an asynchronous operation is pending are processed in order', async () => {
  const context = fixture();
  const controller = await connectController(context);
  const firstId = token(16);
  const secondId = token(16);
  const declaration = (memberId: string, name: string) =>
    JSON.stringify({
      v: 1,
      type: 'member.invite',
      memberId,
      idPub: publicKey(),
      labelB64: label(name),
      sig: token(64),
    });
  await Promise.all([
    context.core.message(controller.client, declaration(firstId, 'first')),
    context.core.message(controller.client, declaration(secondId, 'second')),
  ]);
  const invited = controller.socket.messages.filter((message) => message.type === 'member.invited');
  assert.deepEqual(
    invited.map((message) => message.memberId),
    [firstId, secondId],
  );
  assert.equal(controller.socket.readyState, 1);
});
