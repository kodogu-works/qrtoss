import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from 'esbuild';

const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const allowed = new Set([
  '$schema',
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'workers_dev',
  'preview_urls',
  'routes',
  'assets',
  'durable_objects',
  'migrations',
  'vars',
  'observability',
]);
function check(condition, code) {
  if (!condition) throw new Error(code);
}
check(
  Object.keys(config).every((key) => allowed.has(key)),
  'CLOUDFLARE_BINDING_OR_LOG_CONFIG',
);
check(config.workers_dev === false && config.preview_urls === false, 'CLOUDFLARE_PUBLIC_PREVIEW');
check(config.observability?.enabled === false, 'CLOUDFLARE_LOGGING');
check(
  JSON.stringify(config.compatibility_flags) === JSON.stringify(['no_web_socket_compression']),
  'CLOUDFLARE_COMPATIBILITY_FLAGS',
);
check(/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date), 'CLOUDFLARE_COMPATIBILITY_DATE');
check(
  config.routes?.length === 1 &&
    config.routes[0].custom_domain === true &&
    new URL(config.vars.PUBLIC_ORIGIN).origin === config.vars.PUBLIC_ORIGIN &&
    new URL(config.vars.PUBLIC_ORIGIN).protocol === 'https:' &&
    new URL(config.vars.PUBLIC_ORIGIN).host === config.routes[0].pattern,
  'CLOUDFLARE_ORIGIN',
);
check(
  config.assets?.binding === 'ASSETS' &&
    config.assets.run_worker_first === true &&
    config.assets.html_handling === 'none' &&
    config.assets.not_found_handling === 'none',
  'CLOUDFLARE_ASSETS',
);
check(
  JSON.stringify(config.durable_objects?.bindings) ===
    JSON.stringify([
      { name: 'ROOM', class_name: 'RoomDO' },
      { name: 'CAPACITY', class_name: 'CapacityDO' },
    ]),
  'CLOUDFLARE_DO_BINDINGS',
);
check(
  config.migrations?.some(
    (migration) =>
      migration.new_sqlite_classes?.includes('RoomDO') &&
      migration.new_sqlite_classes?.includes('CapacityDO'),
  ),
  'CLOUDFLARE_SQLITE_MIGRATION',
);
const forbidden = new Set([
  'storage',
  'sql',
  'setAlarm',
  'getAlarm',
  'deleteAlarm',
  'serializeAttachment',
  'deserializeAttachment',
  'acceptWebSocket',
  'setWebSocketAutoResponse',
  'caches',
  'console',
]);
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(path);
      continue;
    }
    if (!path.endsWith('.ts')) continue;
    // Parse TypeScript and remove comments before checking executable references.
    const { code } = await transform(await readFile(path, 'utf8'), {
      loader: 'ts',
      legalComments: 'none',
    });
    for (const name of forbidden)
      if (new RegExp('\\b' + name + '\\b').test(code))
        throw new Error('CLOUDFLARE_PERSISTENCE_OR_LOGGING: ' + path);
    if (/from\s*['"](?:node:|ws['"])/.test(code))
      throw new Error('CLOUDFLARE_PLATFORM_IMPORT: ' + path);
  }
}
await inspect('packages/relay-core/src');
await inspect('server/cloudflare/src');
process.stdout.write('Cloudflare non-persistence and deployment checks passed\n');
