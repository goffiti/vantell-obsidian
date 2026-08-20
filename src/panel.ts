/**
 * The Vantell side panel — the mesh as a conversation list.
 *
 * One row per person on your mesh (WhatsApp-shaped): avatar, name, the last
 * thing that passed between you, and a badge when they're waiting on you.
 * Opening a row expands the thread in place — their questions and answers on
 * the left, yours on the right, oldest first — with a composer at the foot
 * for the next knock.
 *
 * QUARANTINE RULE (build-spec Rule 1): every remote string here — questions,
 * answers, names, topics, "about" blurbs — is rendered inert as text, never
 * HTML. Nothing on this screen is written into the vault.
 *
 * Read-mostly: it renders device-local state (the last poll + the outbox) and
 * fetches the registry fresh. The only thing it SENDS is a knock the owner
 * typed and submitted; answering still goes through ComposeAnswerModal,
 * where the source picking and drafting live.
 */
import { ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import { signedGet } from './api';
import { loadIdentity } from './identity';
import { ComposeAnswerModal, respondToKnock, type IncomingRequest } from './inbox';
import { KnockComposerModal, sendKnock } from './knock';
import type { ReceivedAnswer, SentAnswer, SentKnock } from './data';
import type VantellPlugin from './main';

export const VANTELL_VIEW = 'vantell-panel';

interface Brain {
  did: string;
  name: string;
  topics: string[];
  /** Reached through the owner's circles (cross-org) rather than the org. */
  viaCircles: string[];
  /** Owner-written "what you can ask me" blurb from their manifest. */
  about: string;
  /** Their device-published key — what a knock is sealed to. '' = not live. */
  pubkey: string;
}

/** One line in a thread. `at` is epoch ms so ordering never depends on the
 * string format a remote sender happened to use. */
type ThreadEvent =
  | { at: number; dir: 'in'; kind: 'question'; request: IncomingRequest }
  | { at: number; dir: 'in'; kind: 'question'; answered: string; topic: string | null }
  | { at: number; dir: 'out'; kind: 'question'; knock: SentKnock }
  | { at: number; dir: 'in'; kind: 'answer'; answer: ReceivedAnswer }
  | { at: number; dir: 'out'; kind: 'answer'; answer: SentAnswer };

interface Conversation {
  /** Stable across renders: the DID when we have one, else the name. */
  key: string;
  did: string | null;
  name: string;
  brain: Brain | null;
  events: ThreadEvent[];
  lastAt: number;
  /** Knocks of theirs that are waiting on you — the unread badge. */
  needsAction: number;
}

interface Draft {
  q: string;
  p: string;
  t: string;
}

const SVG = 'http://www.w3.org/2000/svg';
function svgEl<K extends keyof SVGElementTagNameMap>(
  parent: Element,
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.appendChild(e);
  return e;
}

function ms(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** WhatsApp-style relative stamp: coarse and short, never a full date until
 * it stops being "recent". */
function ago(at: number): string {
  if (!at) return '';
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(at).toLocaleDateString();
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '?';
  const second = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + second).toUpperCase();
}

/** Deterministic avatar tint (6 buckets, defined in styles.css) — same person,
 * same colour, every session. */
function hue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 6;
}

