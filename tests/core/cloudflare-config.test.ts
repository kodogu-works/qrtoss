import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/check-cloudflare.mjs', import.meta.url));
const configured = JSON.parse(
  await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'),
);
const base = {
  ...configured,
  name: 'qrtoss',
  workers_dev: false,
  routes: [{ pattern: 'qrtoss.example', custom_domain: true }],
  vars: { ...configured.vars, PUBLIC_ORIGIN: 'https://qrtoss.example' },
};
function workersDev() {
  return {
    ...structuredClone(base),
    name: 'qrtoss',
    workers_dev: true,
    routes: [],
    vars: { ...base.vars, PUBLIC_ORIGIN: 'https://qrtoss.my-account.workers.dev' },
  };
}
async function checker(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'qrtoss-cloudflare-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Isolate configuration checks from the independently checked production sources.
  await mkdir(join(directory, 'packages/relay-core/src'), { recursive: true });
  await mkdir(join(directory, 'server/cloudflare/src'), { recursive: true });
  return async (config: unknown) => {
    await writeFile(join(directory, 'wrangler.jsonc'), JSON.stringify(config));
    return spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000,
    });
  };
}

test('Cloudflare config accepts custom domains and canonical workers.dev origins', async (t) => {
  const check = await checker(t);
  const withoutRoutes = { ...workersDev(), routes: undefined };
  for (const config of [base, workersDev(), withoutRoutes, { ...workersDev(), name: 'QRTOSS' }]) {
    const result = await check(config);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('Cloudflare config rejects mismatched origins, mixed hosting and version URLs', async (t) => {
  const check = await checker(t);
  const invalid = [
    { ...workersDev(), routes: base.routes },
    { ...workersDev(), workers_dev: false },
    { ...workersDev(), name: 'other-worker' },
    { ...workersDev(), name: '-qrtoss' },
    { ...workersDev(), name: 'q'.repeat(64) },
    { ...base, vars: { ...base.vars, PUBLIC_ORIGIN: 'https://wrong.example' } },
    ...[
      'https://qrtoss.example',
      'https://my-account.workers.dev',
      'https://version-qrtoss.my-account.workers.dev',
      'https://qrtoss.my-account.other.workers.dev',
      'https://qrtoss.-account.workers.dev',
      'https://qrtoss.my-account.workers.dev:8443',
      'https://qrtoss.my-account.workers.dev/',
      'https://qrtoss.my-account.workers.dev/path',
      'http://qrtoss.my-account.workers.dev',
    ].map((origin) => ({ ...workersDev(), vars: { ...base.vars, PUBLIC_ORIGIN: origin } })),
  ];
  for (const config of invalid) {
    const result = await check(config);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLOUDFLARE_ORIGIN/);
  }
});

test('workers.dev config retains preview, logging and compression restrictions', async (t) => {
  const check = await checker(t);
  for (const [patch, code] of [
    [{ preview_urls: true }, 'CLOUDFLARE_PUBLIC_PREVIEW'],
    [{ preview_urls: undefined }, 'CLOUDFLARE_PUBLIC_PREVIEW'],
    [{ observability: { enabled: true } }, 'CLOUDFLARE_LOGGING'],
    [{ compatibility_flags: ['web_socket_compression'] }, 'CLOUDFLARE_COMPATIBILITY_FLAGS'],
  ] as const) {
    const result = await check({ ...workersDev(), ...patch });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(code), result.stderr);
  }
});
