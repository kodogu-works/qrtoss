import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../web/src/content.ts';

test('only explicit, unambiguous HTTP(S) URLs may open automatically', () => {
  for (const text of [
    'https://example.org/',
    'HTTP://EXAMPLE.ORG/a?x=1',
    'https://example.org/日本語',
  ]) {
    const result = classify(text);
    assert.equal(result.kind, 'web');
    assert.ok(result.href?.startsWith('http'));
  }
  for (const text of [
    ' https://example.org',
    'https://example.org ',
    'https://u:p@example.org',
    'https://example.org\n',
    'http:foo',
    'https:/foo',
    'https://example.org\\evil',
  ])
    assert.equal(classify(text).kind, 'ambiguous', text);
});
test('inert schemes never acquire an executable link and text formats stay text', () => {
  for (const scheme of [
    'javascript',
    'JaVaScRiPt',
    'data',
    'file',
    'blob',
    'about',
    'chrome',
    'edge',
    'resource',
    'view-source',
    'vbscript',
  ]) {
    const result = classify(`${scheme}:anything`);
    assert.equal(result.kind, 'inert_uri');
    assert.equal(result.href, undefined);
  }
  for (const text of [
    'WIFI:S:Example;',
    'wifi:S:Example;',
    'BEGIN:VCARD\nVERSION:4.0',
    'example.org',
    '/relative/path',
    '日本語\n二行目',
    '<img src=x onerror=alert(1)>',
  ])
    assert.equal(classify(text).kind, 'text');
});
test('external schemes are exposed only as explicit manual actions', () => {
  for (const text of [
    'mailto:user@example.org',
    'tel:+81312345678',
    'sms:+81312345678',
    'geo:35,139',
    'custom-app:some-action',
  ]) {
    const result = classify(text);
    assert.equal(result.kind, 'external');
    assert.ok(result.href);
  }
});
