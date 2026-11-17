import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { C } from '../../packages/protocol/src/constants.ts';
import { createRelayCore, type RelaySocket } from '../../packages/relay-core/src/index.ts';
import { SendBudget } from '../../packages/relay-core/src/limits.ts';

class Socket implements RelaySocket {
  readyState = 1;
  bytes = 0;
  messages: Record<string, any>[] = [];
  closeCode?: number;
  send(message: string) {
    this.bytes += Buffer.byteLength(message);
    this.messages.push(JSON.parse(message));
  }
  close(code?: number) {
    this.closeCode = code;
    this.readyState = 3;
  }
}

test('lifetime send allowance includes an exact boundary and bounded closing reserve', () => {
  const budget = new SendBudget(100, 10);
  assert.equal(budget.take(89), true);
  assert.equal(budget.take(2), false);
  assert.equal(budget.take(1), true);
  assert.equal(budget.take(1), false);
  assert.equal(budget.take(10, true), true);
  assert.equal(budget.take(1, true), false);
});

test('control replies exhaust a socket lifetime budget despite continued heartbeat', async () => {
  for (const maxSocketSendBytes of [8192, undefined]) {
    let clock = 0;
    const core = createRelayCore({
      now: () => clock,
      wallNow: () => 1700000000000 + clock,
      random: (n) => randomBytes(n).toString('base64url'),
      digest: async (cap) => createHash('sha256').update(cap).digest(),
      equal: async (a, b) => timingSafeEqual(a, b),
      canAuthenticate: () => true,
      authenticationFailed: () => {},
      maxSocketSendBytes,
    });
    const room = randomBytes(16).toString('base64url');
    const cap = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(cap).digest();
    core.createRoom(room, hash, hash);
    const socket = new Socket(); // No bufferedAmount, just like Workers.
    const client = core.connect(socket, 'ip');
    await core.message(client, JSON.stringify({ v: 1, type: 'auth', role: 'receiver', room, cap }));
    for (let id = 0; id < 500 && socket.readyState === 1; id++) {
      clock += 250;
      await core.message(client, JSON.stringify({ v: 1, type: 'hb.ping', id }));
      core.sweep();
    }
    if (maxSocketSendBytes === undefined) {
      assert.equal(socket.readyState, 1, 'Node adapter keeps using bufferedAmount');
      assert.equal(socket.messages.filter((m) => m.type === 'hb.pong').length, 500);
    } else {
      assert.deepEqual(socket.messages.at(-1), { v: 1, type: 'room.closed', code: 'SLOW_PEER' });
      assert.equal(socket.closeCode, 1008);
      assert.equal(core.stats().rooms, 0);
      assert.ok(socket.bytes <= maxSocketSendBytes);
      assert.ok(socket.bytes > maxSocketSendBytes - 2 * C.MAX_CONTROL_MESSAGE_BYTES - 100);
      const bytes = socket.bytes;
      await core.message(client, JSON.stringify({ v: 1, type: 'hb.ping', id: 1000 }));
      core.fail(client, 'SERVER_ERROR');
      assert.equal(socket.bytes, bytes, 'closed sockets never enqueue more replies');
    }
  }
});
