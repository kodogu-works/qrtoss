import { resolve } from 'node:path';
import { createRelay } from './index.ts';

function positive(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('CONFIG_INVALID');
  return Number(raw);
}
try {
  if (!process.env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN_REQUIRED');
  const relay = createRelay({
    publicOrigin: process.env.PUBLIC_ORIGIN,
    staticDir: resolve(process.env.STATIC_DIR ?? 'dist/web'),
    allowHttpLoopback: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
    maxRooms: positive('MAX_ROOMS', 1000),
    maxSockets: positive('MAX_SOCKETS', 2200),
    maxUnauthenticatedSockets: positive('MAX_UNAUTHENTICATED_SOCKETS', 100),
    maxSocketsPerIp: positive('MAX_SOCKETS_PER_IP', 60),
    ipv6PrefixLength: positive('IPV6_PREFIX_LENGTH', 64),
    trustProxyCidrs: process.env.TRUST_PROXY_CIDRS?.split(',').map(x => x.trim()).filter(Boolean),
  });
  await relay.listen(positive('PORT', 8080), process.env.HOST ?? '0.0.0.0');
  process.stderr.write('qrtoss relay started\n');
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 5000);
    timeout.unref();
    void relay.close().then(() => { clearTimeout(timeout); process.exitCode = 0; });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  process.stderr.write('qrtoss: CONFIG_OR_STARTUP_ERROR\n');
  process.exitCode = 2;
}
