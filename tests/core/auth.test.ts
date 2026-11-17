import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRelayCore, type RelaySocket } from '../../packages/relay-core/src/index.ts';
const random = (n: number) => randomBytes(n).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();
class Socket implements RelaySocket {
  readyState = 1;
  messages: Record<string, any>[] = [];
  send(message: string) {
    this.messages.push(JSON.parse(message));
  }
  close() {
    this.readyState = 3;
  }
}

test('async capability hashing cannot revive an expired or disconnected room', async () => {
  for (const reason of ['expiry', 'disconnect'] as const) {
    let clock = 0,
      failures = 0;
    const pending = Promise.withResolvers<Uint8Array>();
    const core = createRelayCore({
      now: () => clock,
      wallNow: () => 1700000000000,
      random,
      digest: () => pending.promise,
      equal: async (a, b) => timingSafeEqual(a, b),
      canAuthenticate: () => true,
      authenticationFailed: () => {
        failures++;
      },
    });
    const room = random(16),
      cap = random(32),
      socket = new Socket();
    core.createRoom(room, digest(cap), digest(random(32)));
    const client = core.connect(socket, 'ip');
    const auth = core.message(
      client,
      JSON.stringify({ v: 1, type: 'auth', role: 'receiver', room, cap }),
    );
    // Let the global admission check finish and leave the digest unresolved.
    await Promise.resolve();
    if (reason === 'expiry') clock = 300_000;
    else core.disconnect(client);
    pending.resolve(digest(cap));
    await auth;
    assert.equal(
      socket.messages.some((message) => message.type === 'auth.ok'),
      false,
    );
    core.sweep();
    if (reason === 'expiry') assert.equal(core.stats().rooms, 0);
    assert.equal(failures, 0);
  }
});

test('asynchronous receiver authentication never replaces an existing receiver', async () => {
  const core = createRelayCore({
    now: () => 0,
    wallNow: () => 1700000000000,
    random,
    digest: async (cap) => digest(cap),
    equal: async (a, b) => timingSafeEqual(a, b),
    canAuthenticate: () => true,
    authenticationFailed: () => {},
  });
  const room = random(16),
    cap = random(32);
  core.createRoom(room, digest(cap), digest(random(32)));
  const sockets = [new Socket(), new Socket()];
  await Promise.all(
    sockets.map((socket) =>
      core.message(
        core.connect(socket, 'ip'),
        JSON.stringify({ v: 1, type: 'auth', role: 'receiver', room, cap }),
      ),
    ),
  );
  assert.equal(
    sockets.flatMap((socket) => socket.messages).filter((message) => message.type === 'auth.ok')
      .length,
    1,
  );
  assert.equal(
    sockets
      .flatMap((socket) => socket.messages)
      .filter((message) => message.code === 'DUPLICATE_ROLE').length,
    1,
  );
});
