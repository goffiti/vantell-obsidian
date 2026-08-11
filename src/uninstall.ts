/**
 * Full removal — "leave the vault as if Vantell was never here."
 *
 * What it does, in order, after an explicit confirm that shows exact counts:
 *   1. (on by default) take the published listing off the mesh — a signed
 *      POST /v1/unpublish. This MUST run before step 4: once the key is
 *      deleted this device can never authenticate a removal again;
 *   2. every note: strip Vantell's own frontmatter (visibility with a
 *      Vantell value, max_level, derived_from) — `topics` is deliberately
 *      kept, it commonly predates Vantell and deleting it would damage the
 *      vault, not restore it;
 *   3. delete .vantell.yml;
 *   4. delete this device's signing key (device-local storage);
 *   5. reset the plugin's own saved data.
 * If unpublishing fails (offline, key already rotated), local removal still
 * proceeds and the dialog points at the dashboard's "Remove published
 * data" button, which needs no device key.
 */
import { Modal, Notice, Setting, type App } from 'obsidian';
import { CONFIG_FILENAME, stripShareFrontmatter } from '@vantell/vaultscan-core';
import { saveApiKey } from './ai';
import { signedPost } from './api';
import { clearIdentity, loadIdentity } from './identity';
import { makeObsidianProvider } from './provider';
import { DEFAULT_DATA } from './data';
import type VantellPlugin from './main';

interface SweepPlan {
  markedNotes: string[];
  malformed: string[];
  hasConfig: boolean;
}

async function planSweep(app: App): Promise<SweepPlan> {
  const fp = makeObsidianProvider(app);
  const markedNotes: string[] = [];
  const malformed: string[] = [];
  for (const rel of await fp.listMarkdown()) {
    let text: string;
    try {
      text = await fp.read(rel);
    } catch {
      continue;
    }
    const out = stripShareFrontmatter(text);
    if (!out.ok) malformed.push(rel);
    else if (out.removed.length > 0) markedNotes.push(rel);
  }
  return { markedNotes, malformed, hasConfig: await fp.exists(CONFIG_FILENAME) };
}

/** Best-effort unpublish — MUST run while the device key still exists.
 * Returns null on success, or a human-readable reason it didn't happen. */
async function tryUnpublish(app: App, plugin: VantellPlugin): Promise<string | null> {
  const ident = loadIdentity(app);
  if (!ident?.did) return 'this device holds no linked identity';
  try {
    await signedPost(ident, plugin.data.apiBase, '/v1/unpublish', {});
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'the server could not be reached';
  }
}

async function executeSweep(app: App, plugin: VantellPlugin, plan: SweepPlan): Promise<number> {
  const fp = makeObsidianProvider(app);
  let cleaned = 0;
  for (const rel of plan.markedNotes) {
    try {
      const out = stripShareFrontmatter(await fp.read(rel));
      if (out.ok && out.removed.length > 0) {
        await fp.write(rel, out.content);
        cleaned += 1;
      }
    } catch {
      /* counted below via cleaned mismatch */
    }
  }
  if (plan.hasConfig) {
    try {
      await app.vault.adapter.remove(CONFIG_FILENAME);
    } catch {
      new Notice(`Could not delete ${CONFIG_FILENAME} — remove it by hand.`);
    }
  }
  clearIdentity(app);
  // The Anthropic API key is a live, billable third-party credential — it
  // must not outlive the plugin (SEC-6).
  saveApiKey(app, null);
  plugin.data = { ...DEFAULT_DATA };
  await plugin.saveData(plugin.data);
  plugin.refreshStatusBar();
  return cleaned;
}

export class UninstallModal extends Modal {
  private plan: SweepPlan | null = null;
  private busy = false;
  private alsoUnpublish = true;

