import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  BroadcastReceiver,
  BroadcastSender,
  SC,
  SHARE_PAIR_SUBPROTOCOL,
  SHARE_PROTOCOL,
  SharedPairingCipher,
  UnicastChannel,
  buildSharedInviteUrl,
  decodeFileName,
  decodeSharedText,
  deriveNetworkCode,
  deriveSharedPairingKeys,
  encodeFileName,
  encodeMemberLabel,
  encodeSharedText,
  generateEcdhIdentity,
  generateSigningIdentity,
  importSigningPublic,
  isSharedInviteCandidate,
  makeSharedPairingProof,
  parseSharedInviteUrl,
  signMemberAddition,
  validateBcastAppMessage,
  validatePairingAppMessage,
  validateUcastAppMessage,
  verifyMemberAddition,
  verifySharedPairingProof,
} from '../../packages/protocol/src/shared.ts';
import { validateSharedControlMessage } from '../../packages/protocol/src/shared-control.ts';

// Node 20 and earlier do not expose Web Crypto globally without a flag. Production browsers and
// the repository's required Node 26 do; this keeps the vector test runnable in older dev shells.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const vector = JSON.parse(
  await readFile(new URL('../../protocol/vectors/shared.json', import.meta.url), 'utf8'),
) as Record<string, any>;

test('shared protocol identifiers and the v2 same-origin invite are separated from qrtoss/1', () => {
  assert.equal(SHARE_PROTOCOL, 'qrtoss/share/1');
  assert.equal(SHARE_PAIR_SUBPROTOCOL, 'qrtoss.share-pair.v1');
  const invite = { pair: vector.pair, join: vector.psk, psk: vector.senderSecret };
  const url = buildSharedInviteUrl('https://qrtoss.example/base/send', invite);
  assert.deepEqual(parseSharedInviteUrl(url, 'https://qrtoss.example/base/send'), invite);
  assert.equal(isSharedInviteCandidate(url, 'https://qrtoss.example/base/send'), true);
  for (const invalid of [
    url.replace('qrtoss.example', 'evil.example'),
    url.replace('/base/send', '/send'),
    `${url}&extra=1`,
    url.replace('v=2', 'v=3'),
    url.replace('pair=Y', 'pair=%59'),
    url.replace(vector.pair, 'bad'),
    `${url}${'x'.repeat(2048)}`,
  ])
    assert.throws(() => parseSharedInviteUrl(invalid, 'https://qrtoss.example/base/send'));
});

test('published shared pairing proof and ciphertext vector is stable and directional', async () => {
  const keys = await deriveSharedPairingKeys(
    vector.psk,
    vector.pair,
    vector.peer,
    vector.rNonce,
    vector.sNonce,
  );
  assert.equal(await makeSharedPairingProof(keys, 'sender'), vector.senderProof);
  assert.equal(await makeSharedPairingProof(keys, 'receiver'), vector.receiverProof);
  assert.equal(await verifySharedPairingProof(keys, 'sender', vector.senderProof), true);
  assert.equal(await verifySharedPairingProof(keys, 'receiver', vector.senderProof), false);
  const sender = new SharedPairingCipher(vector.pair, vector.peer, 'sender', keys);
  const receiver = new SharedPairingCipher(vector.pair, vector.peer, 'receiver', keys);
  const ready = await sender.encrypt({ type: 'ready' });
  assert.equal(ready.ct, vector.readyCiphertext);
  assert.deepEqual(await receiver.decrypt(ready), { type: 'ready' });
  await assert.rejects(() => receiver.decrypt(ready));
  const readyAck = await receiver.encrypt({ type: 'ready_ack' });
  assert.deepEqual(await sender.decrypt(readyAck), { type: 'ready_ack' });
});

test('P-256 member signing, verification and network code work with non-extractable private keys', async () => {
  assert.equal(
    await verifyMemberAddition(
      await importSigningPublic(vector.signingPublic),
      vector.memberAddition,
      vector.memberSignature,
    ),
    true,
  );
  const signing = await generateSigningIdentity();
  const ecdh = await generateEcdhIdentity();
  assert.equal(signing.privateKey.extractable, false);
  assert.equal(ecdh.privateKey.extractable, false);
  const addition = {
    network: vector.network,
    memberId: vector.from,
    idPub: ecdh.publicRaw,
    labelB64: encodeMemberLabel('PC-A123'),
  };
  const signature = await signMemberAddition(signing.privateKey, addition);
  const imported = await importSigningPublic(signing.publicRaw);
  assert.equal(await verifyMemberAddition(imported, addition, signature), true);
  assert.equal(
    await verifyMemberAddition(imported, { ...addition, memberId: vector.to }, signature),
    false,
  );
  assert.equal(
    await deriveNetworkCode(vector.network, vector.networkCodePublic),
    vector.networkCode,
  );
});

