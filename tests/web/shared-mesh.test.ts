import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  SC,
  encodeMemberLabel,
  generateEcdhIdentity,
  generateSigningIdentity,
  signMemberAddition,
  type BcastAppMessage,
  type EcdhIdentity,
  type SigningIdentity,
  type UcastAppMessage,
} from '../../packages/protocol/src/shared.ts';
import type {
  SharedControlMessage,
  SharedMemberEntry,
  SharedRole,
} from '../../packages/protocol/src/shared-control.ts';
import { randomToken } from '../../packages/protocol/src/index.ts';
import type { SharedNetworkClient } from '../../web/src/shared-network.ts';
import { SharedMesh } from '../../web/src/shared-mesh.ts';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

type ForwardedUcast = Extract<SharedControlMessage, { type: 'ucast'; network: string }>;
type ForwardedBcast = Extract<SharedControlMessage, { type: 'bcast'; network: string }>;
type Encryptor<T> = { encrypt(message: T): Promise<{ seq: string; ct: string }> };

const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

class Router {
  readonly meshes = new Map<string, SharedMesh>();
  readonly ucasts: ForwardedUcast[] = [];
  readonly bcasts: ForwardedBcast[] = [];
  private delivered = 0;

  client(network: string, from: string): SharedNetworkClient {
    return {
      ucast: (_as: SharedRole, to: string, seq: string, ct: string) => {
        this.ucasts.push({ v: 1, type: 'ucast', network, from, to, seq, ct });
      },
      bcast: (epoch: number, seq: string, ct: string) => {
        this.bcasts.push({ v: 1, type: 'bcast', network, from, epoch, seq, ct });
      },
    } as SharedNetworkClient;
  }

  async drainUnicast(): Promise<void> {
    while (this.delivered < this.ucasts.length) {
      const frame = this.ucasts[this.delivered++];
      const target = this.meshes.get(frame.to);
      assert.ok(target, `missing routed mesh ${frame.to}`);
      await target.receiveUnicast(frame);
    }
  }
}

type Fixture = {
  network: string;
  signing: SigningIdentity;
  router: Router;
  identities: Map<string, EcdhIdentity>;
  entries: Map<string, SharedMemberEntry>;
  meshes: Map<string, SharedMesh>;
};

async function memberEntry(
  network: string,
  memberId: string,
  label: string,
  identity: EcdhIdentity,
  signing: SigningIdentity,
): Promise<SharedMemberEntry> {
  const labelB64 = encodeMemberLabel(label);
  return {
    memberId,
    idPub: identity.publicRaw,
    labelB64,
    sig: await signMemberAddition(signing.privateKey, {
      network,
      memberId,
      idPub: identity.publicRaw,
      labelB64,
    }),
  };
}

async function fixture(labels: readonly string[]): Promise<Fixture> {
  const network = randomToken(16);
  const signing = await generateSigningIdentity();
  const router = new Router();
  const identities = new Map<string, EcdhIdentity>();
  const entries = new Map<string, SharedMemberEntry>();
  const meshes = new Map<string, SharedMesh>();
  for (const label of labels) {
    const memberId = randomToken(16);
    const identity = await generateEcdhIdentity();
    identities.set(label, identity);
    entries.set(label, await memberEntry(network, memberId, label, identity, signing));
  }
  for (const label of labels) {
    const entry = entries.get(label)!;
    const mesh = new SharedMesh(
      network,
      entry.memberId,
      identities.get(label)!,
      signing.publicKey,
      router.client(network, entry.memberId),
      { members() {}, unicast() {}, broadcast() {} },
    );
    meshes.set(label, mesh);
    router.meshes.set(entry.memberId, mesh);
  }
  return { network, signing, router, identities, entries, meshes };
}

async function authenticateInitial(value: Fixture, labels: readonly string[]): Promise<void> {
  const entries = labels.map((label) => value.entries.get(label)!);
  for (const label of labels) await value.meshes.get(label)!.authenticate(entries, 1);
  await value.router.drainUnicast();
  for (const label of labels)
    assert.equal((await value.meshes.get(label)!.captureBroadcastContext()).epoch, 1);
}

function added(entry: SharedMemberEntry, epoch: number) {
  return { v: 1, type: 'member.added', epoch, ...entry } as const;
}

function removed(memberId: string, epoch: number) {
  return { v: 1, type: 'member.removed', epoch, memberId, reason: 'left' } as const;
}

function cancelMessage(): BcastAppMessage {
  return { type: 'file.cancel', transferId: randomToken(16) };
}

