import {
  languageLabels,
  chooseLanguage,
  errorText,
  translate,
  type Key,
  type Language,
} from './i18n';
import type { AppPaths } from './paths';
import type { Phase } from './session';

const iconPaths = {
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5m0 3h.01"/>',
  reload: '<path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 0-2.3 5.7M20 7v5l-4-4"/>',
  arrow: '<path d="M6 18 18 6M6 6h12v12"/>',
  github:
    '<path d="M8 21v-3.3c-3.2.7-3.8-1.5-4.5-2M16 21v-3.8c0-1-.3-1.6-.8-2.1 3.1-.4 5.8-1.5 5.8-5.5 0-1.3-.5-2.5-1.4-3.4.2-1.1.1-2.2-.4-3.2-1.6 0-2.9.8-3.7 1.4a12 12 0 0 0-7 0C7.7 3.8 6.4 3 4.8 3c-.5 1-.6 2.1-.4 3.2A4.9 4.9 0 0 0 3 9.6c0 4 2.7 5.1 5.8 5.5-.5.5-.8 1.1-.8 2.1"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  disconnected: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  link: '<path d="m9 15 6-6m-5-3 1-1a5 5 0 0 1 7 7l-1 1m-3 5-1 1a5 5 0 0 1-7-7l1-1"/>',
  qr: '<path d="M9 3H3v6h6V3Zm12 0h-6v6h6V3ZM9 15H3v6h6v-6Zm6 0h3v3h3m-6 3h3m3 0v-1"/>',
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
function header(paths: AppPaths, sender: boolean): string {
  return `<header class="topbar">
<a class="wordmark" href="${paths.home}" aria-label="qrtoss">
<span class="brand-symbol">${icon('arrow')}</span>qrtoss<span class="brand-dot">.</span>
</a>
<div class="header-actions">
${sender ? '' : `<button id="receiver-help" class="help-button" data-i18n-aria-label="helpTitle" aria-haspopup="dialog" aria-controls="receiver-help-dialog">${icon('help')}<span data-i18n="helpTitle"></span></button>`}
<a class="github-link" href="https://github.com/kodogu-works/qrtoss" target="_blank" rel="noopener noreferrer" data-i18n-aria-label="githubLabel">
${icon('github')}<span>GitHub</span>
</a>
<label class="language">
<span id="language-label" class="sr-only" data-i18n="language">
</span>
<select id="language" aria-labelledby="language-label">
${Object.entries(languageLabels)
  .map(([language, label]) => `<option value="${language}">${label}</option>`)
  .join('')}
</select>
${icon('chevron')}
</label>
</div>
</header>`;
}
function footer(): string {
  return `<footer>
<span>qrtoss / <span id="version">
</span>
</span>
<span data-i18n="license">
</span>
</footer>`;
}

function marketing(): string {
  const features = ['Camera', 'Scan', 'Browser', 'Devices', 'Secure', 'Storage', 'Open'];
  return `<section class="marketing" aria-labelledby="marketing-title">
<div class="marketing-intro"><h2 id="marketing-title" data-i18n="marketingTitle"></h2><p data-i18n="marketingTagline"></p></div>
<div class="feature-grid">${features.map((feature) => `<article><h3 data-i18n="feature${feature}Title"></h3><p data-i18n="feature${feature}Body"></p></article>`).join('')}</div>
</section>`;
}

export function mountPage(sender: boolean, paths: AppPaths): void {
  const root = document.querySelector<HTMLDivElement>('#app')!;
  const receiver = `
<main class="receiver-main">
<section class="pairing-stage" aria-labelledby="qr-help">
<h1 id="qr-help" data-i18n="receiverPrompt"></h1>
<div id="qr-wrap" class="qr-wrap">
<div class="qr-frame">
<canvas id="qr" data-i18n-aria-label="connectionQR" aria-describedby="qr-help" role="img"></canvas>
<div id="qr-loading" class="qr-loading" aria-hidden="true">${icon('qr')}</div>
</div>
<div class="qr-status">
<p id="qr-expiry" class="expiry"><span data-i18n="qrValidity"></span> <span id="expiry"></span></p>
<div id="qr-error-actions" class="qr-error-actions" hidden>
<p id="error" class="notice error" role="alert" hidden></p>
<button id="regenerate-qr" class="button secondary" data-i18n-aria-label="regenerateQR" hidden>${icon('reload')}</button>
</div>
</div>
</div>
</section>
<section id="receiver-result" class="card result-card" aria-labelledby="result-heading" hidden>
<div class="card-heading"><h2 id="result-heading" data-i18n="stepThree"></h2>
<p id="copy-feedback" role="status" class="copy-feedback"></p></div>
<div id="receiver-preview" class="preview"><pre id="receiver-text" dir="auto" tabindex="0" data-i18n-aria-label="stepThree"></pre></div>
<p id="cancelled" class="hint" data-i18n="cancelledAuto" hidden></p>
<div class="actions">
<button id="open" class="button accent" data-i18n="open" hidden></button>
<button id="copy" class="button secondary" hidden>${icon('copy')}<span data-i18n="copy"></span></button>
<button id="clear" class="text-button" data-i18n="clear" hidden></button>
</div>
</section>
${marketing()}
<dialog id="receiver-help-dialog" class="help-dialog" aria-labelledby="receiver-help-title">
<h2 id="receiver-help-title" data-i18n="helpTitle"></h2>
<ol class="help-steps">
${['Connect', 'Scan', 'Send'].map((step) => `<li><h3 data-i18n="help${step}Title"></h3><p data-i18n="help${step}Body"></p></li>`).join('')}
</ol>
<p class="hint" data-i18n="helpResult"></p>
<p class="hint" data-i18n="helpTerminal"></p>
<pre class="help-command"><code id="help-cli-command"></code></pre>
<form method="dialog" class="actions"><button class="button secondary" data-i18n="helpClose" autofocus></button></form>
</dialog>
</main>`;
  const senderPage = `
<main class="sender-main">
<section class="sender-stage" aria-labelledby="sender-instruction">
<h1 id="sender-instruction" data-i18n="senderPrompt"></h1>
<p id="error" class="notice error" role="alert" hidden></p>
<div id="camera" class="camera" hidden>
<video id="video" muted autoplay playsinline></video>
<div class="camera-reticle" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
</div>
<div id="zoom-control" class="zoom-control" hidden>
<label for="zoom" data-i18n="zoom"></label>
<input id="zoom" type="range" min="1" max="1" step="0.1" value="1">
<output id="zoom-value" for="zoom"></output>
</div>
<input id="photo-input" type="file" accept="image/*" hidden>
<p id="photo-error" class="notice" role="alert" hidden></p>
<div id="sender-preview" class="preview" hidden>
<pre id="sender-text" dir="auto" tabindex="0" data-i18n-aria-label="preview"></pre>
</div>
<p id="copy-feedback" role="status" class="copy-feedback"></p>
<div class="actions sender-actions">
<button id="send" class="button accent" data-i18n="sendShort" hidden></button>
<button id="scan" class="button secondary" data-i18n="scanAgain" hidden></button>
<button id="photo" class="button secondary" data-i18n="photo"></button>
<button id="copy" class="button secondary" hidden>${icon('copy')}<span data-i18n="copy"></span></button>
<button id="camera-retry" class="button secondary" data-i18n="cameraRetry" hidden></button>
<button id="retry" class="button secondary" data-i18n="retry" hidden></button>
</div>
</section>
${marketing()}
</main>`;
  root.innerHTML = `<div class="shell">${header(paths, sender)}${sender ? senderPage : receiver}${footer()}</div>`;
  if (!sender) {
    const origin = __PUBLIC_ORIGIN__ || window.location.origin;
    el('help-cli-command').textContent = `curl -fsSL ${new URL('/run.sh', origin).href} | sh`;
  }
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
  const statusNode = document.getElementById('status');
  if (statusNode) statusNode.textContent = text(status);
  const statusIcon = document.getElementById('status-icon');
  if (statusIcon)
    statusIcon.innerHTML = icon(
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