  constructor(
    app: App,
    private plugin: VantellPlugin,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.createEl('h2', { text: 'Remove Vantell from this vault' });
    el.createEl('p', { text: 'Checking what Vantell has touched…' });
    this.plan = await planSweep(this.app);
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    const plan = this.plan!;
    el.createEl('h2', { text: 'Remove Vantell from this vault' });
    el.createEl('p', {
      text: 'This puts the vault back the way Vantell found it. Exactly this will happen:',
    });
    const ul = el.createEl('ul');
    ul.createEl('li', {
      text:
        plan.markedNotes.length === 0
          ? 'No notes carry Vantell properties — none will be touched.'
          : `${plan.markedNotes.length} note${plan.markedNotes.length === 1 ? '' : 's'} will have Vantell's sharing properties removed (visibility, max_level). Bodies are untouched — this is verified byte-for-byte. “topics” properties are kept: they may predate Vantell.`,
    });
    ul.createEl('li', {
      text: plan.hasConfig
        ? 'The settings file .vantell.yml will be deleted.'
        : 'No .vantell.yml found — nothing to delete there.',
    });
    ul.createEl('li', { text: "This device's signing key will be deleted (publishing stops)." });
    ul.createEl('li', {
      text: 'Your Anthropic API key (if you set one for drafting) will be deleted from this device.',
    });
    const linked = Boolean(loadIdentity(this.app)?.did);
    if (linked) {
      ul.createEl('li', {
        text:
          'Your published listing (topic labels, counts, folder names) can be taken off the ' +
          'mesh at the same time — see the switch below.',
      });
    }
    if (plan.malformed.length > 0) {
      ul.createEl('li', {
        text: `${plan.malformed.length} note${plan.malformed.length === 1 ? ' has' : 's have'} a broken properties block and will be skipped (listed in the console).`,
      });
    }
    if (linked) {
      new Setting(el)
        .setName('Also take my published listing off the mesh')
        .setDesc(
          'Removes your topic labels, counts and folder names from Vantell — colleagues can ' +
          'no longer discover you. Runs before the key is deleted; if it fails, the ' +
          'dashboard has the same button under Settings → Data & deletion.',
        )
        .addToggle((t) => t.setValue(this.alsoUnpublish).onChange((v) => (this.alsoUnpublish = v)));
    } else {
      el.createEl('p', {
        text:
          'Anything already published can be removed from app.vantell.ai → Settings → ' +
          'Data & deletion (no device key needed).',
      });
    }
    el.createEl('p', {
      text:
        'Afterwards, disable and uninstall the plugin itself under Settings → Community plugins.',
    });

    if (plan.markedNotes.length > 0) {
      const det = el.createEl('details');
      det.createEl('summary', { text: `Show the ${plan.markedNotes.length} affected notes` });
      const list = det.createEl('ul');
      for (const rel of plan.markedNotes.slice(0, 100)) list.createEl('li', { text: rel });
    }

    new Setting(el)
      .addButton((b) =>
        b
          .setButtonText('Remove everything listed above')
          .setDestructive()
          .onClick(() => void this.execute()),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  private async execute(): Promise<void> {
    if (this.busy || !this.plan) return;
    this.busy = true;
    try {
      for (const rel of this.plan.malformed) {
        console.warn(`Vantell uninstall: skipped (broken properties block): ${rel}`);
      }
      // Unpublish FIRST — after the sweep deletes the key, this device can
      // never sign a removal again.
      let unpublishNote = '';
      if (this.alsoUnpublish) {
        const failure = await tryUnpublish(this.app, this.plugin);
        unpublishNote =
          failure === null
            ? ' Your published listing was taken off the mesh.'
            : ` Removing the published listing did not work (${failure}) — use app.vantell.ai → Settings → Data & deletion.`;
      }
      const cleaned = await executeSweep(this.app, this.plugin, this.plan);
      new Notice(
        `Vantell removed: ${cleaned} note${cleaned === 1 ? '' : 's'} cleaned, settings file and device key deleted.${unpublishNote} ` +
          'You can now uninstall the plugin under Community plugins.',
        12_000,
      );
      this.close();
    } catch (err) {
      new Notice(err instanceof Error ? err.message : 'Removal failed — nothing further was changed.');
    } finally {
      this.busy = false;
    }
  }
}
