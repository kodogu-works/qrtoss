import { chooseLanguage, errorText, translate, type Key, type Language } from './i18n';
import type { AppPaths } from './paths';
import type { Phase } from './session';

const iconPaths = {
  arrow: '<path d="M6 18 18 6M6 6h12v12"/>',
  github:
    '<path d="M8 21v-3.3c-3.2.7-3.8-1.5-4.5-2M16 21v-3.8c0-1-.3-1.6-.8-2.1 3.1-.4 5.8-1.5 5.8-5.5 0-1.3-.5-2.5-1.4-3.4.2-1.1.1-2.2-.4-3.2-1.6 0-2.9.8-3.7 1.4a12 12 0 0 0-7 0C7.7 3.8 6.4 3 4.8 3c-.5 1-.6 2.1-.4 3.2A4.9 4.9 0 0 0 3 9.6c0 4 2.7 5.1 5.8 5.5-.5.5-.8 1.1-.8 2.1"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  disconnected: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  link: '<path d="m9 15 6-6m-5-3 1-1a5 5 0 0 1 7 7l-1 1m-3 5-1 1a5 5 0 0 1-7-7l1-1"/>',
  qr: '<path d="M9 3H3v6h6V3Zm12 0h-6v6h6V3ZM9 15H3v6h6v-6Zm6 0h3v3h3m-6 3h3m3 0v-1"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-3L3 10m0-6v6h6m-5 4a8 8 0 0 0 14 3l3-3m0 6v-6h-6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
} as const;

function icon(name: keyof typeof iconPaths): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${iconPaths[name]}</svg>`;
}

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
export function loadLanguage(): Language {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('qrtoss.language');
  } catch {
    /* storage may be disabled */
  }
  return chooseLanguage(navigator.languages, saved);
}
export function mountPage(sender: boolean, paths: AppPaths): void {
  const root = document.querySelector<HTMLDivElement>('#app')!;
  root.innerHTML = `
