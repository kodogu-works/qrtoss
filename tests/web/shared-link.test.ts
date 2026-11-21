import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyConnectionLink,
  parseSharedFragment,
  sharedInvitationURL,
} from '../../web/src/shared-link.ts';

const pair = 'AAECAwQFBgcICQoLDA0ODw';
const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const paths = { sender: '/tools/qrtoss/send' };

test('shared connection links have a canonical same-origin dedicated form', () => {
  const invitation = { pair, join: token, psk: token };
  const url = sharedInvitationURL('https://qrtoss.example', paths, invitation);
  assert.equal(
    url,
    `https://qrtoss.example/tools/qrtoss/send#v=2&pair=${pair}&join=${token}&psk=${token}`,
  );
  assert.deepEqual(classifyConnectionLink(url, 'https://qrtoss.example', paths), {
    kind: 'shared',
    invitation,
  });
  assert.deepEqual(parseSharedFragment(new URL(url).hash), invitation);
});

test('connection-shaped secrets never fall back to ordinary QR content', () => {
  const base = 'https://qrtoss.example/tools/qrtoss/send';
  for (const suffix of [
    '#v=2',
    `?unexpected=1#v=2&pair=${pair}&join=${token}&psk=${token}`,
    `#v=2&pair=${pair}&join=${token}&psk=${token}&extra=x`,
    `#v=2&pair=${pair}%3D&join=${token}&psk=${token}`,
    `#v=2&pair=${pair}&join=bad&psk=${token}`,
  ])
    assert.equal(
      classifyConnectionLink(base + suffix, 'https://qrtoss.example', paths).kind,
      'invalid',
    );
  assert.equal(
    classifyConnectionLink(
      `https://user:password@qrtoss.example/tools/qrtoss/send#v=2&pair=${pair}&join=${token}&psk=${token}`,
      'https://qrtoss.example',
      paths,
    ).kind,
    'invalid',
  );
  assert.deepEqual(
    classifyConnectionLink(`${base}#v=99&secret=x`, 'https://qrtoss.example', paths),
    { kind: 'unsupported', version: '99' },
  );
  assert.equal(
    classifyConnectionLink(
      `https://other.example/tools/qrtoss/send#v=2&pair=${pair}&join=${token}&psk=${token}`,
      'https://qrtoss.example',
      paths,
    ).kind,
    'ordinary',
  );
  assert.equal(
    classifyConnectionLink(
      `${base}#v=2&pair=${pair}&join=${token}&psk=${token}${'A'.repeat(2048)}`,
      'https://qrtoss.example',
      paths,
    ).kind,
    'invalid',
  );
});

test('legacy and ordinary URLs stay distinguishable', () => {
  const base = 'https://qrtoss.example/tools/qrtoss/send';
  assert.equal(
    classifyConnectionLink(
      `${base}#v=1&r=${pair}&j=${token}&k=${token}`,
      'https://qrtoss.example',
      paths,
    ).kind,
    'legacy',
  );
  assert.equal(
    classifyConnectionLink('https://qrtoss.example/about', 'https://qrtoss.example', paths).kind,
    'ordinary',
  );
});
