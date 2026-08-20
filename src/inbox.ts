/**
 * Incoming requests (knocks) — the answering half of the protocol.
 *
 * QUARANTINE RULE (build-spec Rule 1): inbound mesh traffic is UNTRUSTED
 * CONTENT. Everything decoded here is rendered inert — plain text via
 * textContent, never HTML, never executed, never written into any vault
 * file. Answer text flows one way: typed by the owner, out to the wire.
 *
 * Consent comes from the portal knock the owner approved (checked over the
 * DID-signed /v1/agent/knocks route) — this module never self-approves.
 */
import { Modal, Notice, Setting, type App } from 'obsidian';
import { encodeEnvelope, respondKnock, signedGet, signedPost } from './api';
import { openSealed } from '@vantell/vaultscan-core';
import {
  buildPastePrompt,
  draftAnswer,
  gatherDraftSources,
  type DraftGather,
  hasApiKey,
  AiError,
  type DraftSource,
} from './ai';
import { loadIdentity } from './identity';
import type VantellPlugin from './main';

interface InboxEnvelope {
  id: string;
  from: string;
  ciphertext: string;
  created_at: string;
  /** 'sealed' = crypto_box_seal to this device's key; absent = legacy b64. */
  enc?: string;
}

interface KnockRow {
  knock_id: string;
  envelope_ref?: string;
  status: string;
  from_did?: string;
}

/** An answer that came back to one of OUR knocks. */
export interface IncomingAnswer {
  fromDid: string;
  fromName: string;
  topic: string | null;
  summary: string;
  /** Titles of the notes the answerer explicitly ticked as sources. */
  sources: string[];
}

/** A decoded incoming query, plus its consent state. */
export interface IncomingRequest {
  envelopeId: string;
  fromDid: string;
  fromName: string;
  createdAt: string;
  question: string;
  topic: string | null;
  level: number | null;
  consent: 'approved' | 'pending' | 'denied' | 'unknown';
  knockId: string | null;
}

/** Decode an envelope body: sealed boxes are opened with this device's
 * seed; anything that fails to open or parse is null — treated exactly like
 * a foreign envelope (a future client's problem, never an error). */
