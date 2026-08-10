/**
 * Settings tab — status at a glance, the wizard entry points, and the
 * unlink escape hatch. Advanced (API base) stays at the bottom, visibly
 * technical, and only affects the NEXT link — the base is pinned per-device
 * at link time.
 */
import { Notice, PluginSettingTab, Setting, type App } from 'obsidian';
import { MODEL_CHOICES, hasApiKey, saveApiKey } from './ai';
import { clearIdentity, loadIdentity } from './identity';
import { UninstallModal } from './uninstall';
import { SetupWizard } from './wizard';
import type VantellPlugin from './main';

export class VantellSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: VantellPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const el = this.containerEl;
    el.empty();

    const ident = loadIdentity(this.app);
    const linked = Boolean(ident?.did);
    const last = this.plugin.data.lastPublished;

    new Setting(el)
      .setName(linked ? 'Linked to your Vantell account' : 'Not linked yet')
      .setDesc(
        linked
          ? last
            ? `Live since ${new Date(last.at).toLocaleString()} — ${last.topics.length} topic${last.topics.length === 1 ? '' : 's'}, ${last.stats.shareable_notes} shareable note${last.stats.shareable_notes === 1 ? '' : 's'}.`
            : 'Linked, but nothing published yet — run the setup to choose folders and go live.'
          : 'Run the setup to link this vault to your account.',
      )
      .addButton((b) =>
        b
          .setButtonText(linked ? 'Choose your folders' : 'Set up Vantell')
          .setCta()
          .onClick(() => new SetupWizard(this.app, this.plugin).open()),
      );

    new Setting(el)
      .setName('Your name on the mesh')
      .setDesc('How colleagues see you.')
      .addText((t) =>
        t.setValue(this.plugin.data.displayName).onChange(async (v) => {
          this.plugin.data.displayName = v;
          await this.plugin.saveData(this.plugin.data);
        }),
      );

    new Setting(el)
      .setName('What leaves this vault')
      .setDesc(
        'Topic labels and counts from folders you chose, and the names of those folders — ' +
        'nothing else. Note contents never leave. The full list is in the plugin README.',
      );

    if (linked) {
      new Setting(el)
        .setName('Unlink this device')
        .setDesc(
          'Deletes this device\'s signing key. Publishing stops until you link again; ' +
          'nothing already published is deleted (manage that from your dashboard).',
        )
        .addButton((b) =>
          b.setButtonText('Unlink').setWarning().onClick(async () => {
            clearIdentity(this.app);
            new Notice('Unlinked — this device no longer holds a signing key.');
            this.display();
          }),
        );
    }

    new Setting(el)
      .setName('Remove Vantell from this vault')
      .setDesc(
        'Puts the vault back the way Vantell found it: removes Vantell\'s sharing ' +
        'properties from notes, deletes .vantell.yml and this device\'s key. ' +
        'You review the exact list before anything happens.',
      )
      .addButton((b) =>
        b.setButtonText('Remove…').setWarning().onClick(() => {
          new UninstallModal(this.app, this.plugin).open();
        }),
      );

    // ---- Answer drafting ----
    new Setting(el).setName('Answer drafting').setHeading();
    new Setting(el)
      .setName('Draft with your own Claude — no setup')
      .setDesc(
        'When answering a request, “Draft with my Claude” builds a prompt from your ' +
        'shareable notes on that topic. Paste it into whatever Claude you already use ' +
        '(claude.ai, the app, or Claude Code), then paste the answer back. Works on any ' +
        'plan, needs no API key, and nothing leaves this device from the plugin. This is ' +
        'always available — there is nothing to configure here.',
      );

    new Setting(el)
      .setName('Automatic drafting (advanced — Anthropic API key)')
      .setDesc(
        'Optional. If you have a developer API key from console.anthropic.com, add it to draft ' +
        'in place without leaving Obsidian. The key is stored on this device only and never ' +
        'synced; drafting sends your shareable notes on the topic to your own Anthropic account. ' +
        'Most people should leave this blank and use “Draft with my Claude” above.',
      )
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder(hasApiKey(this.app) ? '•••••• (set)' : 'sk-ant-…').onChange((v) => {
          saveApiKey(this.app, v);
        });
      });

    new Setting(el)
      .setName('Automatic drafting model')
      .setDesc('Which Claude model the API-key path uses (billed to your Anthropic account).')
      .addDropdown((d) => {
        for (const m of MODEL_CHOICES) d.addOption(m.value, m.label);
        d.setValue(this.plugin.data.aiModel).onChange(async (v) => {
          this.plugin.data.aiModel = v;
          await this.plugin.saveData(this.plugin.data);
        });
      });

    new Setting(el)
      .setName('Server (advanced)')
      .setDesc('Only change this for a self-hosted or test server. Takes effect on the next link.')
      .addText((t) =>
        t.setValue(this.plugin.data.apiBase).onChange(async (v) => {
          this.plugin.data.apiBase = v.trim() || 'https://api.vantell.ai';
          await this.plugin.saveData(this.plugin.data);
        }),
      );
  }
}
