import { isIP } from 'node:net';

/** Canonical addresses for proxy trust checks, before applying rate-limit prefixes. */
export function normalizeIp(address: string): string | undefined {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  // Socket IPv6 addresses may include a scope ID. It is not part of the address.
  const host = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
  const [left, right] = host.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const words = right === undefined ? head : [
    ...head,
    ...Array<string>(8 - head.length - tail.length).fill('0'),
    ...tail,
  ];
  const bytes = words.flatMap(word => [parseInt(word, 16) >> 8, parseInt(word, 16) & 255]);
  // Treat all spellings of IPv4-mapped IPv6 as the same IPv4 address.
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return bytes.slice(12).join('.');
  }
  return words.map(word => word.padStart(4, '0')).join(':');
}

/** One key shared by room creation, authentication failures and socket counts. */
export function ipLimitKey(address: string, ipv6PrefixLength: number): string {
  if (!address.includes(':')) return address;
  const value = BigInt(`0x${address.replaceAll(':', '')}`);
  const hostBits = BigInt(128 - ipv6PrefixLength);
  const network = (value >> hostBits) << hostBits;
  return `${network.toString(16).padStart(32, '0')}/${ipv6PrefixLength}`;
}
