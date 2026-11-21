import { decodeBase64 } from '../../packages/protocol/src/validation.ts';
export type SharedInvitation = Readonly<{
  pair: string;
  join: string;
  psk: string;
}>;

export type ConnectionLink =
  | { kind: 'shared'; invitation: SharedInvitation }
  | { kind: 'legacy'; fragment: string }
  | { kind: 'unsupported'; version: string }
  | { kind: 'invalid' }
  | { kind: 'ordinary' };

const forbiddenEncoding = /[%+\s]/;

function canonicalToken(value: string | null, bytes: number): string {
  if (value === null || forbiddenEncoding.test(value)) throw new Error('PAIR_LINK_INVALID');
  decodeBase64(value, bytes);
  return value;
}

function exactKeys(params: URLSearchParams, expected: readonly string[]): boolean {
  const keys = [...params.keys()];
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

/**
 * Identifies only the dedicated same-origin send path. Once a URL looks like a qrtoss
 * connection link, malformed and unsupported forms never fall back to ordinary QR content.
 */
export function classifyConnectionLink(
  value: string,
  origin: string,
  paths: { readonly sender: string },
): ConnectionLink {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'ordinary' };
  }
  if (url.origin !== origin || url.pathname !== paths.sender || !url.hash)
    return { kind: 'ordinary' };
  // A hash-bearing URL at the dedicated sender path is connection-shaped. Never let
  // query/userinfo variants fall through to the ordinary QR preview, where capabilities
  // and PSKs could be displayed or forwarded as content.
  if (url.search || url.username || url.password) return { kind: 'invalid' };
  if (value.length > 2048) return { kind: 'invalid' };

  const raw = url.hash.slice(1);
  if (!raw || forbiddenEncoding.test(raw)) return { kind: 'invalid' };
  const params = new URLSearchParams(raw);
  const version = params.get('v');
  if (version === '1') {
    if (!exactKeys(params, ['v', 'r', 'j', 'k'])) return { kind: 'invalid' };
    try {
      canonicalToken(params.get('r'), 16);
      canonicalToken(params.get('j'), 32);
      canonicalToken(params.get('k'), 32);
      return { kind: 'legacy', fragment: url.hash };
    } catch {
      return { kind: 'invalid' };
    }
  }
  if (version !== '2') {
    if (version !== null) return { kind: 'unsupported', version };
    return { kind: 'invalid' };
  }
  if (!exactKeys(params, ['v', 'pair', 'join', 'psk'])) return { kind: 'invalid' };
  try {
    return {
      kind: 'shared',
      invitation: {
        pair: canonicalToken(params.get('pair'), 16),
        join: canonicalToken(params.get('join'), 32),
        psk: canonicalToken(params.get('psk'), 32),
      },
    };
  } catch {
    return { kind: 'invalid' };
  }
}

export function parseSharedFragment(fragment: string): SharedInvitation {
  const result = classifyConnectionLink(
    `https://qrtoss.invalid/send${fragment}`,
    'https://qrtoss.invalid',
    { sender: '/send' },
  );
  if (result.kind !== 'shared') throw new Error('PAIR_LINK_INVALID');
  return result.invitation;
}

export function sharedInvitationURL(
  origin: string,
  paths: { readonly sender: string },
  invitation: SharedInvitation,
): string {
  canonicalToken(invitation.pair, 16);
  canonicalToken(invitation.join, 32);
  canonicalToken(invitation.psk, 32);
  const url = new URL(paths.sender, origin);
  url.hash = `v=2&pair=${invitation.pair}&join=${invitation.join}&psk=${invitation.psk}`;
  return url.href;
}

export function looksLikeConnectionFragment(fragment: string): boolean {
  if (!fragment.startsWith('#')) return false;
  const params = new URLSearchParams(fragment.slice(1));
  return params.has('v');
}