test('unicast pair keys and sender keys reproduce vectors and reject replay', async () => {
  const algorithm = { name: 'ECDH', namedCurve: 'P-256' };
  const [privateA, publicA, privateB, publicB] = await Promise.all([
    crypto.subtle.importKey('jwk', vector.ecdhA, algorithm, false, ['deriveBits']),
    crypto.subtle.importKey('jwk', vector.ecdhAPublic, algorithm, true, []),
    crypto.subtle.importKey('jwk', vector.ecdhB, algorithm, false, ['deriveBits']),
    crypto.subtle.importKey('jwk', vector.ecdhBPublic, algorithm, true, []),
  ]);
  const a = await UnicastChannel.create(vector.network, vector.from, privateA, vector.to, publicB);
  const b = await UnicastChannel.create(vector.network, vector.to, privateB, vector.from, publicA);
  const encrypted = await a.encrypt({ type: 'mode', value: 'display_only' });
  assert.equal(encrypted.ct, vector.unicastCiphertext);
  assert.deepEqual(await b.decrypt(encrypted.seq, encrypted.ct), {
    type: 'mode',
    value: 'display_only',
  });
  await assert.rejects(() => b.decrypt(encrypted.seq, encrypted.ct));

  const broadcast = await BroadcastSender.create(
    vector.network,
    vector.from,
    3,
    vector.senderSecret,
  );
  const receiver = await BroadcastReceiver.create(
    vector.network,
    vector.from,
    3,
    vector.senderSecret,
  );
  const text = { type: 'text' as const, id: vector.textId, textB64: encodeSharedText('hello') };
  const cipher = await broadcast.encrypt(text);
  assert.equal(cipher.ct, vector.broadcastCiphertext);
  assert.deepEqual(await receiver.decrypt(cipher.seq, cipher.ct), text);
  await assert.rejects(() => receiver.decrypt(cipher.seq, cipher.ct));
});

test('shared app schemas preserve UTF-8 and reject extra fields, bad chunks and unsafe names', () => {
  for (const text of ['hello', 'こんにちは😀', 'e\u0301', 'a\u0000b'])
    assert.equal(decodeSharedText(encodeSharedText(text)), text);
  assert.equal(decodeFileName(encodeFileName('資料 1.pdf')), '資料 1.pdf');
  for (const bad of ['', '\ud800', 'x'.repeat(SC.MAX_SHARED_TEXT_UTF8_BYTES + 1)])
    assert.throws(() => encodeSharedText(bad));
  for (const bad of ['bad\nname', 'bad\u202ename']) assert.throws(() => encodeFileName(bad));
  for (const message of [
    { type: 'ready', extra: true },
    { type: 'p.accept', memberId: 'bad' },
  ])
    assert.throws(() => validatePairingAppMessage(message));
  for (const message of [
    { type: 'mode', value: 'run' },
    { type: 'key.share', epoch: 0, senderKey: 'bad' },
  ])
    assert.throws(() => validateUcastAppMessage(message));
  for (const message of [
    { type: 'file.chunk', transferId: vector.from, index: 0, dataB64: '' },
    {
      type: 'file.offer',
      transferId: vector.from,
      nameB64: encodeFileName('x'),
      size: 1,
      mime: '',
      chunks: 2,
    },
  ])
    assert.throws(() => validateBcastAppMessage(message));
});

test('shared control messages are strict and target-specific', () => {
  const auth = {
    v: 1 as const,
    type: 'auth' as const,
    role: 'controller' as const,
    network: vector.network,
    cap: vector.senderSecret,
  };
  assert.deepEqual(validateSharedControlMessage(auth, 'server'), auth);
  assert.throws(() => validateSharedControlMessage(auth, 'controller'));
  assert.throws(() => validateSharedControlMessage({ ...auth, extra: true }, 'server'));
  const bcast = {
    v: 1 as const,
    type: 'bcast' as const,
    epoch: 3,
    seq: '0',
    ct: vector.broadcastCiphertext,
  };
  assert.deepEqual(validateSharedControlMessage(bcast, 'server'), bcast);
  assert.throws(() => validateSharedControlMessage({ ...bcast, seq: '00' }, 'server'));

  const member = {
    memberId: vector.from,
    idPub: vector.networkCodePublic,
    labelB64: encodeMemberLabel('PC-A'),
    sig: 'A'.repeat(86),
  };
  const common = {
    v: 1 as const,
    type: 'auth.ok' as const,
    network: vector.network,
    epoch: 1,
    members: [member],
    controllerPresent: true,
    admissionsOpen: true,
    serverTime: 1,
    idleExpiresAt: 2,
    maxExpiresAt: 3,
  };
  assert.doesNotThrow(() =>
    validateSharedControlMessage(
      { ...common, role: 'controller', controllerId: vector.to },
      'controller',
    ),
  );
  assert.doesNotThrow(() =>
    validateSharedControlMessage({ ...common, role: 'member', memberId: vector.from }, 'member'),
  );
  assert.doesNotThrow(() =>
    validateSharedControlMessage(
      {
        v: 1,
        type: 'net.state',
        admissionsOpen: true,
        epoch: 1,
        controllerMemberId: null,
        members: [vector.from],
        pending: [vector.to],
      },
      'controller',
    ),
  );
  assert.doesNotThrow(() =>
    validateSharedControlMessage(
      { v: 1, type: 'member.revoked', memberId: vector.to, code: 'INVITE_EXPIRED' },
      'controller',
    ),
  );
  for (const code of [
    'USER_END',
    'NETWORK_IDLE',
    'NETWORK_MAX',
    'CONTROLLER_GONE',
    'SERVER_SHUTDOWN',
  ])
    assert.doesNotThrow(() =>
      validateSharedControlMessage({ v: 1, type: 'net.closed', code }, 'member'),
    );
});