function decodeEnvelope(
  env: { ciphertext: string; enc?: string },
  seedB64: string,
): Record<string, unknown> | null {
  // Sealed-only since the 2026-08-14 legacy retirement: anything else is
  // treated as a foreign envelope (null), exactly like a failed unseal.
  if (env.enc !== 'sealed') return null;
  const plain = openSealed(env.ciphertext, seedB64);
  if (plain === null) return null;
  try {
    const parsed: unknown = JSON.parse(plain);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}


function nameFromDid(did: string): string {
  return did.split(':').pop() ?? did;
}

/** Poll the inbox + consent state. Returns open requests and any
 * knock-response notifications (answers to OUR knocks). */
export async function checkInbox(plugin: VantellPlugin): Promise<{
  requests: IncomingRequest[];
  notifications: string[];
  answers: IncomingAnswer[];
}> {
  const ident = loadIdentity(plugin.app);
  if (!ident?.did) return { requests: [], notifications: [], answers: [] };
  const base = plugin.device.apiBase;

  const since = plugin.device.inboxCursor;
  const path = `/v1/inbox${since ? `?since=${encodeURIComponent(since)}` : ''}`;
  const inbox = await signedGet<{ envelopes: InboxEnvelope[]; now?: string }>(ident, base, path);
  const fresh = (inbox.envelopes ?? []).filter(
    (e) => !plugin.device.handledEnvelopes.includes(e.id),
  );
  // Advance the cursor only past what we actually ingested.
  const last = (inbox.envelopes ?? []).at(-1);
  if (last) {
    plugin.device.inboxCursor = last.created_at;
    plugin.device.pendingEnvelopes = [
      ...plugin.device.pendingEnvelopes.filter((p) => !fresh.some((f) => f.id === p.id)),
      ...fresh,
    ].slice(-100);
    plugin.saveDevice();
  }

  const notifications: string[] = [];
  const answers: IncomingAnswer[] = [];
  const queries: InboxEnvelope[] = [];
  for (const env of plugin.device.pendingEnvelopes) {
    const body = decodeEnvelope(env, ident.private_key_b64);
    if (!body) continue; // sealed or foreign — a future client's problem
    if (body['type'] === 'knock_response') {
      const decision = typeof body['decision'] === 'string' ? body['decision'] : 'answered';
      const receipt = typeof body['receipt_id'] === 'string' ? body['receipt_id'] : '';
      notifications.push(`Your knock was ${decision} — receipt ${receipt}`);
      plugin.device.handledEnvelopes.push(env.id);
      continue;
    }
    if (body['type'] === 'answer') {
      answers.push({
        fromDid: env.from,
        fromName: nameFromDid(env.from),
        topic: typeof body['topic'] === 'string' ? body['topic'] : null,
        summary: typeof body['summary'] === 'string' ? body['summary'] : '(no text)',
        sources: Array.isArray(body['sources'])
          ? body['sources'].filter((s): s is string => typeof s === 'string').slice(0, 10)
          : [],
      });
      plugin.device.handledEnvelopes.push(env.id);
      continue;
    }
    if (body['type'] === 'query') queries.push(env);
  }
  if (notifications.length > 0 || answers.length > 0) {
    plugin.device.pendingEnvelopes = plugin.device.pendingEnvelopes.filter(
      (p) => !plugin.device.handledEnvelopes.includes(p.id),
    );
    plugin.saveDevice();
  }

  let knocks: KnockRow[] = [];
  if (queries.length > 0) {
    try {
      knocks = (await signedGet<{ knocks: KnockRow[] }>(ident, base, '/v1/agent/knocks')).knocks;
    } catch {
      knocks = [];
    }
  }
  const byEnvelope = new Map(knocks.filter((k) => k.envelope_ref).map((k) => [k.envelope_ref!, k]));

  // Names from the org registry — metadata that is public-within-org anyway.
  let names = new Map<string, string>();
  if (queries.length > 0 || answers.length > 0) {
    try {
      const reg = await signedGet<{ manifests: { did?: string; display_name?: string }[] }>(
        ident,
        base,
        '/v1/registry',
      );
      names = new Map(
        reg.manifests
          .filter((m) => m.did && m.display_name)
          .map((m) => [m.did!, m.display_name!]),
      );
    } catch {
      /* names stay did-derived */
    }
  }
  for (const a of answers) a.fromName = names.get(a.fromDid) ?? a.fromName;

  const requests: IncomingRequest[] = queries.map((env) => {
    const body = decodeEnvelope(env, ident.private_key_b64)!;
    const knock = byEnvelope.get(env.id) ?? null;
    const status = knock?.status ?? null;
    return {
      envelopeId: env.id,
      fromDid: env.from,
      fromName: names.get(env.from) ?? nameFromDid(env.from),
      createdAt: env.created_at,
      question: typeof body['question'] === 'string' ? body['question'] : '(no question text)',
      topic: typeof body['topic'] === 'string' ? body['topic'] : null,
      level: typeof body['level'] === 'number' ? body['level'] : null,
      consent:
        status === 'approved'
          ? 'approved'
          : status === 'pending'
            ? 'pending'
            : status === 'denied' || status === 'expired'
              ? 'denied'
              : 'unknown',
      knockId: knock?.knock_id ?? null,
    };
  });
  return { requests, notifications, answers };
}

/** Approve/deny a knock directly from the plugin (DID-signed). `standing`
 * asks the relay to keep allowing this person (capped at L3 and the org
 * floor, receipt-backed, revocable on the dashboard). Returns true on
 * success. Refreshes the panel. */
export async function respondToKnock(
  plugin: VantellPlugin,
  r: IncomingRequest,
  action: 'approve' | 'deny',
  standing = false,
): Promise<boolean> {
  const ident = loadIdentity(plugin.app);
  if (!ident?.did || !r.knockId) {
    new Notice('Could not respond — no linked identity or knock id.');
    return false;
  }
  try {
    await respondKnock(ident, plugin.device.apiBase, r.knockId, action, standing);
    r.consent = action === 'approve' ? 'approved' : 'denied';
    if (standing && action === 'approve') {
      new Notice(
        `${r.fromName} can now ask without waiting for your yes. ` +
          'You still write every answer — revoke anytime in your dashboard.',
      );
    }
    plugin.refreshPanel();
    return true;
  } catch (err) {
    new Notice(err instanceof Error ? err.message : 'Responding failed.');
    return false;
  }
}

/* ---------------------------------------------------------------- modals */

/** Promise-based replacement for window.confirm (which blocks the UI thread
 * and is disallowed for community plugins). Resolves false when dismissed. */
class ConfirmModal extends Modal {
  private resolved = false;
  private resolve!: (ok: boolean) => void;

  constructor(
    app: App,
    private heading: string,
    private paragraphs: string[],
    private cta: string,
  ) {
    super(app);
  }

  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    for (const p of this.paragraphs) this.contentEl.createEl('p', { text: p, cls: 'vantell-sub' });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.cta)
          .setCta()
          .onClick(() => {
            this.resolved = true;
            this.resolve(true);
            this.close();
          }),
      );
  }

  onClose(): void {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}

