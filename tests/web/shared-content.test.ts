import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SC,
  encodeSharedText,
  type BcastAppMessage,
  type UcastAppMessage,
} from '../../packages/protocol/src/shared.ts';
import { encodeBase64 } from '../../packages/protocol/src/validation.ts';
import { SharedContentSession } from '../../web/src/shared-content.ts';
import type { SharedMesh } from '../../web/src/shared-mesh.ts';

type Sent = { to: string; message: UcastAppMessage };

class FakeMesh {
  recipientIds: string[] = [];
  context = { epoch: 1, recipients: [] as string[] };
  captureCalls = 0;
  readonly broadcasts: { epoch: number; message: BcastAppMessage }[] = [];
  readonly sent: Sent[] = [];
  onBroadcast?: (epoch: number, message: BcastAppMessage) => Promise<void> | void;

  async captureBroadcastContext(): Promise<{ epoch: number; recipients: string[] }> {
    this.captureCalls++;
    return { epoch: this.context.epoch, recipients: [...this.context.recipients] };
  }

  async broadcastAt(epoch: number, message: BcastAppMessage): Promise<void> {
    this.broadcasts.push({ epoch, message });
    await this.onBroadcast?.(epoch, message);
  }

  async sendTo(to: string, message: UcastAppMessage): Promise<void> {
    this.sent.push({ to, message });
  }
}

const createSession = (mesh: FakeMesh) =>
  new SharedContentSession(mesh as unknown as SharedMesh, {
    received() {},
    delivery() {},
  });

const offer = (
  transferId: string,
  batchId: string,
  size: number,
): Extract<BcastAppMessage, { type: 'file.offer' }> => ({
  type: 'file.offer',
  transferId,
  batchId,
  nameB64: 'Zi5iaW4',
  size,
  mime: 'application/octet-stream',
  chunks: Math.ceil(size / SC.FILE_CHUNK_BYTES),
});

test('one file-selection batch freezes one epoch and recipient snapshot', async () => {
  const mesh = new FakeMesh();
  mesh.context = { epoch: 7, recipients: ['a', 'b'] };
  let session!: SharedContentSession;
  let completed = 0;
  mesh.onBroadcast = async (epoch, message) => {
    assert.equal(epoch, 7);
    if (message.type !== 'file.end') return;
    await session.onUnicast('a', { type: 'receipt', id: message.transferId, status: 'ok' });
    await session.onUnicast('b', { type: 'receipt', id: message.transferId, status: 'ok' });
    if (++completed === 1) mesh.context = { epoch: 8, recipients: ['late-member'] };
  };
  session = createSession(mesh);

  const trackers = await session.sendFiles([new File([], 'first.bin'), new File([], 'second.bin')]);

  assert.equal(mesh.captureCalls, 1);
  assert.equal(new Set(mesh.broadcasts.map(({ epoch }) => epoch)).size, 1);
  const offers = mesh.broadcasts.filter(
    (
      entry,
    ): entry is { epoch: number; message: Extract<BcastAppMessage, { type: 'file.offer' }> } =>
      entry.message.type === 'file.offer',
  );
  assert.equal(offers.length, 2);
  assert.equal(offers[0].message.batchId, offers[1].message.batchId);
  for (const tracker of trackers) {
    assert.deepEqual([...tracker.recipients.keys()], ['a', 'b']);
    assert.equal(tracker.complete, true);
  }
  session.destroy();
});

test('a failed broadcast settles its start-time recipients and releases unsaved state', async () => {
  const mesh = new FakeMesh();
  mesh.context = { epoch: 1, recipients: ['a', 'b'] };
  mesh.onBroadcast = () => {
    throw new Error('EPOCH_MISMATCH');
  };
  const session = createSession(mesh);

  await assert.rejects(session.sendText('hello'), /EPOCH_MISMATCH/);
  assert.equal(session.deliveries.length, 1);
  assert.equal(session.deliveries[0].settled, true);
  assert.deepEqual(
    [...session.deliveries[0].recipients.values()].map(({ status, code }) => ({ status, code })),
    [
      { status: 'FAILED', code: 'EPOCH_MISMATCH' },
      { status: 'FAILED', code: 'EPOCH_MISMATCH' },
    ],
  );
  assert.equal(session.hasUnsaved, false);
  session.destroy();
});

test('a batch keeps aggregate byte limits after cancellation and cannot be resumed after switching', async () => {
  const mesh = new FakeMesh();
  const session = createSession(mesh);

  await session.onBroadcast('sender', offer('f1', 'batch-a', 6_000_000));
  await session.onBroadcast('sender', { type: 'file.cancel', transferId: 'f1' });
  await session.onBroadcast('sender', offer('f2', 'batch-a', 4_000_000));
  await session.onBroadcast('sender', { type: 'file.cancel', transferId: 'f2' });
  await session.onBroadcast('sender', offer('too-large', 'batch-a', 1));
  assert.deepEqual(mesh.sent.at(-1)?.message, {
    type: 'receipt',
    id: 'too-large',
    status: 'rejected',
    code: 'CONTENT_TOO_LARGE',
  });

  await session.onBroadcast('sender', offer('new', 'batch-b', 0));
  await session.onBroadcast('sender', { type: 'file.cancel', transferId: 'new' });
  await session.onBroadcast('sender', offer('old-again', 'batch-a', 0));
  assert.deepEqual(mesh.sent.at(-1)?.message, {
    type: 'receipt',
    id: 'old-again',
    status: 'rejected',
    code: 'CONTENT_INVALID',
  });
  session.destroy();
});

