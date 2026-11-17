import { chooseLanguage, errorText, translate, type Key, type Language } from './i18n';
import type { AppPaths } from './paths';
import type { Phase } from './session';

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
<a class="wordmark" href="${paths.home}" aria-label="qrtoss home">
<span class="brand-symbol" aria-hidden="true">↗</span>qrtoss<span class="brand-dot">.</span>
</a>
<label class="language">
<span class="sr-only" data-i18n="language">
</span>
<select id="language" aria-label="Language">
<option value="en">English</option>
<option value="ja">日本語</option>
<option value="es">Español</option>
</select>
</label>
</header>
<main>
<div class="eyebrow">
<span class="little-line">
</span>
<span data-i18n="about">
</span>
</div>
<h1 data-i18n="${sender ? 'sendTitle' : 'receive'}">
</h1>
<p class="intro" data-i18n="${sender ? 'senderIntro' : 'receiverIntro'}">
</p>
<div class="workspace">
<section class="card primary-card">
<div class="card-heading">
<span class="step">01</span>
<h2 data-i18n="${sender ? 'preview' : 'stepOne'}">
</h2>
<span class="connection-icon" aria-hidden="true">⌁</span>
</div>
<div class="connection-status" role="status" aria-live="polite">
<span id="status-dot" class="status-dot">
</span>
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
<span aria-hidden="true">▧</span>
<p data-i18n="cameraHelp">
</p>
</div>
<div id="sender-preview" class="preview" hidden>
<p id="domain" class="domain">
</p>
<pre id="sender-text" dir="auto" tabindex="0">
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
<button id="copy" class="button secondary" data-i18n="copy" hidden>
</button>
</div>
<p id="cli-done" class="hint" data-i18n="cliDone" hidden>
</p>`
    : `<div id="qr-wrap" class="qr-wrap">
<div class="qr-frame">
<canvas id="qr" aria-label="Connection QR code" role="img">
</canvas>
<div id="qr-loading" class="qr-loading" aria-hidden="true">
<span>
</span>
</div>
</div>
<div id="expiry" class="expiry">
</div>
</div>
<div id="connected-art" class="connected-art" hidden aria-hidden="true">
<span>✓</span>
<i>
</i>
<span>✓</span>
</div>
<p id="qr-help" class="qr-help" data-i18n="qrHelp">
</p>
<p id="secret-hint" class="secret-hint" data-i18n="qrSecret">
</p>
<button id="new-qr" class="button secondary wide" data-i18n="newQR">
</button>`
}
</section>
${
  sender
    ? ''
    : `<div class="side-column">
<section class="card mode-card">
<div class="card-heading">
<span class="step">02</span>
<h2 data-i18n="stepTwo">
</h2>
</div>
<fieldset id="modes">
<legend class="sr-only" data-i18n="stepTwo">
</legend>
<label class="mode-choice">
<input type="radio" name="mode" value="auto_open" checked>
<span>
<strong data-i18n="auto">
</strong>
<small data-i18n="navigationHelp">
</small>
</span>
</label>
<label class="mode-choice">
<input type="radio" name="mode" value="display_only">
<span>
<strong data-i18n="display">
</strong>
<small data-i18n="modeHelp">
</small>
</span>
</label>
</fieldset>
</section>
<section class="card result-card">
<div class="card-heading">
<span class="step">03</span>
<h2 data-i18n="stepThree">
</h2>
</div>
<p id="empty" class="empty" data-i18n="empty">
</p>
<div id="receiver-preview" class="preview" hidden>
<pre id="receiver-text" dir="auto" tabindex="0">
</pre>
</div>
<p id="cancelled" class="hint" data-i18n="cancelledAuto" hidden>
</p>
<div class="actions">
<button id="open" class="button accent" hidden>
</button>
<button id="copy" class="button secondary" data-i18n="copy" hidden>
</button>
<button id="clear" class="text-button" data-i18n="clear" hidden>
</button>
</div>
</section>
</div>`
}
</div>
<p id="copy-feedback" role="status" class="copy-feedback">
</p>
<div class="trust-row">
<span>
<i aria-hidden="true">◇</i>
<span data-i18n="private">
</span>
</span>
<span>
<i aria-hidden="true">○</i>
<span data-i18n="noAccount">
</span>
</span>
<span>
<i aria-hidden="true">↝</i>
<span data-i18n="noHistory">
</span>
</span>
</div>
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
  el<HTMLSelectElement>('language').value = language;
  el('status').textContent = text(status);
  el('status-dot').className = `status-dot ${phase === 'connected' ? 'online' : ''}`;
  el('error').hidden = !errorCode;
  el('error').textContent = errorCode ? errorText(language, errorCode) : '';
  el('copy').hidden = !hasPreview;
  el('copy-feedback').textContent = copied ? text('copied') : manualCopy ? text('manualCopy') : '';
}
