/**
 * The setup wizard — link, choose your folders, review, go live.
 *
 * Language rule for every string in this file: user words, not protocol
 * words. "What colleagues see", never "manifest"; "link", never "DID";
 * "other people's words", never "capture layer". The protocol names stay in
 * code and in .vantell.yml, where they belong.
 */
import { Modal, Notice, Setting, type App } from 'obsidian';
import {
  cloneConfig,
  loadVaultConfig,
  pathMatches,
  saveVaultConfig,
  withDefaultVisibility,
  withoutDefaultVisibility,
  SHAREABLE_VIS,
  type ShareVisibility,
  type VaultConfig,
} from '@vantell/vaultscan-core';
import { ApiError, claimPairingCode } from './api';
import { loadOrCreateIdentity, saveIdentity, type StoredIdentity } from './identity';
import { makeObsidianProvider, topLevelFolders } from './provider';
import { publishScan, scanVault, summarize, type VaultScanContext } from './publish';
import type VantellPlugin from './main';

type Step = 'link' | 'folders' | 'review' | 'done';

interface FolderChoice {
  name: string;
  count: number;
  /** Fully covered by a protective rule — shown, never pickable. */
  protectedWhy: string | null;
  picked: boolean;
  audience: ShareVisibility;
}

const CONNECT_URL = 'https://app.vantell.ai/connect?from=plugin';
const SIGNUP_URL = 'https://app.vantell.ai/auth/signup?from=plugin';

/** Plain-language reason a folder is auto-protected, from the config rule
 * kind that covers it — probed with a representative path. */
function protectedReason(name: string, cfg: VaultConfig): string | null {
  if (name === '(root)') return null;
  const probe = `${name}/__probe__.md`;
  if (pathMatches(probe, cfg.capture_paths ?? [])) {
    return "Looks like other people's words (emails, chats, meetings) — stays private automatically.";
  }
  if (pathMatches(probe, cfg.person_paths ?? [])) {
    return 'Looks like notes about people — stays private automatically.';
  }
  if (pathMatches(probe, cfg.exclude_paths ?? [])) {
    return 'On your private list — never scanned for sharing.';
  }
  return null;
}

/** The `<folder>/**` default rule's audience, when one exists and is valid. */
function existingAudience(cfg: VaultConfig, folder: string): ShareVisibility | null {
  const rule = cfg.default_visibility?.[`${folder}/**`];
  return rule && SHAREABLE_VIS.includes(rule.visibility)
    ? (rule.visibility as ShareVisibility)
    : null;
}

export class SetupWizard extends Modal {
  private step: Step;
  private identity: StoredIdentity | null = null;
  private choices: FolderChoice[] = [];
  private cfg: VaultConfig | null = null;
  private scanCtx: VaultScanContext | null = null;
  private busy = false;

  constructor(
    app: App,
    private plugin: VantellPlugin,
    startAt: Step | null = null,
  ) {
    super(app);
    this.step = startAt ?? 'link';
  }

  override async onOpen(): Promise<void> {
    this.modalEl.addClass('vantell-wizard');
    this.identity = await loadOrCreateIdentity(this.app);
    if (this.step === 'link' && this.identity.did) this.step = 'folders';
    await this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /* ------------------------------------------------------------ rendering */

  private async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    switch (this.step) {
      case 'link':
        this.renderLink(el);
        break;
      case 'folders':
        await this.renderFolders(el);
        break;
      case 'review':
        await this.renderReview(el);
        break;
      case 'done':
        this.renderDone(el);
        break;
    }
  }

  private heading(el: HTMLElement, title: string, sub?: string): void {
    el.createEl('h2', { text: title });
    if (sub) el.createEl('p', { text: sub, cls: 'vantell-sub' });
  }

  /* ---------------------------------------------------------------- link */

  private renderLink(el: HTMLElement): void {
    this.heading(
      el,
      'Link your Vantell account',
      'One code connects this vault to your account. Your notes are never uploaded — ' +
        'only topic labels and counts from folders you choose, and only after you review them.',
    );

    let code = '';
    new Setting(el)
      .setName('Your code')
      .setDesc('From app.vantell.ai — 8 characters, valid for 60 minutes.')
      .addText((t) => {
        t.setPlaceholder('e.g. K7RMXWPA').onChange((v) => (code = v));
        t.inputEl.autocapitalize = 'characters';
        t.inputEl.addClass('vantell-code-input');
      })
      .addButton((b) =>
        b
          .setButtonText('Link')
          .setCta()
          .onClick(() => void this.claim(code)),
      );

    const links = el.createEl('p', { cls: 'vantell-sub' });
    links.appendText('Need a code? ');
    links.createEl('a', { text: 'Get one from your account', href: CONNECT_URL });
    links.appendText(' · New to Vantell? ');
    links.createEl('a', { text: 'Create a free account', href: SIGNUP_URL });

    el.createEl('p', {
      cls: 'vantell-fineprint',
      text:
        'Linking stores a signing key on this device only — it is never synced and never ' +
        'leaves this device. No password is ever entered here.',
    });
  }

