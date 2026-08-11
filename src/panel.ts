/**
 * The Vantell side panel — a persistent, interactive home for the mesh:
 *   - connected brains (org registry) as a light constellation + cards
 *   - requests waiting for your answer
 *   - answers that came back to your knocks
 *   - the knocks you've sent
 *
 * Read-mostly: it renders plugin state (kept in data.json + the last poll)
 * and fetches the registry fresh. Actions (answer, knock) open the existing
 * modals. Nothing here sends anything on its own.
 */
import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { signedGet } from './api';
import { loadIdentity } from './identity';
import { ComposeAnswerModal, respondToKnock, type IncomingRequest } from './inbox';
import { Notice } from 'obsidian';
import { KnockComposerModal } from './knock';
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

export class VantellView extends ItemView {
  private brains: Brain[] = [];
  private renderToken = 0;

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

  async render(): Promise<void> {
    // Re-entrancy guard: render() awaits a network fetch, so two overlapping
    // calls could each empty() then append. Only the newest call may build.
    const token = ++this.renderToken;
    const el = this.contentEl;
    el.empty();
    el.addClass('vantell-panel');

    const ident = loadIdentity(this.plugin.app);
    // ---- header ----
    const header = el.createDiv({ cls: 'vantell-panel-header' });
    const titleRow = header.createDiv({ cls: 'vantell-panel-titlerow' });
    titleRow.createEl('h2', { text: 'Vantell' });
    const last = this.plugin.data.lastPublished;
    titleRow.createSpan({
      cls: 'vantell-panel-status',
      text: ident?.did
        ? last
          ? `live · ${last.topics.length} topic${last.topics.length === 1 ? '' : 's'}`
          : 'linked'
        : 'not linked',
    });
    const actions = header.createDiv({ cls: 'vantell-panel-actions' });
    const knockBtn = actions.createEl('button', { cls: 'mod-cta' });
    setIcon(knockBtn.createSpan(), 'send');
    knockBtn.createSpan({ text: ' Knock' });
    knockBtn.onclick = () => new KnockComposerModal(this.plugin.app, this.plugin).open();
    const refreshBtn = actions.createEl('button', { attr: { 'aria-label': 'Refresh' } });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.onclick = () => void this.plugin.pollInbox(false);
    const portalBtn = actions.createEl('button', { attr: { 'aria-label': 'Open your dashboard' } });
    setIcon(portalBtn.createSpan(), 'external-link');
    portalBtn.createSpan({ text: ' Dashboard' });
    portalBtn.onclick = () => window.open('https://app.vantell.ai/', '_blank');

    if (!ident?.did) {
      el.createEl('p', {
        cls: 'vantell-sub',
        text: 'Link this vault to your Vantell account to see your mesh here.',
      });
      const setup = el.createEl('button', { cls: 'mod-cta', text: 'Set up Vantell' });
      setup.onclick = () => this.plugin.openSetup();
      return;
    }

    // ---- connected brains ----
    try {
      const reg = await signedGet<{
        manifests: {
          did?: string;
          display_name?: string;
          topics?: { label?: string }[];
          via_circles?: string[];
          about?: string;
        }[];
      }>(ident, this.plugin.data.apiBase, '/v1/registry');
      this.brains = (reg.manifests ?? [])
        .filter((m) => m.did && m.did !== ident.did)
        .map((m) => ({
          did: m.did!,
          name: m.display_name || (m.did!.split(':').pop() ?? m.did!),
          topics: (m.topics ?? []).map((t) => t.label ?? '').filter(Boolean),
          viaCircles: (m.via_circles ?? []).filter((c): c is string => typeof c === 'string'),
          about: typeof m.about === 'string' ? m.about : '',
        }));
    } catch {
      /* keep last brains */
    }
    // A newer render started while we awaited — that one owns the DOM now.
    if (token !== this.renderToken) return;
    this.renderBrains(el);

    // ---- requests waiting ----
    const pending = this.plugin.lastRequests.filter((r) => r.consent !== 'denied');
    this.section(el, `Requests${pending.length ? ` (${pending.length})` : ''}`, (body) => {
      if (pending.length === 0) {
        body.createEl('p', { cls: 'vantell-sub', text: "No one's knocking right now." });
        return;
      }
      for (const r of pending) this.renderRequest(body, r);
    });

    // ---- answers to my knocks ----
    const answers = this.plugin.data.receivedAnswers;
    this.section(el, `Answers${answers.length ? ` (${answers.length})` : ''}`, (body) => {
      if (answers.length === 0) {
        body.createEl('p', { cls: 'vantell-sub', text: 'Answers to your knocks land here.' });
        return;
      }
      for (const a of answers.slice(0, 20)) {
        const card = body.createDiv({ cls: 'vantell-card' });
        card.createDiv({
          cls: 'vantell-card-head',
          text: `${a.fromName}${a.topic ? ` · ${a.topic}` : ''}`,
        });
        card.createEl('blockquote', { text: a.summary, cls: 'vantell-inert-quote' });
        if (a.sources && a.sources.length > 0) {
          card.createDiv({ cls: 'vantell-sub', text: `From their notes: ${a.sources.join(' · ')}` });
        }
      }
    });

    // ---- sent knocks ----
    const sent = this.plugin.data.sentKnocks;
    this.section(el, `Your knocks${sent.length ? ` (${sent.length})` : ''}`, (body) => {
      if (sent.length === 0) {
        body.createEl('p', { cls: 'vantell-sub', text: 'Knocks you send show here with their status.' });
        return;
      }
      for (const k of sent.slice(0, 20)) {
        const card = body.createDiv({ cls: 'vantell-card' });
        card.createDiv({
          cls: 'vantell-card-head',
          text: `${k.toName}${k.topic ? ` · ${k.topic}` : ''}`,
        });
        card.createDiv({ cls: 'vantell-sub', text: k.question });
        card.createSpan({
          cls: `vantell-chip ${k.status === 'answered' ? 'is-answered' : ''}`,
          text: k.status === 'answered' ? 'answered' : 'waiting',
        });
      }
    });
  }