<div class="shell">
<header class="topbar">
<a class="wordmark" href="${paths.home}" aria-label="qrtoss">
<span class="brand-symbol">${icon('arrow')}</span>qrtoss<span class="brand-dot">.</span>
</a>
<div class="header-actions">
<a class="github-link" href="https://github.com/kodogu-works/qrtoss" target="_blank" rel="noopener noreferrer" data-i18n-aria-label="githubLabel">
${icon('github')}<span>GitHub</span>
</a>
<label class="language">
<span id="language-label" class="sr-only" data-i18n="language">
</span>
<select id="language" aria-labelledby="language-label">
<option value="en">English</option>
<option value="ja">日本語</option>
<option value="es">Español</option>
</select>
${icon('chevron')}
</label>
</div>
</header>
<main class="${sender ? 'sender-main' : 'receiver-main'}">
<h1 data-i18n="${sender ? 'sendTitle' : 'receive'}">
</h1>
${sender ? '<p class="sender-intro" data-i18n="senderIntro"></p>' : ''}
<div class="workspace">
<section class="card primary-card" aria-labelledby="connection-heading">
<div class="card-heading">
<h2 id="connection-heading" data-i18n="${sender ? 'preview' : 'stepOne'}">
</h2>
${sender ? '<p id="copy-feedback" role="status" class="copy-feedback"></p>' : ''}
</div>
<div class="connection-status" role="status" aria-live="polite" aria-atomic="true">
<span id="status-icon" class="status-icon" aria-hidden="true">${icon('clock')}</span>
<span id="status">
</span>
</div>
<p id="peer-mode" class="peer-mode" hidden>
</p>
<p id="error" class="notice error" role="alert" hidden>
</p>
${
  sender
    ? `<div id="camera" class="camera" hidden>
<video id="video" muted autoplay playsinline>
</video>
<div class="camera-reticle" aria-hidden="true">
</div>
</div>
<div id="scan-placeholder" class="scan-placeholder">
${icon('qr')}
<p data-i18n="cameraHelp">
</p>
</div>
<div id="sender-preview" class="preview" hidden>
<p id="domain" class="domain">
</p>
<pre id="sender-text" dir="auto" tabindex="0" data-i18n-aria-label="preview">
</pre>
</div>
<div class="actions">
<button id="scan" class="button accent" data-i18n="scan" disabled>
</button>
<button id="stop" class="button secondary" data-i18n="stop" hidden>
</button>
<button id="send" class="button accent" data-i18n="send" hidden>
</button>
<button id="retry" class="button secondary" data-i18n="retry" hidden>
</button>
<button id="copy" class="button secondary" hidden>
${icon('copy')}<span data-i18n="copy"></span>
</button>
</div>
<p id="cli-done" class="hint" data-i18n="cliDone" hidden>
</p>`
    : `<div id="qr-wrap" class="qr-wrap">
<div class="qr-frame">
<canvas id="qr" data-i18n-aria-label="connectionQR" aria-describedby="qr-help secret-hint" role="img">
</canvas>
<div id="qr-loading" class="qr-loading" aria-hidden="true">
${icon('qr')}
</div>
</div>
<div id="expiry" class="expiry">
</div>
</div>
<div id="connected-art" class="connected-state" hidden>
${icon('check')}
<p data-i18n="connectedHelp"></p>
</div>
<p id="qr-help" class="qr-help" data-i18n="qrHelp">
</p>
<p id="secret-hint" class="secret-hint" data-i18n="qrSecret">
</p>
<button id="new-qr" class="button secondary wide">
${icon('refresh')}<span data-i18n="newQR"></span>
</button>`
}
</section>
${
  sender
    ? ''
    : `<div class="side-column">
<section class="card mode-card" aria-labelledby="mode-heading">
<div class="card-heading">
<h2 id="mode-heading" data-i18n="stepTwo">
</h2>
</div>
<fieldset id="modes">
<legend class="sr-only" data-i18n="stepTwo">
</legend>
<label class="mode-choice">
<input type="radio" name="mode" value="auto_open" aria-labelledby="auto-label" aria-describedby="auto-help" checked>
<span>
<strong id="auto-label" data-i18n="auto">
</strong>
<small id="auto-help" data-i18n="navigationHelp">
</small>
</span>
</label>
<label class="mode-choice">
<input type="radio" name="mode" value="display_only" aria-labelledby="display-label" aria-describedby="display-help">
<span>
<strong id="display-label" data-i18n="display">
</strong>
<small id="display-help" data-i18n="modeHelp">
</small>
</span>
</label>
</fieldset>
</section>
<section class="card result-card" aria-labelledby="result-heading">
<div class="card-heading">
<h2 id="result-heading" data-i18n="stepThree">
</h2>
<p id="copy-feedback" role="status" class="copy-feedback"></p>
</div>
<p id="empty" class="empty" data-i18n="empty">
</p>
<div id="receiver-preview" class="preview" hidden>
<pre id="receiver-text" dir="auto" tabindex="0" data-i18n-aria-label="stepThree">
</pre>
</div>
<p id="cancelled" class="hint" data-i18n="cancelledAuto" hidden>
</p>
<div class="actions">
<button id="open" class="button accent" hidden>
</button>
<button id="copy" class="button secondary" hidden>
${icon('copy')}<span data-i18n="copy"></span>
</button>
<button id="clear" class="text-button" data-i18n="clear" hidden>
</button>
</div>
</section>
</div>`
}
</div>
<ul class="trust-row">
<li>
${icon('lock')}
<span data-i18n="private">
</span>
</li>
<li>
${icon('user')}
<span data-i18n="noAccount">
</span>
</li>
<li>
${icon('clock')}
<span data-i18n="noHistory">
</span>
</li>
</ul>
</main>
<footer>
<span>qrtoss / <span id="version">
</span>
</span>
<span data-i18n="license">
</span>
</footer>
</div>`;
}
export function renderChrome(
  language: Language,
  status: Key,
  phase: Phase,
  errorCode: string,
  hasPreview: boolean,
  copied: boolean,
  manualCopy: boolean,
): void {
  const text = (key: Key) => translate(language, key);
  document.documentElement.lang = language;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    node.textContent = text(node.dataset.i18n as Key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', text(node.dataset.i18nAriaLabel as Key));
  });
  el<HTMLSelectElement>('language').value = language;
  el('status').textContent = text(status);
  el('status-icon').innerHTML = icon(
    phase === 'connected'
      ? 'check'
      : phase === 'disconnected'
        ? 'disconnected'
        : phase === 'pairing'
          ? 'link'
          : 'clock',
  );
  el('error').hidden = !errorCode;
  el('error').textContent = errorCode ? errorText(language, errorCode) : '';
  el('copy').hidden = !hasPreview;
  el('copy-feedback').textContent = copied ? text('copied') : manualCopy ? text('manualCopy') : '';
}
