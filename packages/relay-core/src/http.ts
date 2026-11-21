/** Require one supported offer; only HTTP optional whitespace may surround it. */
export function acceptsWebSocketProtocol(value: string | null | undefined, expected = 'qrtoss.v1') {
  return value?.replace(/^[ \t]+|[ \t]+$/g, '') === expected;
}

export function publicOrigin(value: string, allowHttpLoopback = false) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        allowHttpLoopback &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error('PUBLIC_ORIGIN_INVALID');
  return url;
}

export function responseHeaders(url?: URL): Record<string, string> {
  const connect = url ? ` ${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` : '';
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${connect}; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(url?.protocol === 'https:' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

export function staticPath(path: string) {
  const cliAsset =
    path === '/run.sh' ||
    /^\/cli\/[0-9A-Za-z.-]+\/(?:run\.sh|qrtoss_[0-9A-Za-z.-]+_(?:darwin|linux)_(?:arm64|amd64)|SHA256SUMS(?:\.sig)?|LICENSE\.md|THIRD_PARTY_NOTICES|qrtoss\.rb)$/.test(
      path,
    );
  const requested =
    path === '/'
      ? 'index.html'
      : path === '/send'
        ? 'send/index.html'
        : cliAsset || path.startsWith('/assets/')
          ? path.slice(1)
          : undefined;
  return requested &&
    !requested.includes('..') &&
    !requested.includes('%') &&
    !requested.includes('\\')
    ? requested
    : undefined;
}

export function assetCacheControl(path: string) {
  return path.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/.test(path)
    ? 'public, max-age=31536000, immutable'
    : 'no-store';
}