  private section(parent: HTMLElement, title: string, build: (body: HTMLElement) => void): void {
    const sec = parent.createDiv({ cls: 'vantell-section' });
    sec.createEl('h3', { text: title });
    build(sec.createDiv({ cls: 'vantell-section-body' }));
  }

  private renderRequest(body: HTMLElement, r: IncomingRequest): void {
    const card = body.createDiv({ cls: 'vantell-card' });
    card.createDiv({
      cls: 'vantell-card-head',
      text: `${r.fromName}${r.topic ? ` · ${r.topic}` : ''}${r.level !== null ? ` · L${r.level}` : ''}`,
    });
    card.createEl('blockquote', { text: r.question, cls: 'vantell-inert-quote' });
    const row = card.createDiv({ cls: 'vantell-card-actions' });
    if (r.consent === 'approved') {
      const b = row.createEl('button', { cls: 'mod-cta', text: 'Answer' });
      b.onclick = () => new ComposeAnswerModal(this.plugin.app, this.plugin, r).open();
    } else if (r.consent === 'pending' && r.knockId) {
      const yes = row.createEl('button', { cls: 'mod-cta', text: 'Approve & answer' });
      yes.onclick = async () => {
        if (await respondToKnock(this.plugin, r, 'approve')) {
          new ComposeAnswerModal(this.plugin.app, this.plugin, r).open();
        }
      };
      const no = row.createEl('button', { text: 'Decline' });
      no.onclick = async () => {
        if (await respondToKnock(this.plugin, r, 'deny')) {
          new Notice('Declined.');
          void this.render();
        }
      };
    } else if (r.consent === 'pending') {
      const b = row.createEl('button', { text: 'Approve on dashboard' });
      b.onclick = () => window.open('https://app.vantell.ai/knocks', '_blank');
    } else {
      row.createSpan({ cls: 'vantell-sub', text: 'No matching consent found.' });
    }
  }

  private renderBrains(parent: HTMLElement): void {
    this.section(parent, `Connected brains${this.brains.length ? ` (${this.brains.length})` : ''}`, (body) => {
      if (this.brains.length === 0) {
        body.createEl('p', {
          cls: 'vantell-sub',
          text: "No colleagues on your org's mesh yet — you're the first.",
        });
        return;
      }
      this.drawConstellation(body);
      const grid = body.createDiv({ cls: 'vantell-brain-grid' });
      for (const b of this.brains) {
        const card = grid.createDiv({ cls: 'vantell-brain-card' });
        const head = card.createDiv({ cls: 'vantell-brain-head' });
        head.createSpan({ cls: 'vantell-brain-dot' });
        head.createSpan({ cls: 'vantell-brain-name', text: b.name });
        // Remote-authored text: rendered inert via text, per the quarantine rule.
        if (b.about) card.createDiv({ cls: 'vantell-sub', text: b.about });
        const chips = card.createDiv({ cls: 'vantell-chips' });
        for (const t of b.topics.slice(0, 6)) chips.createSpan({ cls: 'vantell-chip', text: t });
        for (const c of b.viaCircles.slice(0, 2)) {
          chips.createSpan({
            cls: 'vantell-chip',
            text: `◦ ${c}`,
            title: `In your circle '${c}' — outside your org`,
          });
        }
        if (b.topics.length === 0) {
          chips.createSpan({ cls: 'vantell-sub', text: 'enrolled — nothing published yet' });
        }
        const kn = card.createEl('button', { cls: 'vantell-brain-knock', text: 'Knock' });
        kn.onclick = () => new KnockComposerModal(this.plugin.app, this.plugin, b.did).open();
      }
    });
  }

  /** A light constellation: you at the centre, brains on a ring, node size by
   * topic count. Pure decoration — clicking a node opens a knock to it. */
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
      node.addEventListener('click', () =>
        new KnockComposerModal(this.plugin.app, this.plugin, b.did).open(),
      );
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
