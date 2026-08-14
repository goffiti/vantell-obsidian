/**
 * Settings tab — status at a glance, the wizard entry points, and the
 * unlink escape hatch. Declarative (getSettingDefinitions, Obsidian 1.13+),
 * so every row shows up in the app's settings search. Advanced (API base)
 * stays at the bottom, visibly technical, and only affects the NEXT link —
 * the base is pinned per-device at link time.
 */
import {
  Notice,
  PluginSettingTab,
  type App,
  type Setting,
  type SettingDefinitionItem,
} from 'obsidian';
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

  override getControlValue(key: string): unknown {
    if (key === 'displayName') return this.plugin.data.displayName;
    if (key === 'aiModel') return this.plugin.data.aiModel;
    if (key === 'apiBase') return this.plugin.device.apiBase;
    return undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const v = typeof value === 'string' ? value : '';
    if (key === 'displayName') this.plugin.data.displayName = v;
    else if (key === 'aiModel') this.plugin.data.aiModel = v;
    else if (key === 'apiBase') {
      this.plugin.device.apiBase = v.trim() || 'https://api.vantell.ai';
      this.plugin.saveDevice();
      return;
    } else return;
    await this.plugin.saveData(this.plugin.data);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const linked = (): boolean => Boolean(loadIdentity(this.app)?.did);
    return [
      {
        name: 'Vantell account',
        aliases: ['link', 'setup', 'pair', 'folders'],
        render: (setting: Setting) => {
          const isLinked = linked();
          const last = this.plugin.data.lastPublished;
          setting
            .setName(isLinked ? 'Linked to your Vantell account' : 'Not linked yet')
            .setDesc(
              isLinked
                ? last
                  ? `Live since ${new Date(last.at).toLocaleString()} — ${last.topics.length} topic${last.topics.length === 1 ? '' : 's'}, ${last.stats.shareable_notes} shareable note${last.stats.shareable_notes === 1 ? '' : 's'}.`
                  : 'Linked, but nothing published yet — run the setup to choose folders and go live.'
                : 'Run the setup to link this vault to your account.',
            )
            .addButton((b) =>
              b
                .setButtonText(isLinked ? 'Choose your folders' : 'Set up Vantell')
                .setCta()
                .onClick(() => new SetupWizard(this.app, this.plugin).open()),
            );
        },
      },
      {
        name: 'Your name on the mesh',
        desc: 'How colleagues see you.',
        control: { type: 'text', key: 'displayName' },
      },
      {
        name: 'What leaves this vault',
        desc:
          'Topic labels, note counts, the names of folders you chose, and up to three sample ' +
          'note titles per chosen folder (shown in the review). Note contents leave only if ' +
          'you enable automatic drafting below — and then only to your own AI account, never ' +
          'to Vantell. The full list is in the plugin README.',
      },
      {
        name: 'Unlink this device',
        desc:
          "Deletes this device's signing key. Publishing stops until you link again; " +
          'nothing already published is deleted (manage that from your dashboard).',
        visible: linked,
        render: (setting: Setting) => {
          setting.addButton((b) =>
            b
              .setButtonText('Unlink')
              .setDestructive()
              .onClick(() => {
                clearIdentity(this.app);
                new Notice('Unlinked — this device no longer holds a signing key.');
                this.update();
              }),
          );
        },
      },
      {
        name: 'Remove Vantell from this vault',
        desc:
          "Puts the vault back the way Vantell found it: removes Vantell's sharing " +
          "properties from notes, deletes .vantell.yml and this device's key. " +
          'You review the exact list before anything happens.',
        render: (setting: Setting) => {
          setting.addButton((b) =>
            b
              .setButtonText('Remove…')
              .setDestructive()
              .onClick(() => new UninstallModal(this.app, this.plugin).open()),
          );
        },
      },
      {
        type: 'group',
        heading: 'Answer drafting',
        items: [
          {
            name: 'Draft with your own Claude — no setup',
            desc:
              'When answering a request, “Draft with my Claude” builds a prompt from your ' +
              'shareable notes on that topic. Paste it into whatever Claude you already use ' +
              '(claude.ai, the app, or Claude Code), then paste the answer back. Works on any ' +
              'plan, needs no API key, and nothing leaves this device from the plugin. This is ' +
              'always available — there is nothing to configure here.',
          },
          {
            name: 'Automatic drafting (advanced — Anthropic API key)',
            desc:
              'Optional. If you have a developer API key from console.anthropic.com, add it to draft ' +
              'in place without leaving Obsidian. The key is stored on this device only and never ' +
              'synced; drafting sends your shareable notes on the topic to your own Anthropic account. ' +
              'Most people should leave this blank and use “Draft with my Claude” above.',
            render: (setting: Setting) => {
              setting.addText((t) => {
                t.inputEl.type = 'password';
                t.setPlaceholder(hasApiKey(this.app) ? '•••••• (set)' : 'sk-ant-…').onChange(
                  (v) => {
                    saveApiKey(this.app, v);
                  },
                );
              });
            },
          },
          {
            name: 'Automatic drafting model',
            desc: 'Which Claude model the API-key path uses (billed to your Anthropic account).',
            control: {
              type: 'dropdown',
              key: 'aiModel',
              options: Object.fromEntries(MODEL_CHOICES.map((m) => [m.value, m.label])),
            },
          },
        ],
      },
      {
        name: 'Server (advanced)',
        render: (setting: Setting) => {
          const pinned = loadIdentity(this.app)?.api;
          setting
            .setName('Server (advanced)')
            .setDesc(
              (pinned
                ? `This link is pinned to ${pinned} (set at pairing, HTTPS enforced). `
                : 'Not linked yet. ') +
                'The field below changes which server the NEXT link talks to — only for self-hosted or test servers.',
            )
            .addText((t) => {
              t.setValue(this.plugin.device.apiBase).onChange((v) => {
                this.plugin.device.apiBase = v.trim() || 'https://api.vantell.ai';
                this.plugin.saveDevice();
              });
            });
        },
      },
    ];
  }
}
