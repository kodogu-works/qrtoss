import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateControlMessage } from '../../packages/protocol/src/control.ts';
import type { ControlTarget } from '../../packages/protocol/src/control.generated.ts';
import { parseControl } from '../../web/src/session.ts';

const vectors = JSON.parse(
  await readFile(new URL('../../protocol/vectors/control.json', import.meta.url), 'utf8'),
) as {
  cases: Array<{ name: string; targets: ControlTarget[]; json: string }>;
};
for (const vector of vectors.cases)
  test(`shared control vector: ${vector.name}`, () => {
    const message: unknown = JSON.parse(vector.json);
    for (const target of ['server', 'receiver', 'sender'] as const) {
      if (!vector.targets.includes(target)) {
        assert.throws(() => validateControlMessage(message, target), target);
        if (target !== 'server') assert.throws(() => parseControl(message, target));
        continue;
      }
      assert.deepEqual(validateControlMessage(message, target), message);
      if (target !== 'server') assert.deepEqual(parseControl(message, target), message);
      const fields = message as Record<string, unknown>;
      assert.throws(() => validateControlMessage({ ...fields, extra: true }, target));
      for (const key of Object.keys(fields)) {
        const missing = { ...fields };
        delete missing[key];
        assert.throws(() => validateControlMessage(missing, target), `missing ${key}`);
        assert.throws(
          () => validateControlMessage({ ...fields, [key]: null }, target),
          `null ${key}`,
        );
        assert.throws(
          () => validateControlMessage({ ...missing, [key.toUpperCase()]: fields[key] }, target),
          `case ${key}`,
        );
      }
    }
  });

test('control field names must be own properties, never inherited', () => {
  const message = Object.assign(Object.create({ reason: 'user_end' }), {
    v: 1,
    type: 'room.close',
    extra: true,
  });
  assert.throws(() => validateControlMessage(message, 'server'));
});
