import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('COMMAND_FAILED'))));
  });
}
const action = process.argv[2];
if (!['dev', 'deploy', 'test'].includes(action)) throw new Error('CLOUDFLARE_COMMAND_INVALID');
if (process.env.QRTOSS_BASE_PATH && process.env.QRTOSS_BASE_PATH !== '/')
  throw new Error('CLOUDFLARE_REQUIRES_ROOT_BASE_PATH');
let temporaryDirectory;
let configPath;
try {
  if (action === 'deploy' && process.env.PUBLIC_ORIGIN) {
    const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
    const origin = new URL(process.env.PUBLIC_ORIGIN);
    config.vars.PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN;
    config.workers_dev = origin.hostname.endsWith('.workers.dev');
    config.routes = config.workers_dev ? [] : [{ pattern: origin.host, custom_domain: true }];
    // Paths in an alternate Wrangler config are relative to that config.
    config.main = resolve(config.main);
    config.assets.directory = resolve(config.assets.directory);
    config.$schema = resolve(config.$schema);
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'qrtoss-deploy-'));
    configPath = join(temporaryDirectory, 'wrangler.json');
    await writeFile(configPath, JSON.stringify(config));
  }
  await run(process.execPath, [
    'scripts/check-cloudflare.mjs',
    ...(configPath ? [configPath] : []),
  ]);

  await run('npm', ['run', 'build:web']);
  if (action === 'deploy') {
    const config = JSON.parse(await readFile(configPath ?? 'wrangler.jsonc', 'utf8'));
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    if (typeof version !== 'string' || !/^[0-9A-Za-z.-]+$/.test(version))
      throw new Error('CLI_VERSION_INVALID');
    const origin = config.vars.PUBLIC_ORIGIN;
    const assets = resolve(config.assets.directory);
    const output = join(assets, 'cli', version);
    await run('sh', ['scripts/release-cli.sh', output], {
      ...process.env,
      QRTOSS_PUBLIC_ORIGIN: origin,
      QRTOSS_DOWNLOAD_BASE_URL: `${origin}/cli/${version}`,
    });
    await copyFile(join(output, 'run.sh'), join(assets, 'run.sh'));
  }
  if (action === 'dev') {
    await run(
      'wrangler',
      [
        'dev',
        '--local',
        '--infer-origin-from-routes=false',
        '--ip',
        '127.0.0.1',
        '--port',
        '8787',
        '--local-protocol',
        'https',
        '--var',
        'PUBLIC_ORIGIN:https://127.0.0.1:8787',
      ],
      { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    );
  } else if (action === 'deploy') {
    await run(
      'wrangler',
      ['deploy', ...(configPath ? ['--config', configPath] : []), ...process.argv.slice(3)],
      { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    );
  } else {
    await run(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        'tests/relay/relay.test.ts',
        'tests/interop/relay.test.ts',
        'tests/interop/cli.test.ts',
        'tests/cloudflare/*.integration.ts',
      ],
      { ...process.env, QRTOSS_TEST_RELAY: 'cloudflare' },
    );
  }
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
