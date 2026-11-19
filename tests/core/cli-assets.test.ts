import test from 'node:test';
import assert from 'node:assert/strict';
import { staticPath, assetCacheControl } from '../../packages/relay-core/src/http.ts';

test('CLI downloads are allowed and mutable launchers are not cached', () => {
  for (const path of [
    '/run.sh',
    '/cli/0.3.0/run.sh',
    '/cli/0.3.0/qrtoss_0.3.0_linux_amd64',
    '/cli/0.3.0/qrtoss_0.3.0_darwin_arm64',
    '/cli/0.3.0/SHA256SUMS',
    '/cli/0.3.0/LICENSE.md',
    '/cli/0.3.0/THIRD_PARTY_NOTICES',
  ]) {
    assert.equal(staticPath(path), path.slice(1));
    assert.equal(assetCacheControl(path.slice(1)), 'no-store');
  }
  for (const path of [
    '/cli/../run.sh',
    '/cli/%2e%2e/run.sh',
    '/cli/0.3.0/private.key',
    '/cli/0.3.0/nested/run.sh',
    '/run.sh/extra',
  ]) {
    assert.equal(staticPath(path), undefined);
  }
});