test('reserved files count against both received byte and item limits for text', async () => {
  const mesh = new FakeMesh();
  const session = createSession(mesh);

  for (const [from, size] of [
    ['a', 10_000_000],
    ['b', 10_000_000],
    ['c', 10_000_000],
    ['d', 3_550_000],
  ] as const)
    await session.onBroadcast(from, offer(`file-${from}`, `batch-${from}`, size));
  await session.onBroadcast('text-sender', {
    type: 'text',
    id: 'text-full-bytes',
    textB64: encodeSharedText('x'.repeat(5_000)),
  });
  assert.deepEqual(mesh.sent.at(-1)?.message, {
    type: 'receipt',
    id: 'text-full-bytes',
    status: 'rejected',
    code: 'RECEIVER_FULL',
  });

  session.memberGone('d');
  await session.onBroadcast('text-sender', {
    type: 'text',
    id: 'text-after-release',
    textB64: encodeSharedText('x'.repeat(5_000)),
  });
  assert.deepEqual(mesh.sent.at(-1)?.message, {
    type: 'receipt',
    id: 'text-after-release',
    status: 'ok',
  });

  for (let index = session.store.size; index < SC.MAX_RECEIVED_ITEMS - 1; index++)
    session.store.addText(`stored-${index}`, 'x');
  await session.onBroadcast('zero-sender', offer('pending-zero', 'zero-batch', 0));
  await session.onBroadcast('text-sender', {
    type: 'text',
    id: 'text-full-items',
    textB64: encodeSharedText('x'),
  });
  assert.deepEqual(mesh.sent.at(-1)?.message, {
    type: 'receipt',
    id: 'text-full-items',
    status: 'rejected',
    code: 'RECEIVER_FULL',
  });
  session.destroy();
});

test('a batch accepts at most 64 zero-byte files', async () => {
  const mesh = new FakeMesh();
  const session = createSession(mesh);

  for (let index = 0; index < SC.MAX_RECEIVED_ITEMS; index++) {
    const transferId = `zero-${index}`;
    await session.onBroadcast('sender', offer(transferId, 'zero-batch', 0));
    await session.onBroadcast('sender', { type: 'file.end', transferId });
  }
  assert.equal(session.store.size, SC.MAX_RECEIVED_ITEMS);
  await session.onBroadcast('sender', offer('zero-overflow', 'zero-batch', 0));
  assert.deepEqual(mesh.sent.at(-1)?.message, {
    type: 'receipt',
    id: 'zero-overflow',
    status: 'rejected',
    code: 'CONTENT_TOO_LARGE',
  });
  session.destroy();
});

test('an incomplete incoming file times out and each valid chunk refreshes its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mesh = new FakeMesh();
  const session = createSession(mesh);
  const size = SC.FILE_CHUNK_BYTES + 1;

  await session.onBroadcast('sender', offer('stalled', 'batch', size));
  t.mock.timers.tick(SC.DELIVERY_ACK_TIMEOUT_SECONDS * 1_000 - 1_000);
  await session.onBroadcast('sender', {
    type: 'file.chunk',
    transferId: 'stalled',
    index: 0,
    dataB64: encodeBase64(new Uint8Array(SC.FILE_CHUNK_BYTES)),
  });
  t.mock.timers.tick(SC.DELIVERY_ACK_TIMEOUT_SECONDS * 1_000 - 1);
  assert.equal(
    mesh.sent.some(({ message }) => message.type === 'receipt'),
    false,
  );
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(mesh.sent.at(-1)?.message, {
    type: 'receipt',
    id: 'stalled',
    status: 'rejected',
    code: 'CANCELED',
  });

  // Releasing the stalled reservation permits the same sender to begin a later operation.
  await session.onBroadcast('sender', offer('after-timeout', 'new-batch', size));
  assert.equal(
    mesh.sent.some(({ message }) => message.type === 'receipt' && message.id === 'after-timeout'),
    false,
  );
  session.destroy();
  t.mock.timers.reset();
});

test('only an in-progress file delivery is cancelable', async () => {
  const mesh = new FakeMesh();
  mesh.context = { epoch: 1, recipients: ['receiver'] };
  let session!: SharedContentSession;
  mesh.onBroadcast = async (_epoch, message) => {
    if (message.type === 'file.offer') {
      assert.equal(session.canCancel(message.transferId), true);
      session.cancel(message.transferId);
    }
    if (message.type === 'text') {
      assert.equal(session.canCancel(message.id), false);
      session.cancel(message.id);
      await session.onUnicast('receiver', { type: 'receipt', id: message.id, status: 'ok' });
    }
  };
  session = createSession(mesh);

  const [file] = await session.sendFiles([new File([], 'cancel-me.bin')]);
  assert.deepEqual(
    [...file.recipients.values()].map(({ status }) => status),
    ['CANCELED'],
  );
  assert.equal(session.canCancel(file.id), false);
  assert.equal(
    mesh.broadcasts.some(
      ({ message }) => message.type === 'file.cancel' && message.transferId === file.id,
    ),
    true,
  );

  const text = await session.sendText('not cancelable');
  assert.equal(text.complete, true);
  session.destroy();
});

test('settled delivery history is bounded', async () => {
  const mesh = new FakeMesh();
  mesh.context = { epoch: 1, recipients: ['receiver'] };
  let session!: SharedContentSession;
  mesh.onBroadcast = async (_epoch, message) => {
    if (message.type === 'text')
      await session.onUnicast('receiver', { type: 'receipt', id: message.id, status: 'ok' });
  };
  session = createSession(mesh);

  for (let index = 0; index <= SC.MAX_RECEIVED_ITEMS; index++)
    await session.sendText(`message ${index}`);
  assert.equal(session.deliveries.length, SC.MAX_RECEIVED_ITEMS);
  assert.equal(
    session.deliveries.every((tracker) => tracker.complete),
    true,
  );
  session.destroy();
});
