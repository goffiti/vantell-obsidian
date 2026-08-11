/**
 * The ASKING half — knock a colleague on the mesh.
 *
 * Lists the org registry (public-within-org manifests), lets the owner pick a
 * colleague + topic and write a purpose-first question, and sends a signed
 * level-3 query envelope. The relay materializes a knock on the recipient's
 * side; the answer comes back as an 'answer' envelope, surfaced by the inbox
 * poll (see main.ts / inbox.ts).
 */
import { Modal, Notice, Setting, type App } from 'obsidian';
import { signedGet, signedPost, utf8ToBase64 } from './api';
import { loadIdentity } from './identity';
import type { ReceivedAnswer } from './data';
import type VantellPlugin from './main';

interface RegistryManifest {
  did?: string;
  display_name?: string;
  topics?: { label?: string }[];
  via_circles?: string[];
  /** The owner's disclosure ceiling — questions above it raise a knock. */
  max_level?: number;
  /** Owner-written "what you can ask me" blurb from their manifest. */
  about?: string;
}

interface Colleague {
  did: string;
  name: string;
  topics: string[];
  /** Reached through the owner's circles (cross-org) rather than the org. */
  viaCircles: string[];
  /** Their disclosure ceiling — the relay raises a knock above this. */
  maxLevel: number;
  /** Their "what you can ask me" blurb (may be empty). */
  about: string;
}

function nameFromDid(did: string): string {
  return did.split(':').pop() ?? did;
}

export class KnockComposerModal extends Modal {
  private colleagues: Colleague[] = [];
  private toDid = '';
  private topic = '';
  private question = '';
  private purpose = '';
  private level = 3;
  private busy = false;

