import { dictionaries, errors } from '../web/src/i18n.ts';
import { readFile } from 'node:fs/promises';
const keys = Object.keys(dictionaries.en).sort();
const params = (s) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');
for (const [lang, dict] of Object.entries(dictionaries)) {
  if (Object.keys(dict).sort().join(',') !== keys.join(','))
    throw new Error(`Keys differ: ${lang}`);
  for (const key of keys)
    if (!dict[key] || params(dict[key]) !== params(dictionaries.en[key]))
      throw new Error(`Invalid translation: ${lang}/${key}`);
}
for (const code of JSON.parse(await readFile('protocol/error-codes.json', 'utf8'))) {
  for (const lang of ['en', 'ja', 'es'])
    if (!errors[code]?.[lang]) throw new Error(`Missing error: ${code}/${lang}`);
}
console.log(
  'Web dictionaries and error translations: en, ja, es OK. CLI dictionaries are checked by go test.',
);