export class RequestsModal extends Modal {
  constructor(
    app: App,
    private plugin: VantellPlugin,
    private requests: IncomingRequest[],
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('vantell-wizard');
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl('h2', { text: 'Requests' });
    if (this.requests.length === 0) {
      el.createEl('p', { cls: 'vantell-sub', text: "No one's knocking right now." });
      return;
    }
    for (const r of this.requests) {
      const card = el.createDiv({ cls: 'vantell-review-card' });
      // Inert rendering on purpose (Rule 1): textContent only.
      card.createEl('p', {
        text: `${r.fromName} asks${r.topic ? ` about ${r.topic}` : ''}${r.level !== null ? ` (level ${r.level})` : ''}:`,
      });
      card.createEl('blockquote', { text: r.question, cls: 'vantell-inert-quote' });
      const row = new Setting(card);
      if (r.consent === 'approved') {
        row.setDesc('You approved this on your dashboard — write the answer here.');
        row.addButton((b) =>
          b
            .setButtonText('Answer…')
            .setCta()
            .onClick(() => {
              this.close();
              new ComposeAnswerModal(this.app, this.plugin, r).open();
            }),
        );
      } else if (r.consent === 'pending' && r.knockId) {
        let standing = false;
        new Setting(card)
          .setName(`Keep allowing ${r.fromName}`)
          .setDesc(
            'Future questions from them skip the approval wait (up to L3 — ' +
              'summaries in your own words, never note contents). You still ' +
              'write every answer. Revoke anytime in your dashboard.',
          )
          .addToggle((t) => t.setValue(false).onChange((v) => (standing = v)));
        row.setDesc('Approve to answer here, or decline — no dashboard needed.');
        row.addButton((b) =>
          b
            .setButtonText('Approve & answer')
            .setCta()
            .onClick(async () => {
              if (await respondToKnock(this.plugin, r, 'approve', standing)) {
                this.close();
                r.consent = 'approved';
                new ComposeAnswerModal(this.app, this.plugin, r).open();
              }
            }),
        );
        row.addButton((b) =>
          b.setButtonText('Decline').onClick(async () => {
            if (await respondToKnock(this.plugin, r, 'deny')) {
              new Notice('Declined — the asker is told it’s not a topic you share.');
              this.requests = this.requests.filter((x) => x.envelopeId !== r.envelopeId);
              this.render();
            }
          }),
        );
      } else if (r.consent === 'pending') {
        row.setDesc('Waiting for your yes — approve or decline on your dashboard.');
        row.addButton((b) =>
          b
            .setButtonText('Open dashboard')
            .onClick(() => window.open('https://app.vantell.ai/knocks', '_blank')),
        );
      } else {
        row.setDesc(
          r.consent === 'denied'
            ? 'You declined this request — nothing will be sent.'
            : 'Sent before consent tracking covered it — ask them to re-send ' +
                'the question and it will show up here to approve.',
        );
      }
      row.addButton((b) =>
        b.setButtonText('Dismiss').onClick(async () => {
          this.plugin.device.handledEnvelopes.push(r.envelopeId);
          this.plugin.device.pendingEnvelopes = this.plugin.device.pendingEnvelopes.filter(
            (p) => p.id !== r.envelopeId,
          );
          this.plugin.saveDevice();
          this.requests = this.requests.filter((x) => x.envelopeId !== r.envelopeId);
          this.plugin.setRequestCount(this.requests.length);
          this.render();
        }),
      );
    }
  }
}

