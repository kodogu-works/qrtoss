import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLanguage, dictionaries, en, errors, translate } from '../../web/src/i18n.ts';

test('manual language wins and unsupported preferences are skipped', () => {
  assert.equal(chooseLanguage(['ja-JP'], 'es'), 'es');
  assert.equal(chooseLanguage(['zh-Hant-TW', 'fr-FR', 'ja-JP']), 'ja');
  assert.equal(chooseLanguage(['es-MX', 'en-US']), 'es');
  assert.equal(chooseLanguage(['pt-PT'], 'garbage'), 'en');
});
test('all supported locales contain every UI and error translation', () => {
  const expected = Object.keys(en).sort();
  for (const dictionary of Object.values(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary).sort(), expected);
    for (const [key, value] of Object.entries(dictionary)) {
      assert.ok(value.length > 0, key);
      assert.deepEqual(
        value.match(/\{\w+\}/g) ?? [],
        en[key as keyof typeof en].match(/\{\w+\}/g) ?? [],
        key,
      );
    }
  }
  for (const value of Object.values(errors))
    for (const locale of ['en', 'ja', 'es'] as const) assert.ok(value[locale]);
  assert.equal(translate('en', 'expires', { seconds: 42 }), 'Expires in 42s');
});
