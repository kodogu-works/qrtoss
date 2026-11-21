import { errorText, languageLabels, translate, type Key, type Language } from './i18n.ts';
import type { AppPaths } from './paths.ts';

export type SharedPageRole = 'controller' | 'member';

const escapeAttribute = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export function sharedElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing shared element: ${id}`);
  return value as T;
}

function languageSelector(): string {
  return `<label class="language"><span class="sr-only" data-i18n="language"></span>
<select id="shared-language" data-shared-language>${Object.entries(languageLabels)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('')}</select></label>`;
}

function sharedComposer(): string {
  return `<section id="shared-composer" class="card shared-composer" aria-labelledby="shared-compose-title" hidden>
<h2 id="shared-compose-title" data-i18n="sharedCompose"></h2>
<label class="field"><span data-i18n="sharedTextLabel"></span>
<textarea id="shared-text-input" maxlength="16384" rows="4"></textarea></label>
<div class="actions"><button id="shared-send-text" class="button accent" data-i18n="sharedSendText"></button></div>
<div id="shared-drop-zone" class="drop-zone" tabindex="0" data-i18n="sharedDropFiles"></div>
<input id="shared-file-input" type="file" multiple hidden>
<div class="actions"><button id="shared-choose-files" class="button secondary" data-i18n="sharedChooseFiles"></button>
<button id="shared-send-files" class="button accent" data-i18n="sharedSendFiles" hidden></button></div>
<ul id="shared-selected-files" class="plain-list"></ul>
<h3 data-i18n="sharedSentItems"></h3><ul id="shared-deliveries" class="plain-list" aria-live="polite"></ul>
</section>
<section id="shared-received" class="card" aria-labelledby="shared-received-title" hidden>
<h2 id="shared-received-title" data-i18n="sharedReceivedItems"></h2>
<p id="shared-empty" class="hint" data-i18n="sharedNothingReceived"></p>
<ul id="shared-received-list" class="plain-list" aria-live="polite"></ul>
</section>`;
}

function memberList(): string {
  return `<ul id="shared-member-list" class="plain-list member-list" aria-live="polite"></ul>`;
}

export function mountSharedPage(role: SharedPageRole, paths: AppPaths): void {
  const root = document.querySelector<HTMLDivElement>('#app')!;
  const receiver = `<section class="pairing-stage" aria-labelledby="shared-pairing-title">
<h1 id="shared-pairing-title" data-i18n="receiverPrompt"></h1>
<div id="shared-qr-wrap" class="qr-wrap"><div class="qr-frame"><canvas id="shared-qr" role="img" data-i18n-aria-label="connectionQR"></canvas>
<div id="shared-qr-loading" class="qr-loading" data-i18n="creating"></div></div>
<p id="shared-expiry" class="expiry"></p>
<div class="actions"><button id="shared-new-qr" class="button secondary" data-i18n="newQR"></button></div></div>
</section>
<fieldset id="shared-receive-mode" class="card mode-choice"><legend data-i18n="receiveBehavior"></legend>
<label><input type="radio" name="shared-mode" value="auto_open" checked> <span data-i18n="auto"></span></label>
<label><input type="radio" name="shared-mode" value="display_only"> <span data-i18n="display"></span></label>
<p class="hint" data-i18n="receiveModeHelp"></p></fieldset>
<section id="shared-qr-result" class="card" hidden><h2 data-i18n="stepThree"></h2>
<pre id="shared-qr-result-text" class="received-text" dir="auto"></pre>
<p id="shared-qr-unsaved-warning" class="hint" data-i18n="sharedUnsavedWarning" hidden></p>
<div class="actions"><button id="shared-open-qr" class="button accent" data-i18n="open" hidden></button>
<button id="shared-copy-qr" class="button secondary" data-i18n="copy"></button>
<button id="shared-clear-qr" class="text-button" data-i18n="clear"></button></div></section>
<section id="shared-confirm" class="card verification" hidden>
<h2 data-i18n="sharedConfirmTitle"></h2><p data-i18n="sharedConfirmHelp"></p>
<p id="shared-confirm-members"></p>
<output id="shared-confirm-code" class="verification-code"></output>
<div class="actions"><button id="shared-accept" class="button accent" data-i18n="sharedJoin"></button>
<button id="shared-reject" class="button secondary" data-i18n="sharedReject"></button></div></section>`;
  const controller = `<section class="controller-scanner card" aria-labelledby="shared-controller-title">