test('concurrent unicast and broadcast calls preserve encryption sequence order', async (t) => {
  const value = await fixture(['A', 'B']);
  const a = value.meshes.get('A')!;
  const bId = value.entries.get('B')!.memberId;
  t.after(() => {
    for (const mesh of value.meshes.values()) mesh.destroy();
  });
  await authenticateInitial(value, ['A', 'B']);

  const peer = (
    a as unknown as {
      peers: Map<string, { channel: Encryptor<UcastAppMessage> }>;
    }
  ).peers.get(bId)!;
  const originalUnicast = peer.channel.encrypt.bind(peer.channel);
  let unicastCalls = 0;
  let releaseUnicast!: () => void;
  const unicastGate = new Promise<void>((resolve) => {
    releaseUnicast = resolve;
  });
  peer.channel.encrypt = async (message) => {
    unicastCalls++;
    const encrypted = await originalUnicast(message);
    if (unicastCalls === 1) await unicastGate;
    return encrypted;
  };
  const ucastStart = value.router.ucasts.length;
  const firstUcast = a.sendTo(bId, { type: 'activity' });
  const secondUcast = a.sendTo(bId, { type: 'status', state: 'ready' });
  await immediate();
  assert.equal(unicastCalls, 1);
  assert.equal(value.router.ucasts.length, ucastStart);
  releaseUnicast();
  await Promise.all([firstUcast, secondUcast]);
  const unicastSeqs = value.router.ucasts.slice(ucastStart).map((frame) => frame.seq);
  assert.equal(unicastSeqs.length, 2);
  assert.equal(BigInt(unicastSeqs[1]), BigInt(unicastSeqs[0]) + 1n);

  const sender = (a as unknown as { sender: Encryptor<BcastAppMessage> }).sender;
  const originalBroadcast = sender.encrypt.bind(sender);
  let broadcastCalls = 0;
  let releaseBroadcast!: () => void;
  const broadcastGate = new Promise<void>((resolve) => {
    releaseBroadcast = resolve;
  });
  sender.encrypt = async (message) => {
    broadcastCalls++;
    const encrypted = await originalBroadcast(message);
    if (broadcastCalls === 1) await broadcastGate;
    return encrypted;
  };
  const firstBroadcast = a.broadcastAt(1, cancelMessage());
  const secondBroadcast = a.broadcastAt(1, cancelMessage());
  await immediate();
  assert.equal(broadcastCalls, 1);
  assert.equal(value.router.bcasts.length, 0);
  releaseBroadcast();
  await Promise.all([firstBroadcast, secondBroadcast]);
  assert.deepEqual(
    value.router.bcasts.map((frame) => frame.seq),
    ['0', '1'],
  );
});

test('a membership change rejects a context waiting on the previous key distribution', async (t) => {
  const value = await fixture(['A', 'B', 'C']);
  const a = value.meshes.get('A')!;
  const c = value.entries.get('C')!;
  t.after(() => {
    for (const mesh of value.meshes.values()) mesh.destroy();
  });
  await authenticateInitial(value, ['A', 'B']);

  await a.memberAdded(added(c, 2));
  const pendingContext = assert.rejects(a.captureBroadcastContext(), /EPOCH_MISMATCH/);
  await immediate();
  await a.memberRemoved(removed(c.memberId, 3));
  await pendingContext;
  assert.equal(a.currentEpoch, 3);
});

test('old epoch sender and receiver keys fail at the deadline even before timers run', async (t) => {
  let clock = 1_000;
  t.mock.method(performance, 'now', () => clock);
  const value = await fixture(['A', 'B', 'C']);
  const a = value.meshes.get('A')!;
  const b = value.meshes.get('B')!;
  const c = value.entries.get('C')!;
  t.after(() => {
    for (const mesh of value.meshes.values()) mesh.destroy();
  });
  await authenticateInitial(value, ['A', 'B']);

  await b.broadcastAt(1, cancelMessage());
  const oldFrame = value.router.bcasts.at(-1)!;
  await a.memberAdded(added(c, 2));
  clock += SC.OLD_EPOCH_KEY_SECONDS * 1_000 + 1;

  await assert.rejects(a.broadcastAt(1, cancelMessage()), /EPOCH_MISMATCH/);
  await assert.rejects(a.receiveBroadcast(oldFrame), /EPOCH_MISMATCH/);
});

test('a new epoch broadcast waits for every key.share receipt', async (t) => {
  const value = await fixture(['A', 'B', 'C']);
  const a = value.meshes.get('A')!;
  const b = value.meshes.get('B')!;
  const c = value.meshes.get('C')!;
  const entries = [...value.entries.values()];
  t.after(() => {
    for (const mesh of value.meshes.values()) mesh.destroy();
  });
  await authenticateInitial(value, ['A', 'B']);

  await c.authenticate(entries, 2);
  await a.memberAdded(added(value.entries.get('C')!, 2));
  await b.memberAdded(added(value.entries.get('C')!, 2));
  const pending = a.broadcast(cancelMessage());
  await immediate();
  assert.equal(value.router.bcasts.length, 0);

  await value.router.drainUnicast();
  await pending;
  assert.equal(value.router.bcasts.length, 1);
  assert.equal(value.router.bcasts[0].epoch, 2);
});