export class ComposeAnswerModal extends Modal {
  private summary = '';
  private selectedSources = new Set<string>();
  private busy = false;
  private promptHost: HTMLElement | null = null;
  /** After an automatic draft: the exact notes that were sent, as a visible
   * record — not a regathered list that could diverge. */
  private sentRecordEl: HTMLElement | null = null;
  /** One vault scan per modal, shared by the source list and both drafting
   * paths — never re-scan, and NEVER make the answer UI wait on it. */
  private gatherPromise: Promise<DraftGather> | null = null;

  constructor(
    app: App,
    private plugin: VantellPlugin,
    private request: IncomingRequest,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    this.modalEl.addClass('vantell-wizard');
    const el = this.contentEl;
    const r = this.request;
    el.createEl('h2', { text: `Answer ${r.fromName}` });
    el.createEl('p', { cls: 'vantell-sub', text: 'The question (their words):' });
    el.createEl('blockquote', { text: r.question, cls: 'vantell-inert-quote' });

    el.createEl('p', {
      text:
        'Write the answer in your own words. Only what you type here is sent — ' +
        'nothing is auto-extracted from your notes.',
    });
    const ta = el.createEl('textarea', { cls: 'vantell-answer' });
    ta.rows = 8;
    ta.placeholder = 'Your answer…';
    ta.addEventListener('input', () => (this.summary = ta.value));

    // Drafting help. Primary path needs no setup: build a prompt to paste
    // into whatever Claude the owner already uses. Optional API path drafts
    // in place for owners who added a key.
    const draftRow = new Setting(el)
      .setName('Need a hand drafting?')
      .setDesc(
        'Build a prompt from your shareable notes on this topic and paste it into your own ' +
          'Claude (claude.ai, the app, or Claude Code). Paste the answer back here — nothing ' +
          'leaves this device from the plugin, and nothing goes to ' + r.fromName + ' until you Send.',
      )
      .addButton((b) =>
        b
          .setButtonText('Draft with my Claude')
          .setCta()
          .onClick(() => void this.buildPrompt(r)),
      );
    if (hasApiKey(this.app)) {
      draftRow.addButton((b) =>
        b
          .setButtonText('Draft automatically (API key)')
          .onClick(() => void this.draft(r, ta)),
      );
    }
    // Where the copy-paste prompt panel renders when built.
    this.promptHost = el.createDiv();
    this.sentRecordEl = el.createEl('p', { cls: 'vantell-fineprint' });
    const sourcesHost = el.createDiv();

    // Send/Cancel render BEFORE the vault scan: answering must never wait
    // on note gathering (a capture-heavy vault can take a while even with
    // the path prefilter).
    new Setting(el)
      .addButton((b) =>
        b
          .setButtonText('Send answer')
          .setCta()
          .onClick(() => void this.send()),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));

