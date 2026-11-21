import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppPaths, validateBasePath } from '../../web/src/paths.ts';

test('application URLs share the configured mount and stay on the public origin', () => {
  for (const base of ['/', '/qrtoss/', '/tools/qr-toss_v1.0/']) {
    const paths = createAppPaths(base);
    assert.deepEqual(paths, {
      home: base,
      sender: `${base}send`,
      rooms: `${base}api/v1/rooms`,
      socket: `${base}ws`,
      pairings: `${base}api/v2/pairings`,
      pairingSocket: `${base}api/v2/pairings/socket`,
      networks: `${base}api/v2/networks`,
      networkSocket: `${base}api/v2/networks/socket`,
    });
    for (const path of Object.values(paths)) {
      const url = new URL(path, 'https://myserver.example');
      assert.equal(url.origin, 'https://myserver.example');
      assert.equal(url.pathname, path);
    }
  }
});

test('base paths reject other origins, ambiguous paths and HTML attribute characters', () => {
  for (const base of [
    '',
    'qrtoss/',
    '/qrtoss',
    './',
    '../',
    '//',
    '//other.example/',
    'https://other.example/',
    '/./',
    '/../',
    '/qrtoss/../',
    '/qrtoss//',
    '/qr%2ftoss/',
    '/%2e%2e/',
    '/qr\\toss/',
    '/qrtoss/?x=1',
    '/qrtoss/#secret',
    '/qr toss/',
    '/qr\ntoss/',
    '/qr"toss/',
    "/qr'toss/",
    '/<script>/',
    '/qrtoss/\n',
    '/qrtoss/\r',
    '/qrtoss/\u2028',
    '/qrtoss/\u2029',
  ])
    assert.throws(() => validateBasePath(base), /QRTOSS_BASE_PATH/);
});