export class VantellView extends ItemView {
  private brains: Brain[] = [];
  private brainsLoaded = false;
  private fetchToken = 0;
  /** Conversation keys whose thread is open. Survives re-renders. */
  private expanded = new Set<string>();
  /** Half-typed knocks, per conversation — a background poll must never eat
   * what the owner is writing. */
  private drafts = new Map<string, Draft>();
  /** Conversations with a knock in flight. Lives on the view, not on a button
   * a repaint would replace — otherwise a slow POST plus a poll gives you two
   * enabled send buttons and one question sent twice. */
  private sending = new Set<string>();
  /** Row to scroll into view after the next paint (mesh-map clicks). */
  private revealKey: string | null = null;
  private showMesh = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: VantellPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VANTELL_VIEW;
  }
  getDisplayText(): string {
    return 'Vantell';
  }
  getIcon(): string {
    return 'radio';
  }

  override async onOpen(): Promise<void> {
    await this.render();
  }

  /** Paint from what we already have, then refresh the registry in the
   * background. Painting first means a 2-minute poll never blanks the panel
   * while the network is slow. */
  async render(): Promise<void> {
    this.paint();
    await this.refreshBrains();
  }

  private async refreshBrains(): Promise<void> {
    const ident = loadIdentity(this.plugin.app);
    if (!ident?.did) return;
    const token = ++this.fetchToken;
    let next: Brain[];
    try {
      const reg = await signedGet<{
        manifests: {
          did?: string;
          display_name?: string;
          topics?: { label?: string }[];
          via_circles?: string[];
          about?: string;
          pubkey?: string;
        }[];
      }>(ident, this.plugin.device.apiBase, '/v1/registry');
      next = (reg.manifests ?? [])
        .filter((m) => m.did && m.did !== ident.did)
        .map((m) => ({
          did: m.did!,
          name: m.display_name || (m.did!.split(':').pop() ?? m.did!),
          topics: (m.topics ?? []).map((t) => t.label ?? '').filter(Boolean),
          viaCircles: (m.via_circles ?? []).filter((c): c is string => typeof c === 'string'),
          about: typeof m.about === 'string' ? m.about : '',
          pubkey: typeof m.pubkey === 'string' ? m.pubkey : '',
        }));
    } catch {
      return; // offline — keep the brains (and the panel) we already drew
    }
    // A newer fetch started while we awaited — that one owns the state now.
    if (token !== this.fetchToken) return;
    const changed = !this.brainsLoaded || JSON.stringify(next) !== JSON.stringify(this.brains);
    this.brains = next;
    this.brainsLoaded = true;
    if (changed) this.paint();
  }

  /* ------------------------------------------------------------- painting */

  private paint(): void {
    const el = this.contentEl;
    // Keep the caret where it was: a background poll repaints the whole
    // panel, and losing focus mid-sentence would be the worst kind of bug.
    // `ownerDocument`, not the global `document` — a popped-out leaf lives in
    // its own window, and duck-typing beats `instanceof` across windows.
    const focused = el.ownerDocument.activeElement;
    const inPanel = Boolean(focused && el.contains(focused));
    const field = inPanel ? (focused as Partial<HTMLTextAreaElement>) : null;
    const focusKey = inPanel ? ((focused as HTMLElement).dataset['vantellField'] ?? null) : null;
    const selStart = typeof field?.selectionStart === 'number' ? field.selectionStart : null;
    const selEnd = typeof field?.selectionEnd === 'number' ? field.selectionEnd : null;
    const scroll = el.scrollTop;

    el.empty();
    el.addClass('vantell-panel');

    const ident = loadIdentity(this.plugin.app);
    this.renderHeader(el, Boolean(ident?.did));
    if (!ident?.did) {
      el.createEl('p', {
        cls: 'vantell-sub',
        text: 'Link this vault to your Vantell account to see your mesh here.',
      });
      const setup = el.createEl('button', { cls: 'mod-cta', text: 'Set up Vantell' });
      setup.onclick = () => this.plugin.openSetup();
      return;
    }

    if (this.showMesh && this.brains.length > 0) this.drawConstellation(el);

    const convos = this.buildConversations();
    if (convos.length === 0) {
      el.createEl('p', {
        cls: 'vantell-sub',
        text: this.brainsLoaded
          ? "No colleagues on your org's mesh yet — you're the first."
          : 'Loading your mesh…',
      });
      return;
    }
    const list = el.createDiv({ cls: 'vantell-chats' });
    for (const c of convos) this.renderConversation(list, c);

    el.scrollTop = scroll;
    if (focusKey) {
      // CSS.escape: the key is a registry-supplied DID or display name, and an
      // unescaped quote in a selector throws out of paint() entirely.
      const again = el.querySelector<HTMLElement>(
        `[data-vantell-field="${CSS.escape(focusKey)}"]`,
      );
      if (again) {
        again.focus();
        // Duck-typed on purpose: the dropdown carries the same marker but has
        // no selection to restore, and `instanceof` is unsafe across windows.
        const back = again as Partial<HTMLTextAreaElement>;
        if (typeof back.setSelectionRange === 'function' && selStart !== null) {
          back.setSelectionRange(selStart, selEnd ?? selStart);
        }
      }
    }
    // A row opened from the mesh map can sit far below the fold; without this
    // the click reads as a no-op.
    if (this.revealKey) {
      const row = el.querySelector<HTMLElement>(`[data-vantell-row="${CSS.escape(this.revealKey)}"]`);
      this.revealKey = null;
      row?.scrollIntoView({ block: 'nearest' });
    }
  }

  private renderHeader(el: HTMLElement, linked: boolean): void {
    const header = el.createDiv({ cls: 'vantell-panel-header' });
    const titleRow = header.createDiv({ cls: 'vantell-panel-titlerow' });
    titleRow.createEl('h2', { text: 'Vantell' });
    const last = this.plugin.data.lastPublished;
    titleRow.createSpan({
      cls: 'vantell-panel-status',
      text: linked
        ? last
          ? `live · ${last.topics.length} topic${last.topics.length === 1 ? '' : 's'}`
          : 'linked'
        : 'not linked',
    });
    if (!linked) return;

    const actions = header.createDiv({ cls: 'vantell-panel-actions' });
    const knockBtn = actions.createEl('button', { cls: 'mod-cta' });
    setIcon(knockBtn.createSpan(), 'send');
    knockBtn.createSpan({ text: ' Knock' });
    knockBtn.onclick = () => new KnockComposerModal(this.plugin.app, this.plugin).open();

    const refreshBtn = actions.createEl('button', { attr: { 'aria-label': 'Refresh' } });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.onclick = () => void this.plugin.pollInbox(false);

    const meshBtn = actions.createEl('button', {
      cls: this.showMesh ? 'is-active' : '',
      attr: { 'aria-label': this.showMesh ? 'Hide the mesh map' : 'Show the mesh map' },
    });
    setIcon(meshBtn, 'git-fork');
    meshBtn.onclick = () => {
      this.showMesh = !this.showMesh;
      this.paint();
    };

    const portalBtn = actions.createEl('button', { attr: { 'aria-label': 'Open your dashboard' } });
    setIcon(portalBtn, 'external-link');
    portalBtn.onclick = () => window.open('https://app.vantell.ai/', '_blank');
  }

  /* --------------------------------------------------------- conversations */

  /** Fold the registry, the open requests and both outboxes into one thread
   * per person. Threading is by DID; pre-0.11 answers carry no DID, so they
   * fall back to a name lookup and, failing that, get their own row rather
   * than being silently dropped. */
  private buildConversations(): Conversation[] {
    const byKey = new Map<string, Conversation>();
    const didByName = new Map<string, string>();

    const remember = (name: string, did: string): void => {
      const k = name.trim().toLowerCase();
      if (k && !didByName.has(k)) didByName.set(k, did);
    };
    for (const b of this.brains) remember(b.name, b.did);
    for (const k of this.plugin.device.sentKnocks) remember(k.toName, k.toDid);
    for (const a of this.plugin.device.sentAnswers) remember(a.toName, a.toDid);
    for (const r of this.plugin.lastRequests) remember(r.fromName, r.fromDid);
    // respondToKnock flips consent in place and repaints, so a just-declined
    // question would otherwise linger in the thread until the next poll —
    // captioned as if it were a legacy knock. Declining means gone, now.
    const open = this.plugin.lastRequests.filter((r) => r.consent !== 'denied');

    const brainByDid = new Map(this.brains.map((b) => [b.did, b]));
    const convo = (did: string | null, name: string): Conversation => {
      const key = did ?? `name:${name.trim().toLowerCase()}`;
      let c = byKey.get(key);
      if (!c) {
        const brain = did ? (brainByDid.get(did) ?? null) : null;
        c = {
          key,
          did,
          name: brain?.name ?? name,
          brain,
          events: [],
          lastAt: 0,
          needsAction: 0,
        };
        byKey.set(key, c);
      }
      return c;
    };

    for (const b of this.brains) convo(b.did, b.name);

    for (const r of open) {
      const c = convo(r.fromDid, r.fromName);
      c.events.push({ at: ms(r.createdAt), dir: 'in', kind: 'question', request: r });
      // Everything still open counts, including 'unchecked' and 'unknown':
      // a real question sitting there with no badge is the worse failure.
      c.needsAction++;
    }
    for (const k of this.plugin.device.sentKnocks) {
      const c = convo(k.toDid, k.toName);
      c.events.push({ at: ms(k.at), dir: 'out', kind: 'question', knock: k });
    }
    for (const a of this.plugin.device.sentAnswers) {
      const c = convo(a.toDid, a.toName);
      if (a.question) {
        c.events.push({
          at: ms(a.questionAt) || ms(a.at) - 1,
          dir: 'in',
          kind: 'question',
          answered: a.question,
          topic: a.topic,
        });
      }
      c.events.push({ at: ms(a.at), dir: 'out', kind: 'answer', answer: a });
    }
    for (const a of this.plugin.device.receivedAnswers) {
      const did = a.fromDid ?? didByName.get(a.fromName.trim().toLowerCase()) ?? null;
      const c = convo(did, a.fromName);
      c.events.push({ at: ms(a.at), dir: 'in', kind: 'answer', answer: a });
    }

    const all = [...byKey.values()];
    for (const c of all) {
      c.events.sort((x, y) => x.at - y.at);
      c.lastAt = c.events.length ? (c.events[c.events.length - 1]!.at ?? 0) : 0;
    }
    // Recency first (a mesh reads like a chat list); people you've never
    // spoken to sit underneath, alphabetically, as the "who could I ask" list.
    return all.sort((a, b) => {
      if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
      return a.name.localeCompare(b.name);
    });
  }

  private preview(c: Conversation): string {
    const last = c.events[c.events.length - 1];
    if (!last) {
      if (c.brain && c.brain.topics.length > 0) return c.brain.topics.slice(0, 4).join(' · ');
      return 'No messages yet — ask them something.';
    }
    if (last.dir === 'out') {
      const text = last.kind === 'question' ? last.knock.question : last.answer.summary;
      return `You: ${text}`;
    }
    if (last.kind === 'answer') return last.answer.summary;
    return 'request' in last ? last.request.question : last.answered;
  }

  private renderConversation(list: HTMLElement, c: Conversation): void {
    const open = this.expanded.has(c.key);
    const wrap = list.createDiv({
      cls: `vantell-chat${open ? ' is-open' : ''}${c.needsAction ? ' is-waiting' : ''}`,
    });

    const row = wrap.createDiv({
      cls: 'vantell-chat-row',
      attr: { role: 'button', tabindex: '0', 'data-vantell-row': c.key },
    });
    row.createDiv({ cls: `vantell-avatar is-h${hue(c.key)}`, text: initials(c.name) });
    const main = row.createDiv({ cls: 'vantell-chat-main' });
    const top = main.createDiv({ cls: 'vantell-chat-top' });
    top.createSpan({ cls: 'vantell-chat-name', text: c.name });
    top.createSpan({ cls: 'vantell-chat-time', text: ago(c.lastAt) });
    main.createDiv({ cls: 'vantell-chat-preview', text: this.preview(c) });
    if (c.needsAction > 0) {
      row.createSpan({
        cls: 'vantell-badge',
        text: String(c.needsAction),
        attr: { 'aria-label': `${c.needsAction} waiting for you` },
      });
    }
    const toggle = (): void => {
      if (this.expanded.has(c.key)) this.expanded.delete(c.key);
      else this.expanded.add(c.key);
      this.paint();
    };
    row.onclick = toggle;
    row.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    };

    if (!open) return;
    const thread = wrap.createDiv({ cls: 'vantell-thread' });
    if (c.brain?.about) {
      // Remote-authored text: inert, per the quarantine rule.
      thread.createDiv({ cls: 'vantell-thread-about', text: c.brain.about });
    }
    if (c.brain && c.brain.topics.length > 0) {
      const chips = thread.createDiv({ cls: 'vantell-chips' });
      for (const t of c.brain.topics.slice(0, 8)) chips.createSpan({ cls: 'vantell-chip', text: t });
      for (const v of c.brain.viaCircles.slice(0, 2)) {
        chips.createSpan({
          cls: 'vantell-chip',
          text: `◦ ${v}`,
          title: `In your circle '${v}' — outside your org`,
        });
      }
    }
    if (c.events.length === 0) {
      thread.createDiv({
        cls: 'vantell-sub',
        text: 'Nothing between you yet. Your question goes to them for approval first.',
      });
    }
    for (const ev of c.events) this.renderEvent(thread, ev);
    this.renderComposer(thread, c);
  }

  private renderEvent(thread: HTMLElement, ev: ThreadEvent): void {
    const b = thread.createDiv({ cls: `vantell-bubble is-${ev.dir}` });
    if (ev.kind === 'question' && 'request' in ev) {
      const r = ev.request;
      b.createDiv({
        cls: 'vantell-bubble-meta',
        text: [r.topic, r.level !== null ? `L${r.level}` : '', ago(ev.at)]
          .filter(Boolean)
          .join(' · '),
      });
      b.createDiv({ cls: 'vantell-bubble-text', text: r.question });
      this.renderRequestActions(b, r);
      return;
    }
    if (ev.kind === 'question' && 'answered' in ev) {
      b.createDiv({
        cls: 'vantell-bubble-meta',
        text: [ev.topic, ago(ev.at)].filter(Boolean).join(' · '),
      });
      b.createDiv({ cls: 'vantell-bubble-text', text: ev.answered });
      return;
    }
    if (ev.kind === 'question') {
      const k = ev.knock;
      b.createDiv({
        cls: 'vantell-bubble-meta',
        text: [k.topic, ago(ev.at)].filter(Boolean).join(' · '),
      });
      b.createDiv({ cls: 'vantell-bubble-text', text: k.question });
      b.createDiv({
        cls: `vantell-bubble-foot${k.status === 'answered' ? ' is-answered' : ''}`,
        text: k.status === 'answered' ? '✓ answered' : 'waiting for their yes',
      });
      return;
    }
    const a = ev.answer;
    b.createDiv({
      cls: 'vantell-bubble-meta',
      text: [a.topic, ago(ev.at)].filter(Boolean).join(' · '),
    });
    b.createDiv({ cls: 'vantell-bubble-text', text: a.summary });
    const sources = a.sources ?? [];
    if (sources.length > 0) {
      b.createDiv({
        cls: 'vantell-bubble-foot',
        text:
          ev.dir === 'in'
            ? `From their notes: ${sources.join(' · ')}`
            : `Titles you listed: ${sources.join(' · ')}`,
      });
    }
  }

  private renderRequestActions(b: HTMLElement, r: IncomingRequest): void {
    if (r.consent === 'approved') {
      const row = b.createDiv({ cls: 'vantell-bubble-actions' });
      const answer = row.createEl('button', { cls: 'mod-cta', text: 'Answer' });
      answer.onclick = () => new ComposeAnswerModal(this.plugin.app, this.plugin, r).open();
      return;
    }
    if (r.consent === 'pending' && r.knockId) {
      // "Keep allowing" (standing consent, v0.10): skips only the future
      // approval WAIT for this person — the owner still writes every answer.
      const keep = b.createEl('label', { cls: 'vantell-keep-allowing' });
      const tick = keep.createEl('input', { type: 'checkbox' });
      keep.appendText(` Keep allowing ${r.fromName} (up to L3, revocable)`);
      const row = b.createDiv({ cls: 'vantell-bubble-actions' });
      const yes = row.createEl('button', { cls: 'mod-cta', text: 'Approve & answer' });
      yes.onclick = async () => {
        if (await respondToKnock(this.plugin, r, 'approve', tick.checked)) {
          new ComposeAnswerModal(this.plugin.app, this.plugin, r).open();
        }
      };
      const no = row.createEl('button', { text: 'Decline' });
      no.onclick = async () => {
        if (await respondToKnock(this.plugin, r, 'deny')) {
          new Notice('Declined.');
          this.paint();
        }
      };
      return;
    }
    if (r.consent === 'pending') {
      const row = b.createDiv({ cls: 'vantell-bubble-actions' });
      const open = row.createEl('button', { text: 'Approve on dashboard' });
      open.onclick = () => window.open('https://app.vantell.ai/knocks', '_blank');
      return;
    }
    if (r.consent === 'unchecked') {
      // The relay never answered this poll. Nothing is wrong with the knock —
      // we just don't know yet, and saying more would be a guess.
      b.createDiv({
        cls: 'vantell-bubble-foot',
        text: "Couldn't reach the consent check just now — this question is intact, its state isn't known yet.",
      });
      const row = b.createDiv({ cls: 'vantell-bubble-actions' });
      const retry = row.createEl('button', { text: 'Check again' });
      retry.onclick = async () => {
        retry.disabled = true;
        retry.setText('Checking…');
        await this.plugin.pollInbox(false);
        // pollInbox swallows every error, so without this the button is a
        // visible no-op whenever the relay is still unreachable.
        const now = this.plugin.lastRequests.find((x) => x.envelopeId === r.envelopeId);
        if (now?.consent === 'unchecked') {
          new Notice("Still couldn't reach the consent check — the question is safe here.");
        }
        this.paint();
      };
      return;
    }
    b.createDiv({
      cls: 'vantell-bubble-foot',
      text: 'Sent before consent tracking covered it — ask them to re-send.',
    });
  }

  /* ------------------------------------------------------------ composer */

  private renderComposer(thread: HTMLElement, c: Conversation): void {
    const box = thread.createDiv({ cls: 'vantell-composer' });
    if (!c.did || !c.brain) {
      box.createDiv({
        cls: 'vantell-sub',
        text: "They're not on your mesh right now — this is the history you already have.",
      });
      return;
    }
    if (!c.brain.pubkey) {
      box.createDiv({
        cls: 'vantell-sub',
        text: `${c.name} hasn't finished device setup, so nothing can be sealed to them yet.`,
      });
      return;
    }
    const draft = this.drafts.get(c.key) ?? { q: '', p: '', t: '' };
    this.drafts.set(c.key, draft);

    const q = box.createEl('textarea', {
      cls: 'vantell-composer-q',
      attr: { 'data-vantell-field': `q:${c.key}`, rows: '2' },
    });
    q.placeholder = `Ask ${c.name} something…`;
    q.value = draft.q;
    q.addEventListener('input', () => (draft.q = q.value));

    const p = box.createEl('input', {
      type: 'text',
      cls: 'vantell-composer-p',
      attr: { 'data-vantell-field': `p:${c.key}` },
    });
    p.placeholder = 'Why you’re asking — they see this';
    p.value = draft.p;
    p.addEventListener('input', () => (draft.p = p.value));

    const row = box.createDiv({ cls: 'vantell-composer-row' });
    if (c.brain.topics.length > 0) {
      const sel = row.createEl('select', {
        cls: 'dropdown vantell-composer-topic',
        attr: { 'data-vantell-field': `t:${c.key}` },
      });
      sel.createEl('option', { value: '', text: 'No topic' });
      for (const t of c.brain.topics) sel.createEl('option', { value: t, text: t });
      sel.value = draft.t;
      sel.addEventListener('change', () => (draft.t = sel.value));
    }
    const inFlight = this.sending.has(c.key);
    const send = row.createEl('button', { cls: 'mod-cta vantell-composer-send' });
    setIcon(send.createSpan(), 'send');
    send.createSpan({ text: inFlight ? ' Sending…' : ' Knock' });
    send.disabled = inFlight;
    const submit = (): void => void this.submit(c, draft);
    send.onclick = submit;
    // ⌘/Ctrl-Enter sends from either field; plain Enter stays a newline, so a
    // half-written question can never leave by accident.
    const hotkey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    };
    q.addEventListener('keydown', hotkey);
    p.addEventListener('keydown', hotkey);
    box.createDiv({
      cls: 'vantell-fineprint',
      text: 'Only your question and purpose are sent — never your notes. They approve first, unless they chose to keep allowing you.',
    });
  }

  private async submit(c: Conversation, draft: Draft): Promise<void> {
    if (this.sending.has(c.key)) return;
    if (!draft.q.trim()) {
      new Notice('Write your question first.');
      return;
    }
    if (!draft.p.trim()) {
      new Notice('Add a purpose — it’s required, and it’s what they see first.');
      return;
    }
    this.sending.add(c.key);
    this.paint();
    try {
      const ok = await sendKnock(this.plugin, {
        toDid: c.did!,
        toName: c.name,
        toPubkey: c.brain?.pubkey ?? '',
        topic: draft.t || null,
        question: draft.q,
        purpose: draft.p,
      });
      if (!ok) return;
      this.drafts.set(c.key, { q: '', p: '', t: draft.t });
      new Notice(`Knock sent to ${c.name}. You'll be notified here if they answer.`);
    } finally {
      this.sending.delete(c.key);
      this.paint();
    }
  }

  /* ----------------------------------------------------------- mesh map */

  /** A light constellation: you at the centre, brains on a ring, node size by
   * topic count. Decoration behind the header toggle — clicking a node opens
   * that person's thread. */
  private drawConstellation(parent: HTMLElement): void {
    const n = this.brains.length;
    const W = 280;
    const H = Math.min(240, 120 + n * 8);
    const cx = W / 2;
    const cy = H / 2;
    const ring = Math.min(W, H) / 2 - 34;
    const wrap = parent.createDiv({ cls: 'vantell-constellation' });
    const svg = svgEl(wrap, 'svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H });

    // edges first
    this.brains.forEach((_b, i) => {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      const x = cx + ring * Math.cos(a);
      const y = cy + ring * Math.sin(a);
      svgEl(svg, 'line', { x1: cx, y1: cy, x2: x, y2: y, class: 'vc-edge' });
    });
    // centre = you
    svgEl(svg, 'circle', { cx, cy, r: 16, class: 'vc-self' });
    const meLabel = svgEl(svg, 'text', { x: cx, y: cy + 4, class: 'vc-self-label' });
    meLabel.textContent = 'you';
    // brain nodes
    this.brains.forEach((b, i) => {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      const x = cx + ring * Math.cos(a);
      const y = cy + ring * Math.sin(a);
      const r = 7 + Math.min(6, b.topics.length);
      const node = svgEl(svg, 'circle', { cx: x, cy: y, r, class: 'vc-node' });
      node.addEventListener('click', () => {
        this.expanded.add(b.did);
        this.revealKey = b.did;
        this.paint();
      });
      const t = svgEl(svg, 'title', {});
      t.textContent = `${b.name}${b.topics.length ? ` — ${b.topics.join(', ')}` : ''}`;
      // short label
      const lx = x + (Math.cos(a) >= 0 ? r + 4 : -(r + 4));
      const lbl = svgEl(svg, 'text', {
        x: lx,
        y: y + 3,
        class: 'vc-label',
        'text-anchor': Math.cos(a) >= 0 ? 'start' : 'end',
      });
      lbl.textContent = b.name.length > 12 ? b.name.slice(0, 11) + '…' : b.name;
    });
  }
}