  private async claim(code: string): Promise<void> {
    if (this.busy) return;
    const trimmed = code.trim();
    if (trimmed.length < 6) {
      new Notice('That looks too short — codes have 8 characters.');
      return;
    }
    this.busy = true;
    try {
      const ident = this.identity ?? (await loadOrCreateIdentity(this.app));
      const { did, api, server_pubkey } = await claimPairingCode(
        this.plugin.device.apiBase,
        trimmed,
        ident.pubkey,
      );
      // SEC-3: the pairing response chooses where this device talks next —
      // constrain it. Plain-HTTP endpoints are never accepted.
      if (!api.startsWith('https://')) {
        throw new ApiError(`The server proposed a non-HTTPS endpoint (${api}) — refusing.`, 0);
      }
      this.identity = { ...ident, did, api, server_pubkey };
      saveIdentity(this.app, this.identity);
      new Notice('Linked. This vault now has its own signed identity.');
      this.step = 'folders';
      await this.render();
    } catch (err) {
      new Notice(err instanceof ApiError ? err.message : 'Linking failed — please try again.');
    } finally {
      this.busy = false;
    }
  }

  /* -------------------------------------------------------------- folders */

  private async renderFolders(el: HTMLElement): Promise<void> {
    this.heading(
      el,
      'Choose your folders',
      'Nothing leaves Obsidian unless you choose it. Pick the folders you are happy to ' +
        'share from — everything else stays private, including its folder name.',
    );

    if (this.choices.length === 0) {
      const fp = makeObsidianProvider(this.app);
      const { cfg } = await loadVaultConfig(fp);
      this.cfg = cfg;
      this.choices = topLevelFolders(this.app).map(({ name, count }) => {
        const audience = name === '(root)' ? null : existingAudience(cfg, name);
        return {
          name,
          count,
          protectedWhy: protectedReason(name, cfg),
          picked: audience !== null,
          audience: audience ?? 'org',
        };
      });
    }

    const list = el.createDiv({ cls: 'vantell-folder-list' });
    for (const choice of this.choices) {
      const isRoot = choice.name === '(root)';
      const row = new Setting(list)
        .setName(isRoot ? 'Notes outside any folder' : choice.name)
        .setDesc(
          choice.protectedWhy ??
            (isRoot
              ? `${choice.count} note${choice.count === 1 ? '' : 's'} — share these one by one with “Share this note”.`
              : `${choice.count} note${choice.count === 1 ? '' : 's'}`),
        );
      if (choice.protectedWhy || isRoot) {
        row.setDisabled(true);
        continue;
      }
      row.addDropdown((d) => {
        d.addOption('org', 'Whole org')
          .addOption('team', 'My team')
          .setValue(choice.audience)
          .onChange((v) => (choice.audience = v === 'team' ? 'team' : 'org'));
        d.selectEl.toggleClass('vantell-hidden', !choice.picked);
      });
      row.addToggle((t) =>
        t.setValue(choice.picked).onChange((v) => {
          choice.picked = v;
          const dd = row.settingEl.querySelector('select');
          if (dd) dd.classList.toggle('vantell-hidden', !v);
        }),
      );
    }

    el.createEl('p', {
      cls: 'vantell-fineprint',
      text:
        'A safety check still runs inside chosen folders: notes that look like other ' +
        "people's words (emails, transcripts) or notes about people stay private " +
        'automatically, no matter what.',
    });

    new Setting(el)
      .addButton((b) =>
        b
          .setButtonText('Continue — see exactly what colleagues would see')
          .setCta()
          .onClick(() => void this.applyFoldersAndScan()),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  private async applyFoldersAndScan(): Promise<void> {
    if (this.busy || !this.cfg) return;
    this.busy = true;
    const notice = new Notice('Checking your vault — everything stays on this device…', 0);
    try {
      let next = cloneConfig(this.cfg);
      next.report_scope = 'selected';
      for (const c of this.choices) {
        if (c.name === '(root)' || c.protectedWhy) continue;
        next = c.picked
          ? withDefaultVisibility(next, c.name, c.audience)
          : withoutDefaultVisibility(next, c.name);
      }
      const fp = makeObsidianProvider(this.app);
      await saveVaultConfig(fp, next);
      this.cfg = next;
      this.scanCtx = await scanVault(this.app);
      this.step = 'review';
      await this.render();
    } catch (err) {
      new Notice(err instanceof Error ? err.message : 'The check failed — please try again.');
    } finally {
      notice.hide();
      this.busy = false;
    }
  }

  /* --------------------------------------------------------------- review */

  private async renderReview(el: HTMLElement): Promise<void> {
    if (!this.scanCtx) {
      this.scanCtx = await scanVault(this.app);
      this.cfg = this.scanCtx.cfg;
    }
    const s = summarize(this.scanCtx.result);

    this.heading(el, 'Review — exactly this, nothing else', 'What you see here is all there is.');

    const card = el.createDiv({ cls: 'vantell-review-card' });
    card.createEl('h3', { text: 'Colleagues will see' });
    if (s.topics.length === 0) {
      card.createEl('p', {
        text:
          'Nothing yet — no topics. You can go live anyway (colleagues just can\'t ' +
          'discover you by topic yet), or go back and pick a folder to share from.',
      });
    } else {
      const ul = card.createEl('ul');
      for (const t of s.topics.slice(0, 12)) {
        ul.createEl('li', {
          text: `${t.label} — ${t.notes.toLocaleString()} note${t.notes === 1 ? '' : 's'}`,
        });
      }
      if (s.topics.length > 12) {
        card.createEl('p', { text: `…and ${s.topics.length - 12} more topics.` });
      }
      card.createEl('p', {
        cls: 'vantell-fineprint',
        text: 'Topic labels and counts only — never note contents.',
      });
    }

    card.createEl('h3', { text: 'Your dashboard will show' });
    const dash = card.createEl('ul');
    for (const f of s.namedFolders) {
      const li = dash.createEl('li', {
        text: `${f.name}/ — ${f.notes.toLocaleString()} note${f.notes === 1 ? '' : 's'}`,
      });
      if (f.sampleTitles.length > 0) {
        li.createDiv({
          cls: 'vantell-fineprint',
          text: `sample titles sent: ${f.sampleTitles.map((t) => `“${t}”`).join(' · ')}`,
        });
      }
    }
    if (s.unchosenNotes > 0) {
      dash.createEl('li', {
        text: `Everything you didn't choose — ${s.unchosenNotes.toLocaleString()} notes. Stays here: no folder names, no titles, only that total.`,
      });
    }
    if (s.protectedInChosen > 0) {
      card.createEl('p', {
        cls: 'vantell-fineprint',
        text: `Safety net: inside your chosen folders, ${s.protectedInChosen.toLocaleString()} note${s.protectedInChosen === 1 ? ' looks' : 's look'} like other people's words, notes about people, or matched your privacy rules — those stay private automatically.`,
      });
    }

    if (s.warnings.length > 0) {
      const det = el.createEl('details');
      det.createEl('summary', { text: `Notes from the safety check (${s.warnings.length})` });
      const ul = det.createEl('ul', { cls: 'vantell-warnings' });
      for (const w of s.warnings.slice(0, 50)) ul.createEl('li', { text: w });
    }

    const payloadDet = el.createEl('details');
    payloadDet.createEl('summary', { text: 'Show exactly what will be sent (technical)' });
    payloadDet.createEl('pre', {
      text: JSON.stringify(
        {
          topics: this.scanCtx.result.transmitSafe.topics,
          stats: this.scanCtx.result.transmitSafe.stats,
          folders: this.scanCtx.result.transmitSafe.folders,
        },
        null,
        2,
      ),
    });

    let name = this.plugin.data.displayName;
    new Setting(el)
      .setName('Your name on the mesh')
      .setDesc('How colleagues see you — usually just your name.')
      .addText((t) => t.setValue(name).onChange((v) => (name = v)));

    new Setting(el)
      .addButton((b) =>
        b
          .setButtonText('Go live')
          .setCta()
          .onClick(() => void this.goLive(name)),
      )
      .addButton((b) =>
        b.setButtonText('Back to folders').onClick(async () => {
          this.step = 'folders';
          this.choices = [];
          await this.render();
        }),
      );
  }

  private async goLive(displayName: string): Promise<void> {
    if (this.busy || !this.scanCtx) return;
    const name = displayName.trim();
    if (!name) {
      new Notice('Add your name first — colleagues need to know who they found.');
      return;
    }
    if (!this.identity?.did) {
      new Notice('This device is not linked yet.');
      this.step = 'link';
      await this.render();
      return;
    }
    this.busy = true;
    try {
      const { record } = await publishScan(
        this.scanCtx.result,
        this.identity,
        this.plugin.device.apiBase,
        name,
      );
      this.plugin.data.displayName = name;
      this.plugin.data.lastPublished = record;
      await this.plugin.saveData(this.plugin.data);
      this.plugin.refreshStatusBar();
      this.step = 'done';
      await this.render();
    } catch (err) {
      new Notice(err instanceof Error ? err.message : 'Going live failed — please try again.');
    } finally {
      this.busy = false;
    }
  }

  /* ----------------------------------------------------------------- done */

  private renderDone(el: HTMLElement): void {
    const topics = this.plugin.data.lastPublished?.topics.length ?? 0;
    this.heading(
      el,
      'You are live.',
      topics > 0
        ? `Colleagues can now find you by ${topics} topic${topics === 1 ? '' : 's'}. Everything else stayed here.`
        : 'You are on the mesh. Pick folders or share single notes any time to become discoverable by topic.',
    );
    el.createEl('p', {
      text:
        'To adjust: run “Vantell: Choose your folders” any time, or use ' +
        '“Share this note” / “Stop sharing this note” on any single note.',
    });
    const row = new Setting(el);
    row.addButton((b) =>
      b
        .setButtonText('See your dashboard')
        .setCta()
        .onClick(() => window.open('https://app.vantell.ai/', '_blank')),
    );
    row.addButton((b) => b.setButtonText('Close').onClick(() => this.close()));
  }
}
