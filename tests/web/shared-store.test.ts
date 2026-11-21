import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeliveryTracker,
  FILE_CHUNK_BYTES,
  IncomingFile,
  MAX_RECEIVED_BYTES,
  MAX_SHARED_SEND_BYTES,
  ReceivedStore,
  validateDisplayText,
  validateFiles,
} from '../../web/src/shared-store.ts';

test('file selection uses the aggregate decimal 10MB source-size limit', () => {
  assert.equal(
    validateFiles([
      { name: 'a.bin', size: 6_000_000 },
      { name: 'b.bin', size: 4_000_000 },
    ] as File[]),
    MAX_SHARED_SEND_BYTES,
  );
  assert.throws(
    () => validateFiles([{ name: 'a.bin', size: 10_000_001 }] as File[]),
    /CONTENT_TOO_LARGE/,
  );
  assert.equal(
    validateFiles(
      Array.from({ length: 64 }, (_, index) => ({ name: `${index}.empty`, size: 0 })) as File[],
    ),
    0,
  );
  assert.throws(
    () =>
      validateFiles(
        Array.from({ length: 65 }, (_, index) => ({ name: `${index}.empty`, size: 0 })) as File[],
      ),
    /CONTENT_TOO_LARGE/,
  );
  assert.throws(() => validateDisplayText('unsafe\u202ename', 255), /CONTENT_INVALID/);
});

test('received items remain memory-only, bounded and explicitly saved or removed', () => {
  const store = new ReceivedStore();
  store.addText('t', 'https://example.com/');
  assert.equal(store.hasUnsaved, true);
  store.remove('t');
  const data = new Uint8Array([1, 2, 3]);
  store.addFile('f', 'file.bin', 'application/octet-stream', data);
  data.fill(9);
  assert.deepEqual((store.items[0] as { data: Uint8Array }).data, new Uint8Array([1, 2, 3]));
  store.markSaved('f');
  assert.equal(store.hasUnsaved, false);
  assert.equal(store.canReceive(MAX_RECEIVED_BYTES), false);
  store.clear();
  assert.equal(store.byteLength, 0);
});

test('file assembly enforces contiguous indexes, exact chunks and total size', () => {
  const value = new IncomingFile(
    'id',
    'data.bin',
    FILE_CHUNK_BYTES + 2,
    'application/octet-stream',
    2,
  );
  assert.throws(() => value.push(1, new Uint8Array(2)), /PROTOCOL_ERROR/);
  assert.equal(value.push(0, new Uint8Array(FILE_CHUNK_BYTES)), 1);
  assert.equal(value.push(1, new Uint8Array([7, 8])), 2);
  const result = value.finish();
  assert.equal(result.byteLength, FILE_CHUNK_BYTES + 2);
  assert.deepEqual(result.slice(-2), new Uint8Array([7, 8]));
});

test('delivery results settle independently per start-time recipient', () => {
  const tracker = new DeliveryTracker('x', ['a', 'b']);
  tracker.progress('a', 4);
  tracker.settle('a', 'COMPLETE');
  tracker.settle('b', 'FAILED', 'ACK_TIMEOUT');
  assert.equal(tracker.settled, true);
  assert.equal(tracker.complete, false);
  assert.equal(tracker.recipients.get('a')?.upTo, 4);
});
