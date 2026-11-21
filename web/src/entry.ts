import type { AppPaths } from './paths.ts';
import { classifyConnectionLink, looksLikeConnectionFragment } from './shared-link.ts';

export type WebEntry =
  | 'shared-receiver'
  | 'legacy-receiver'
  | 'legacy-sender'
  | 'shared-controller';

/** Selects the browser implementation without ever treating a malformed connection link as QR data. */
export function selectWebEntry(
  pathname: string,
  href: string,
  origin: string,
  paths: AppPaths,
  legacyReceiverHistory = false,
): WebEntry {
  if (pathname.replace(/\/$/, '') !== paths.sender) {
    const url = new URL(href);
    // Kept only as an explicit compatibility/test entrance for the already-shipped v1 Web UI.
    // The normal home page always starts the integrated shared receiver.
    if (
      url.pathname === paths.home &&
      !url.hash &&
      (url.search === '?legacy=1' || (!url.search && legacyReceiverHistory))
    )
      return 'legacy-receiver';
    return 'shared-receiver';
  }
  const connection = classifyConnectionLink(href, origin, paths);
  const fragment = new URL(href).hash;
  return connection.kind === 'legacy' ||
    (connection.kind === 'ordinary' && !looksLikeConnectionFragment(fragment))
    ? 'legacy-sender'
    : 'shared-controller';
}
