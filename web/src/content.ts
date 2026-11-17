export type Classification = {
  kind: 'web' | 'external' | 'text' | 'inert_uri' | 'ambiguous';
  href?: string;
  host?: string;
};
const inert = new Set([
  'javascript',
  'data',
  'file',
  'blob',
  'about',
  'chrome',
  'edge',
  'resource',
  'view-source',
  'vbscript',
]);

/** Classification never changes the original string used for preview/copy. */
export function classify(text: string): Classification {
  if (/^(wifi:|begin:vcard)/i.test(text)) return { kind: 'text' };
  if (text.trim() !== text && /^[a-z][a-z0-9+.-]*:/i.test(text.trim()))
    return { kind: 'ambiguous' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (!scheme) return { kind: 'text' };
  if (inert.has(scheme)) return { kind: 'inert_uri' };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: URL classification deliberately rejects ASCII controls.
  if (text.trim() !== text || /[\u0000-\u0020\u007f\\]/u.test(text)) return { kind: 'ambiguous' };
  if (scheme === 'http' || scheme === 'https') {
    if (!/^https?:\/\//i.test(text)) return { kind: 'ambiguous' };
    try {
      const url = new URL(text);
      if (!url.hostname || url.username || url.password) return { kind: 'ambiguous' };
      return { kind: 'web', href: url.href, host: url.host };
    } catch {
      return { kind: 'ambiguous' };
    }
  }
  try {
    return { kind: 'external', href: new URL(text).href };
  } catch {
    return { kind: 'ambiguous' };
  }
}