  constructor(
    app: App,
    private plugin: VantellPlugin,
    private prefillDid?: string,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    this.modalEl.addClass('vantell-wizard');
    const ident = loadIdentity(this.app);
    if (!ident?.did) {
      this.contentEl.createEl('p', { text: 'This device is not linked — set up Vantell first.' });
      return;
    }
    this.contentEl.createEl('p', { cls: 'vantell-sub', text: 'Loading colleagues on the mesh…' });
    try {
      const reg = await signedGet<{ manifests: RegistryManifest[] }>(
        ident,
        this.plugin.data.apiBase,
        '/v1/registry',
      );
      this.colleagues = (reg.manifests ?? [])
        .filter((m) => m.did && m.did !== ident.did)
        .map((m) => ({
          did: m.did!,
          name: m.display_name || nameFromDid(m.did!),
          topics: (m.topics ?? []).map((t) => t.label ?? '').filter(Boolean),
          viaCircles: (m.via_circles ?? []).filter((c): c is string => typeof c === 'string'),
          maxLevel: typeof m.max_level === 'number' ? m.max_level : 2,
          about: typeof m.about === 'string' ? m.about : '',
        }));
    } catch (err) {
      this.contentEl.empty();
      this.contentEl.createEl('p', {
        text: err instanceof Error ? err.message : 'Could not load the registry.',
      });
      return;
    }
    if (this.colleagues.length > 0) {
      const pre = this.prefillDid && this.colleagues.find((c) => c.did === this.prefillDid);
      const start = pre || this.colleagues[0]!;
      this.toDid = start.did;
      this.topic = start.topics[0] ?? '';
    }
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl('h2', { text: 'Knock a colleague' });
    if (this.colleagues.length === 0) {
      el.createEl('p', {
        cls: 'vantell-sub',
        text: "No one else is on your org's mesh yet.",
      });
      return;
    }
    el.createEl('p', {
      cls: 'vantell-sub',
      text:
        'Ask what a colleague knows about a topic. They approve or deny; if they answer, ' +
        'it comes back here. Only your question and purpose are sent — never any of your notes.',
    });

    new Setting(el).setName('Who').addDropdown((d) => {
      for (const c of this.colleagues) {
        d.addOption(
          c.did,
          `${c.name}${
            c.topics.length ? ` — ${c.topics.slice(0, 4).join(', ')}` : ' — nothing published yet'
          }${c.viaCircles.length ? ` · via ${c.viaCircles[0]}` : ''}`,
        );
      }
      d.setValue(this.toDid).onChange((v) => {
        this.toDid = v;
        const c = this.colleagues.find((x) => x.did === v);
        this.topic = c?.topics[0] ?? '';
        this.render();
      });
    });

    const sel = this.colleagues.find((c) => c.did === this.toDid);
    // Remote-authored text: rendered inert via text, per the quarantine rule.
    if (sel?.about) {
      el.createEl('p', { cls: 'vantell-sub', text: `In their words: ${sel.about}` });
    }
    new Setting(el)
      .setName('Topic')
      .setDesc(
        sel && sel.topics.length
          ? `They publish: ${sel.topics.join(', ')}`
          : sel && !sel.topics.length
            ? "They haven't published topics yet — they can still answer, but you're asking blind."
            : 'A topic to ask about.',
      )
      .addText((t) => t.setValue(this.topic).onChange((v) => (this.topic = v)));

    el.createEl('label', { cls: 'field', text: 'Your question' });
    const q = el.createEl('textarea', { cls: 'vantell-answer' });
    q.rows = 3;
    q.placeholder = 'What do you actually want to know?';
    q.value = this.question;
    q.addEventListener('input', () => (this.question = q.value));

    el.createEl('label', { cls: 'field', text: 'Purpose (why you’re asking — they see this)' });
    const p = el.createEl('textarea', { cls: 'vantell-answer' });
    p.rows = 2;
    p.placeholder = 'e.g. Prepping Thursday’s guild session on…';
    p.value = this.purpose;
    p.addEventListener('input', () => (this.purpose = p.value));

    new Setting(el)
      .setName('Depth')
      .setDesc(
        sel
          ? `Their ceiling is L${sel.maxLevel}: anything above it raises a knock they approve; up to L${sel.maxLevel} is lighter.`
          : 'Levels above their ceiling raise a knock they approve.',
      )
      .addDropdown((d) => {
        d.addOption('3', 'Level 3 — needs their yes')
          .addOption('2', 'Level 2 — abstract')
          .setValue(String(this.level))
          .onChange((v) => (this.level = Number(v)));
      });

    new Setting(el)
      .addButton((b) =>
        b
          .setButtonText('Send knock')
          .setCta()
          .onClick(() => void this.send()),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  private async send(): Promise<void> {
    if (this.busy) return;
    const ident = loadIdentity(this.app);
    if (!ident?.did) return;
    if (!this.toDid) {
      new Notice('Pick a colleague first.');
      return;
    }
    if (!this.question.trim()) {
      new Notice('Write your question first.');
      return;
    }
    if (!this.purpose.trim()) {
      new Notice('Add a purpose — it’s required, and it’s what they see first.');
      return;
    }
    this.busy = true;
    try {
      const query = {
        knock: '0.1',
        type: 'query',
        from: ident.did,
        to: this.toDid,
        level: this.level,
        topic: this.topic.trim() || null,
        question: this.question.trim(),
      };
      await signedPost(ident, this.plugin.data.apiBase, '/v1/envelope', {
        to: this.toDid,
        ciphertext: utf8ToBase64(JSON.stringify(query)),
        level: this.level,
        topic: this.topic.trim() || undefined,
        purpose: this.purpose.trim(),
      });
      const who = this.colleagues.find((c) => c.did === this.toDid)?.name ?? 'them';
      this.plugin.data.sentKnocks = [
        {
          toDid: this.toDid,
          toName: who,
          topic: this.topic.trim() || null,
          question: this.question.trim(),
          at: new Date().toISOString(),
          status: 'sent' as const,
        },
        ...this.plugin.data.sentKnocks,
      ].slice(0, 50);
      await this.plugin.saveData(this.plugin.data);
      this.plugin.refreshPanel();
      new Notice(`Knock sent to ${who}. You'll be notified here if they answer.`);
      this.close();
    } catch (err) {
      new Notice(err instanceof Error ? err.message : 'Sending the knock failed.');
    } finally {
      this.busy = false;
    }
  }
}

/** Show an answer that came back to one of the owner's knocks. */
export class AnswerModal extends Modal {
  constructor(
    app: App,
    private fromName: string,
    private topic: string | null,
    private summary: string,
    private sources: string[] = [],
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('vantell-wizard');
    const el = this.contentEl;
    el.createEl('h2', { text: `${this.fromName} answered` });
    if (this.topic) el.createEl('p', { cls: 'vantell-sub', text: `Topic: ${this.topic}` });
    el.createEl('blockquote', { text: this.summary, cls: 'vantell-inert-quote' });
    if (this.sources.length > 0) {
      el.createEl('p', {
        cls: 'vantell-sub',
        text: `From their notes (titles only — the notes stay in their vault): ${this.sources.join(' · ')}`,
      });
    }
    new Setting(el).addButton((b) => b.setButtonText('Close').setCta().onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** The kept list of answers to the owner's knocks. */
export class AnswersListModal extends Modal {
  constructor(
    app: App,
    private answers: ReceivedAnswer[],
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('vantell-wizard');
    const el = this.contentEl;
    el.createEl('h2', { text: 'Answers to your knocks' });
    if (this.answers.length === 0) {
      el.createEl('p', {
        cls: 'vantell-sub',
        text: "None yet. Knock a colleague, and their answer lands here when it comes back.",
      });
      return;
    }
    for (const a of this.answers) {
      const card = el.createDiv({ cls: 'vantell-review-card' });
      const when = (() => {
        try {
          return new Date(a.at).toLocaleString();
        } catch {
          return '';
        }
      })();
      card.createEl('p', {
        text: `${a.fromName}${a.topic ? ` · ${a.topic}` : ''}${when ? ` · ${when}` : ''}`,
      });
      card.createEl('blockquote', { text: a.summary, cls: 'vantell-inert-quote' });
      if (a.sources && a.sources.length > 0) {
        card.createEl('p', {
          cls: 'vantell-sub',
          text: `From their notes: ${a.sources.join(' · ')}`,
        });
      }
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