<h1 id="shared-controller-title" data-i18n="sharedControllerTitle"></h1>
<p class="notice" data-i18n="sharedControllerWarning"></p>
<div id="shared-camera" class="camera" hidden><video id="shared-video" muted autoplay playsinline></video>
<div class="camera-reticle" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>
<input id="shared-photo-input" type="file" accept="image/*" hidden>
<div id="shared-qr-preview" class="preview" hidden><pre id="shared-qr-text" dir="auto"></pre></div>
<div class="actions"><button id="shared-scan" class="button secondary" data-i18n="scanAgain"></button>
<button id="shared-photo" class="button secondary" data-i18n="photo"></button>
<button id="shared-send-qr" class="button accent" data-i18n="sendShort" hidden></button></div>
</section>`;
  const management = `<section id="shared-network" class="card network-card" hidden>
<div class="card-heading"><h2 data-i18n="sharedNetwork"></h2><span id="shared-network-state" role="status"></span></div>
<dl class="network-summary"><div><dt data-i18n="sharedVerificationCode"></dt><dd id="shared-code" class="verification-code"></dd></div>
<div><dt data-i18n="sharedQRTarget"></dt><dd id="shared-target"></dd></div></dl>
<h3 data-i18n="sharedMembers"></h3>${memberList()}
<div id="shared-controller-actions" class="actions" ${role === 'controller' ? '' : 'hidden'}>
<button id="shared-toggle-participation" class="button secondary" data-i18n="sharedJoinSelf"></button>
<button id="shared-toggle-admissions" class="button secondary" data-i18n="sharedStopAdmissions"></button>
<button id="shared-end-network" class="text-button danger" data-i18n="sharedEndNetwork"></button></div>
<div id="shared-member-actions" class="actions" ${role === 'member' ? '' : 'hidden'}>
<button id="shared-leave" class="text-button danger" data-i18n="sharedLeave"></button></div>
</section>`;
  root.innerHTML = `<div class="shell shared-shell"><header class="topbar"><a class="wordmark" href="${escapeAttribute(paths.home)}">qrtoss.</a>
<div class="header-actions"><a class="github-link" href="https://github.com/kodogu-works/qrtoss" target="_blank" rel="noopener noreferrer">GitHub</a>${languageSelector()}</div></header>
<main class="shared-main" data-shared-role="${role}"><p id="shared-error" class="notice error" role="alert" hidden></p>
<p id="shared-status" class="connection-status" role="status" aria-live="polite"></p>
${role === 'member' ? receiver : controller}${management}${sharedComposer()}</main>
<footer><span>qrtoss / <span id="shared-version"></span></span><span data-i18n="license"></span></footer></div>`;
}

export function renderSharedLanguage(language: Language, errorCode = ''): void {
  document.documentElement.lang = language;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    node.textContent = translate(language, node.dataset.i18n as Key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', translate(language, node.dataset.i18nAriaLabel as Key));
  });
  const selector = document.querySelector<HTMLSelectElement>('[data-shared-language]');
  if (selector) selector.value = language;
  const error = document.getElementById('shared-error');
  if (error) {
    error.hidden = !errorCode;
    error.textContent = errorCode ? errorText(language, errorCode) : '';
  }
}

export function setSharedStatus(language: Language, key: Key): void {
  sharedElement('shared-status').textContent = translate(language, key);
}

export type SharedMemberView = {
  memberId: string;
  label: string;
  state: string;
  target?: boolean;
  self?: boolean;
};

export function renderSharedMembers(
  language: Language,
  members: readonly SharedMemberView[],
  canManage: boolean,
  onKick?: (memberId: string) => void,
  onTarget?: (memberId: string) => void,
): void {
  const list = sharedElement<HTMLUListElement>('shared-member-list');
  list.replaceChildren();
  for (const member of members) {
    const item = document.createElement('li');
    item.className = 'member-row';
    const description = document.createElement('span');
    description.className = 'member-description';
    const name = document.createElement('strong');
    name.textContent = member.label;
    const state = document.createElement('small');
    state.textContent = member.state;
    description.append(name, state);
    item.append(description);
    if (member.target) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = translate(language, 'sharedCurrentTarget');
      item.append(badge);
    }
    if (canManage && !member.self) {
      const actions = document.createElement('span');
      actions.className = 'inline-actions';
      if (onTarget && !member.target) {
        const target = document.createElement('button');
        target.className = 'text-button';
        target.textContent = translate(language, 'sharedSetTarget');
        target.addEventListener('click', () => onTarget(member.memberId));
        actions.append(target);
      }
      if (onKick) {
        const kick = document.createElement('button');
        kick.className = 'text-button danger';
        kick.textContent = translate(language, 'sharedKick');
        kick.addEventListener('click', () => onKick(member.memberId));
        actions.append(kick);
      }
      item.append(actions);
    }
    list.append(item);
  }
}