    const scanNote = sourcesHost.createEl('p', {
      cls: 'vantell-sub',
      text: 'Scanning your shareable notes…',
    });
    this.gatherPromise = gatherDraftSources(this.app, r.topic);
    this.gatherPromise
      .then(({ notes: sources }) => {
        if (sources.length === 0) {
          scanNote.setText('No shareable notes yet — write the answer in your own words.');
          return;
        }
        scanNote.setText(
          'Your shareable notes for reference — open any, and tick the ones whose TITLE ' +
            'may be listed as a source (titles only, never contents):',
        );
        const list = sourcesHost.createDiv({ cls: 'vantell-folder-list' });
        for (const s of sources) {
          const row = new Setting(list).setName(s.title);
          row.addButton((b) =>
            b.setButtonText('Open').onClick(() => {
              void this.app.workspace.openLinkText(s.rel, '/', true);
            }),
          );
          row.addToggle((t) =>
            t.setValue(false).onChange((v) => {
              if (v) this.selectedSources.add(s.title);
              else this.selectedSources.delete(s.title);
            }),
          );
        }
      })
      .catch(() => {
        scanNote.setText('Could not scan your notes — you can still write and send the answer.');
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async buildPrompt(r: IncomingRequest, includeBodies = false): Promise<void> {
    if (!this.promptHost) return;
    const host = this.promptHost;
    host.empty();
    host.createEl('p', { cls: 'vantell-sub', text: 'Building the prompt from your shareable notes…' });
    let sources: DraftSource[] = [];
    let topicMatched = false;
    try {
      const gathered = await (this.gatherPromise ?? gatherDraftSources(this.app, r.topic));
      sources = gathered.notes;
      topicMatched = gathered.topicMatched;
    } catch {
      sources = [];
    }
    host.empty();
    if (sources.length === 0) {
      host.createEl('p', {
        cls: 'vantell-sub',
        text: 'You have no shareable notes yet — share a note first, or just write the answer.',
      });
      return;
    }
    const prompt = buildPastePrompt(
      { question: r.question, topic: r.topic, level: r.level, sources },
      { includeBodies },
    );
    for (const s of sources) this.selectedSources.add(s.title);

    const card = host.createDiv({ cls: 'vantell-review-card' });
    const kchars = Math.max(1, Math.round(prompt.length / 1000));
    const which = topicMatched
      ? `${sources.length} note${sources.length === 1 ? '' : 's'} related to this topic`
      : `your ${sources.length} most recent shareable notes`;
    card.createEl('p', {
      text: includeBodies
        ? `Self-contained prompt (${which}, condensed, ~${kchars}k chars) — for a Claude that can't open your vault. Paste it in, then paste the answer above.`
        : `Points your Claude at ${which} in your vault and lets it read them itself — best when your Claude can open this folder (Claude Code here, or the folder attached). Paste it in, then paste the answer above.`,
    });
    const pre = card.createEl('textarea', { cls: 'vantell-answer' });
    pre.rows = 7;
    pre.value = prompt;
    pre.readOnly = true;

    const row = new Setting(card);
    row.addButton((b) =>
      b
        .setButtonText('Copy prompt')
        .setCta()
        .onClick(async () => {
          try {
            await navigator.clipboard.writeText(prompt);
            new Notice('Prompt copied — paste it into your Claude.');
          } catch {
            pre.focus();
            pre.select();
            new Notice('Select the text above and copy it (⌘/Ctrl-C).');
          }
        }),
    );
    row.addButton((b) =>
      b.setButtonText('Open claude.ai').onClick(() => window.open('https://claude.ai/new', '_blank')),
    );
    row.addButton((b) =>
      b
        .setButtonText(includeBodies ? 'Use paths only' : "Include note text (can't open vault)")
        .onClick(() => void this.buildPrompt(r, !includeBodies)),
    );
  }

  private async draft(r: IncomingRequest, ta: HTMLTextAreaElement): Promise<void> {
    if (this.busy) return;
    // Loud, one-time opt-in: drafting is the one path that sends note CONTENT
    // off the device (to the owner's own Anthropic account).
    if (!this.plugin.data.aiDraftConsented) {
      const ok = await new ConfirmModal(
        this.app,
        'Enable automatic drafting on this device?',
        [
          'Automatic drafting sends the text of your shareable notes for this topic ' +
            'to your own Anthropic account (using your API key) to compose a draft. ' +
            'Nothing is sent to the person who asked until you review and click Send.',
          'Only notes you already made shareable are ever included — never locked, private, or unchosen notes.',
        ],
        'Enable drafting',
      ).ask();
      if (!ok) return;
      this.plugin.data.aiDraftConsented = true;
      await this.plugin.saveData(this.plugin.data);
    }
    this.busy = true;
    const notice = new Notice('Drafting from your notes…', 0);
    try {
      const { notes, topicMatched } = await (this.gatherPromise ??
        gatherDraftSources(this.app, r.topic));
      const text = await draftAnswer(this.app, this.plugin.data.aiModel, {
        question: r.question,
        topic: r.topic,
        level: r.level,
        sources: notes,
      });
      ta.value = text;
      this.summary = text;
      // The notes that informed the draft are the natural source list.
      for (const s of notes) this.selectedSources.add(s.title);
      // The record of exactly what left: the same `notes` array the API call
      // used, not a regathered list.
      this.sentRecordEl?.setText(
        `Sent to your Anthropic account for this draft` +
          `${topicMatched ? '' : ' (nothing matched the topic — used your most recent shareable notes)'}: ` +
          notes.map((s) => s.title).join(' · '),
      );
      new Notice('Draft ready — review and edit before sending. Nothing was sent to the asker yet.');
    } catch (err) {
      new Notice(
        err instanceof AiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Drafting failed.',
      );
    } finally {
      notice.hide();
      this.busy = false;
    }
  }

  private async send(): Promise<void> {
    if (this.busy) return;
    const summary = this.summary.trim();
    if (!summary) {
      new Notice('Write the answer first — nothing is sent otherwise.');
      return;
    }
    const ident = loadIdentity(this.app);
    if (!ident?.did) {
      new Notice('This device is not linked.');
      return;
    }
    this.busy = true;
    try {
      const r = this.request;
      const answer = {
        knock: '0.1',
        type: 'answer',
        in_reply_to: r.envelopeId,
        knock_id: r.knockId,
        from: ident.did,
        to: r.fromDid,
        topic: r.topic,
        level: r.level,
        status: 'answered',
        summary,
        sources: [...this.selectedSources],
        answered_at: new Date().toISOString(),
      };
      // Answers are sealed to the asker's published key (registry row —
      // includes cross-org circle members). Unsealed answers are never
      // sent; if the key can't be resolved, the answer stays here.
      let askerPubkey: string | null = null;
      try {
        const reg = await signedGet<{ manifests: { did?: string; pubkey?: string }[] }>(
          ident,
          this.plugin.device.apiBase,
          '/v1/registry',
        );
        askerPubkey =
          (reg.manifests ?? []).find((m) => m.did === r.fromDid)?.pubkey ?? null;
      } catch {
        askerPubkey = null;
      }
      if (!askerPubkey) {
        new Notice(
          "Could not resolve the asker's key, so this answer can't be sealed — nothing was " +
            'sent. Try again in a moment.',
        );
        this.busy = false;
        return;
      }
      await signedPost(ident, this.plugin.device.apiBase, '/v1/envelope', {
        to: r.fromDid,
        ...encodeEnvelope(answer, askerPubkey),
      });
      this.plugin.device.handledEnvelopes.push(r.envelopeId);
      this.plugin.device.pendingEnvelopes = this.plugin.device.pendingEnvelopes.filter(
        (p) => p.id !== r.envelopeId,
      );
      // Keep the owner's own half of the conversation (device-local, L-DEVICE)
      // so the panel can show a thread instead of a one-sided inbox.
      this.plugin.device.sentAnswers = [
        {
          toDid: r.fromDid,
          toName: r.fromName,
          topic: r.topic,
          summary,
          sources: [...this.selectedSources],
          at: answer.answered_at,
          question: r.question,
          questionAt: r.createdAt,
        },
        ...this.plugin.device.sentAnswers,
      ].slice(0, 50);
      this.plugin.saveDevice();
      // Drop the answered request from the live list + panel immediately, so it
      // doesn't linger until the next poll.
      this.plugin.lastRequests = this.plugin.lastRequests.filter(
        (x) => x.envelopeId !== r.envelopeId,
      );
      this.plugin.setRequestCount(this.plugin.lastRequests.length);
      this.plugin.refreshPanel();
      new Notice(`Answer sent to ${r.fromName}. Your notes stayed here — only your words left.`);
      this.close();
    } catch (err) {
      new Notice(err instanceof Error ? err.message : 'Sending failed — try again.');
    } finally {
      this.busy = false;
    }
  }
}
