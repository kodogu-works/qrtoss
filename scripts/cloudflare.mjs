import { spawn } from 'node:child_process';

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
await run('npm', ['run', 'check:cloudflare']);
await run('npm', ['run', 'build:web']);
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
  await run('wrangler', ['deploy'], { ...process.env, WRANGLER_SEND_METRICS: 'false' });
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
