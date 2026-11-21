import { translate, type Language } from './i18n.ts';
import type { SharedContentSession } from './shared-content.ts';
import { validateFiles, type DeliveryTracker, type ReceivedItem } from './shared-store.ts';
import { sharedElement } from './shared-view.ts';

export class SharedContentView {
  private selected: File[] = [];
  private content?: SharedContentSession;
  constructor(
    private readonly language: () => Language,
    private readonly error: (code: string) => void,
  ) {
    sharedElement('shared-send-text').addEventListener('click', () => void this.sendText());
    sharedElement('shared-choose-files').addEventListener('click', () =>
      sharedElement<HTMLInputElement>('shared-file-input').click(),
    );
    sharedElement('shared-send-files').addEventListener('click', () => void this.sendFiles());
    sharedElement('shared-file-input').addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      this.choose([...(input.files ?? [])]);
      input.value = '';
    });
    const drop = sharedElement('shared-drop-zone');
    for (const event of ['dragenter', 'dragover'])
      drop.addEventListener(event, (value) => {
        value.preventDefault();
        drop.classList.add('is-dragging');
      });
    for (const event of ['dragleave', 'drop'])
      drop.addEventListener(event, (value) => {
        value.preventDefault();
        drop.classList.remove('is-dragging');
      });
    drop.addEventListener('drop', (event) => this.choose([...(event.dataTransfer?.files ?? [])]));
    drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        sharedElement<HTMLInputElement>('shared-file-input').click();
      }
    });
  }
  attach(content?: SharedContentSession): void {
    this.content = content;
    if (!content) {
      this.selected = [];
      sharedElement<HTMLInputElement>('shared-file-input').value = '';
      this.renderSelected();
    }
    sharedElement('shared-composer').hidden = !content;
    sharedElement('shared-received').hidden = !content;
    this.renderReceived(content?.store.items ?? []);
  }
  private choose(files: File[]): void {
    try {
      validateFiles(files);
      this.selected = files;
      this.error('');
    } catch (error) {
      this.selected = [];
      this.error(error instanceof Error ? error.message : 'CONTENT_INVALID');
    }
    this.renderSelected();
  }
  private renderSelected(): void {
    const list = sharedElement<HTMLUListElement>('shared-selected-files');
    list.replaceChildren();
    for (const file of this.selected) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = file.name;
      const size = document.createElement('small');
      size.textContent = ` (${file.size.toLocaleString()} B)`;
      item.append(name, size);
      list.append(item);
    }
    sharedElement('shared-send-files').hidden = !this.selected.length;
  }
  private async sendText(): Promise<void> {
    const input = sharedElement<HTMLTextAreaElement>('shared-text-input');
    if (!this.content) return;
    try {
      const tracker = await this.content.sendText(input.value);
      input.value = '';
      this.renderDelivery(tracker);
      this.error('');
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'CONTENT_INVALID');
    }
  }
  private async sendFiles(): Promise<void> {
    if (!this.content || !this.selected.length) return;
    const files = this.selected;
    this.selected = [];
    this.renderSelected();
    try {
      for (const tracker of await this.content.sendFiles(files)) this.renderDelivery(tracker);
      this.error('');
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'CONTENT_INVALID');
    }
  }
  renderReceived(items: readonly ReceivedItem[]): void {
    const list = sharedElement<HTMLUListElement>('shared-received-list');
    list.replaceChildren();
    sharedElement('shared-empty').hidden = items.length > 0;
    for (const received of items) {
      const item = document.createElement('li');
      const heading = document.createElement('div');
      heading.className = 'received-item-heading';
      const title = document.createElement('strong');
      title.textContent =
        received.kind === 'file'
          ? received.name
          : new Date(received.receivedAt).toLocaleTimeString();
      const actions = document.createElement('span');
      actions.className = 'inline-actions';
      if (received.kind === 'file') {
        const save = document.createElement('button');
        save.className = 'button secondary';
        save.textContent = translate(this.language(), 'sharedSave');
        save.addEventListener('click', () => this.save(received.id));
        actions.append(save);
      }
      const remove = document.createElement('button');
      remove.className = 'text-button danger';
      remove.textContent = translate(this.language(), 'sharedDelete');
      remove.addEventListener('click', () => this.content?.remove(received.id));
      actions.append(remove);
      heading.append(title, actions);
      item.append(heading);
      if (received.kind === 'text') {
        const text = document.createElement('p');
        text.className = 'received-text';
        text.dir = 'auto';
        text.textContent = received.text;
        item.append(text);
      } else {
        const detail = document.createElement('small');
        detail.textContent = `${received.bytes.toLocaleString()} B · ${received.mime || 'application/octet-stream'}`;
        item.append(detail);
      }
      list.append(item);
    }
  }
  private save(id: string): void {
    const value = this.content?.save(id);
    if (!value) return;
    const url = URL.createObjectURL(value.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = value.name;
    anchor.rel = 'noopener';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  renderDelivery(tracker: DeliveryTracker): void {
    const list = sharedElement<HTMLUListElement>('shared-deliveries');
    let item = document.getElementById(`delivery-${tracker.id}`) as HTMLLIElement | null;
    if (!item) {
      item = document.createElement('li');
      item.id = `delivery-${tracker.id}`;
      list.prepend(item);
    }
    item.replaceChildren();
    while (list.children.length > 64) list.lastElementChild?.remove();
    const heading = document.createElement('div');
    heading.className = 'delivery-heading';
    const title = document.createElement('strong');
    const canceled = [...tracker.recipients.values()].every(
      (recipient) => recipient.status === 'CANCELED',
    );
    title.textContent = canceled
      ? translate(this.language(), 'sharedCanceled')
      : tracker.complete
        ? translate(this.language(), 'sharedComplete')
        : tracker.settled
          ? translate(this.language(), 'sharedPartial')
          : translate(this.language(), 'sending');
    heading.append(title);
    if (this.content?.canCancel(tracker.id)) {
      const cancel = document.createElement('button');
      cancel.className = 'text-button danger';
      cancel.textContent = translate(this.language(), 'sharedCancel');
      cancel.addEventListener('click', () => {
        this.content?.cancel(tracker.id);
        this.renderDelivery(tracker);
      });
      heading.append(cancel);
    }
    item.append(heading);
    const recipients = document.createElement('ul');
    recipients.className = 'plain-list';
    for (const value of tracker.recipients.values()) {
      const recipient = document.createElement('li');
      recipient.textContent = `${value.memberId}: ${value.status}${value.upTo ? ` (${value.upTo})` : ''}${value.code ? ` — ${value.code}` : ''}`;
      recipients.append(recipient);
    }
    item.append(recipients);
  }
}
