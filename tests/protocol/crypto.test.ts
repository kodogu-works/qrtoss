import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CipherChannel,
  deriveKeys,
  makeProof,
  verifyProof,
  decodeBase64,
  encodeBase64,
  encodeText,
  decodeText,
  validateAppMessage,
  parseSequence,
} from '../../packages/protocol/src/index.ts';
const v = JSON.parse(
  await readFile(new URL('../../protocol/vectors/crypto.json', import.meta.url), 'utf8'),
);
test('Appendix A: independent published proof and all five ciphertexts', async () => {
  const keys = await deriveKeys(v.psk, v.room, v.peer, v.rNonce, v.sNonce);
  assert.equal(keys.s2r.extractable, false);
  assert.equal(keys.proof.extractable, false);
  assert.equal(await makeProof(keys, 'sender'), v.senderProof);
  assert.equal(await makeProof(keys, 'receiver'), v.receiverProof);
  assert.equal(await verifyProof(keys, 'receiver', v.receiverProof), true);
  assert.equal(await verifyProof(keys, 'receiver', v.senderProof), false);
  const r = new CipherChannel(v.room, v.peer, 'receiver', keys),
    s = new CipherChannel(v.room, v.peer, 'sender', keys);
  for (let i = 0; i < 5; i++) {
    const sender = [0, 3].includes(i) ? s : r,
      receiver = [0, 3].includes(i) ? r : s;
    const e = await sender.encrypt(v.messages[i]);
    assert.equal(e.ct, v.ciphertexts[i]);
    assert.deepEqual(await receiver.decrypt(e), v.messages[i]);
    await assert.rejects(() => receiver.decrypt(e));
  }
});
test('tamper, wrong direction, room, missing seq and unknown keys fail closed', async () => {
  const keys = await deriveKeys(v.psk, v.room, v.peer, v.rNonce, v.sNonce);
  const sender = new CipherChannel(v.room, v.peer, 'sender', keys);
  const e = await sender.encrypt({ type: 'ready' });
  for (const invalid of [
    { ...e, dir: 'r2s' },
    { ...e, room: encodeBase64(new Uint8Array(16)) },
    { ...e, seq: '1' },
    { ...e, extra: 1 },
    { ...e, ct: 'A' + e.ct.slice(1) },
  ]) {
    await assert.rejects(() =>
      new CipherChannel(v.room, v.peer, 'receiver', keys).decrypt(invalid),
    );
  }
});
test('canonical base64, uint64 sequence and exact application schemas', () => {
  for (const s of ['AA=', 'AA\n', 'AB', '+A', 'a']) assert.throws(() => decodeBase64(s));
  for (const n of ['00', '+1', '-1', '1e2', '18446744073709551616', 1])
    assert.throws(() => parseSequence(n));
  assert.equal(parseSequence('18446744073709551615'), 18446744073709551615n);
  for (const m of [
    { type: 'ready', x: 1 },
    { type: 'ack', id: v.messages[3].id, status: 'rejected' },
    { type: 'data', id: 'x', textB64: 'YQ' },
    { type: 'mode', value: 'run' },
  ])
    assert.throws(() => validateAppMessage(m));
});
test('Unicode round trip preserves BOM, controls, combining marks and byte limit', () => {
  for (const s of ['\ufeffa', 'こんにちは😀\nqrtoss', 'a\0\u001b\u202eb', 'e\u0301'])
    assert.equal(decodeText(encodeText(s)), s);
  assert.equal(decodeText(encodeText('x'.repeat(16384))).length, 16384);
  for (const s of ['', '\ud800', 'x'.repeat(16385)]) assert.throws(() => encodeText(s));
  for (const s of ['_w', '7aCA']) assert.throws(() => decodeText(s));
});
