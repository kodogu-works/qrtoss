/** Canonical addresses before applying the rate-limit prefix. No platform imports. */
export function normalizeIp(address: string): string | undefined {
  if (!address.includes(':')) {
    const parts = address.split('.');
    return parts.length === 4 &&
      parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
      ? address
      : undefined;
  }
  try {
    const raw = address.split('%');
    if (
      raw.length > 2 ||
      !/^[0-9a-f:.]+$/i.test(raw[0]) ||
      (raw.length === 2 && !/^[0-9a-z_.~-]+$/i.test(raw[1]))
    )
      return undefined;
    const host = new URL(`http://[${raw[0]}]/`).hostname.slice(1, -1);
    const [left, right] = host.split('::');
    const head = left ? left.split(':') : [];
    const tail = right ? right.split(':') : [];
    const words =
      right === undefined
        ? head
        : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
    const bytes = words.flatMap((word) => [parseInt(word, 16) >> 8, parseInt(word, 16) & 255]);
    if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255)
      return bytes.slice(12).join('.');
    return words.map((word) => word.padStart(4, '0')).join(':');
  } catch {
    return undefined;
  }
}

/** One key for room creation, authentication failures and socket counts. */
export function ipLimitKey(address: string, ipv6PrefixLength: number): string {
  if (!address.includes(':')) return address;
  const value = BigInt(`0x${address.replaceAll(':', '')}`);
  const hostBits = BigInt(128 - ipv6PrefixLength);
  const network = (value >> hostBits) << hostBits;
  return `${network.toString(16).padStart(32, '0')}/${ipv6PrefixLength}`;
}
