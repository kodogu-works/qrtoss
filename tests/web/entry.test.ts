import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWebEntry } from '../../web/src/entry.ts';
import { createAppPaths } from '../../web/src/paths.ts';

const pair = 'AAECAwQFBgcICQoLDA0ODw';
const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

test('the integrated receiver is the default home-page implementation', () => {
  const paths = createAppPaths('/qrtoss/');
  assert.equal(
    selectWebEntry('/qrtoss/', 'https://qrtoss.example/qrtoss/', 'https://qrtoss.example', paths),
    'shared-receiver',
  );
  assert.equal(
    selectWebEntry(
      '/qrtoss/',
      'https://qrtoss.example/qrtoss/?legacy=1',
      'https://qrtoss.example',
      paths,
    ),
    'legacy-receiver',
  );
  assert.equal(
    selectWebEntry(
      '/qrtoss/',
      'https://qrtoss.example/qrtoss/',
      'https://qrtoss.example',
      paths,
      true,
    ),
    'legacy-receiver',
  );
  for (const suffix of ['?legacy=1&extra=1', '?legacy=2', '?legacy=1#unexpected'])
    assert.equal(
      selectWebEntry(
        '/qrtoss/',
        `https://qrtoss.example/qrtoss/${suffix}`,
        'https://qrtoss.example',
        paths,
      ),
      'shared-receiver',
    );
});

test('the send page preserves canonical v1 links and selects the controller for v2', () => {
  const paths = createAppPaths('/qrtoss/');
  const base = 'https://qrtoss.example/qrtoss/send';
  assert.equal(
    selectWebEntry(
      paths.sender,
      `${base}#v=1&r=${pair}&j=${token}&k=${token}`,
      'https://qrtoss.example',
      paths,
    ),
    'legacy-sender',
  );
  assert.equal(
    selectWebEntry(
      paths.sender,
      `${base}#v=2&pair=${pair}&join=${token}&psk=${token}`,
      'https://qrtoss.example',
      paths,
    ),
    'shared-controller',
  );
});

test('malformed and unsupported connection-shaped links fail closed in the shared UI', () => {
  const paths = createAppPaths('/');
  for (const hash of ['#v=1', '#v=2', '#v=99&secret=do-not-display', `#v=2&pair=${pair}&join=bad`])
    assert.equal(
      selectWebEntry(
        paths.sender,
        `https://qrtoss.example/send${hash}`,
        'https://qrtoss.example',
        paths,
      ),
      'shared-controller',
    );
  assert.equal(
    selectWebEntry(
      paths.sender,
      `https://qrtoss.example/send?unexpected=1#v=1&r=${pair}&j=${token}&k=${token}`,
      'https://qrtoss.example',
      paths,
    ),
    'shared-controller',
  );
});
