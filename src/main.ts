/**
 * Vantell for Obsidian — share what you know, never your notes.
 *
 * Mobile-safe by construction: no Node or Electron imports anywhere in
 * src/ (esbuild marks them external so an accidental import fails fast),
 * network via requestUrl, keys in device-local storage.
 */
import { Notice, Plugin, TFile } from 'obsidian';
import { diffAgainst, scanVault, summarize } from './publish';
import { loadIdentity } from './identity';
import { RequestsModal, checkInbox, type IncomingRequest } from './inbox';
import { AnswerModal, AnswersListModal, KnockComposerModal } from './knock';
import { noteShareState, shareNote, stopSharingNote } from './noteShare';
import { VANTELL_VIEW, VantellView } from './panel';
import {
  DEFAULT_DATA,
  DEFAULT_DEVICE,
  migrateLegacyData,
  type DeviceState,
  type VantellData,
} from './data';
import { loadLocalJson, saveLocalJson } from './identity';
import { VantellSettingTab } from './settings';
import { UninstallModal } from './uninstall';
import { SetupWizard } from './wizard';

const INBOX_POLL_MS = 2 * 60 * 1000;

const DEVICE_STORE_KEY = 'vantell-device-state';

export default class VantellPlugin extends Plugin {
  data: VantellData = { ...DEFAULT_DATA };
  /** L-DEVICE mesh state — device-local, never in the synced vault. */
  device: DeviceState = { ...DEFAULT_DEVICE };
  private statusEl: HTMLElement | null = null;
  private requestCount = 0;
  lastRequests: IncomingRequest[] = [];

  saveDevice(): void {
    saveLocalJson(this.app, DEVICE_STORE_KEY, this.device);
  }

  override async onload(): Promise<void> {
    const raw = ((await this.loadData()) as Record<string, unknown> | null) ?? {};
    this.data = { ...DEFAULT_DATA, ...(raw as Partial<VantellData>) };
    const stored = loadLocalJson(this.app, DEVICE_STORE_KEY);
    if (stored && typeof stored === 'object') {
      this.device = { ...DEFAULT_DEVICE, ...(stored as Partial<DeviceState>) };
    }
    // Pre-0.9.0 data.json carried the mesh (conversation content in a
    // vault-synced file — the exact leak doc/trust-architecture.md exists
    // to prevent). Lift it into the device store and rewrite data.json
    // without it, once.
    const migrated = migrateLegacyData(raw, this.device);
    if (migrated.hadLegacy) {
      this.device = migrated.device;
      this.saveDevice();
      this.data = { ...DEFAULT_DATA, displayName: this.data.displayName, lastPublished: this.data.lastPublished, aiModel: this.data.aiModel, aiDraftConsented: this.data.aiDraftConsented };
      await this.saveData(this.data);
    }

    this.addSettingTab(new VantellSettingTab(this.app, this));

    this.registerView(VANTELL_VIEW, (leaf) => new VantellView(leaf, this));
    this.addRibbonIcon('radio', 'Vantell', () => void this.activateView());
    this.addCommand({
      id: 'open-panel',
      name: 'Open the panel',
      callback: () => void this.activateView(),
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('vantell-status');
    this.statusEl.onClickEvent(() => {
      if (this.requestCount > 0) new RequestsModal(this.app, this, this.lastRequests).open();
      else void this.showStatus();
    });
    this.refreshStatusBar();

    // Presence: poll the inbox while Obsidian is open. First check shortly
    // after layout; then roughly every 2 minutes, JITTERED — a fixed-cadence
    // signed poll is a precise presence beacon (working hours, absence) for
    // anyone holding server logs; ±30s of jitter blurs the edges (P-D1).
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => void this.pollInbox(true), 3000);
      let nextPollAt = Date.now() + INBOX_POLL_MS + Math.random() * 30_000;
      this.registerInterval(
        window.setInterval(() => {
          if (Date.now() < nextPollAt) return;
          nextPollAt = Date.now() + INBOX_POLL_MS - 15_000 + Math.random() * 60_000;
          void this.pollInbox(false);
        }, 15_000),
      );
    });

    this.addCommand({
      id: 'setup',
      name: 'Set up / choose your folders',
      callback: () => new SetupWizard(this.app, this).open(),
    });

    this.addCommand({
      id: 'share-note-org',
      name: 'Share this note (whole org)',
      checkCallback: (checking) => this.withActiveFile(checking, (f) => shareNote(this.app, f, 'org')),
    });
    this.addCommand({
      id: 'share-note-team',
      name: 'Share this note (my team)',
      checkCallback: (checking) => this.withActiveFile(checking, (f) => shareNote(this.app, f, 'team')),
    });
    this.addCommand({
      id: 'stop-sharing-note',
      name: 'Stop sharing this note',
      checkCallback: (checking) => this.withActiveFile(checking, (f) => stopSharingNote(this.app, f)),
    });
    this.addCommand({
      id: 'status',
      name: 'What would be published (preview)',
      callback: () => void this.showStatus(),
    });
    this.addCommand({
      id: 'requests',
      name: 'Check requests (knocks waiting for an answer)',
      callback: () =>
        void this.pollInbox(false).then(() =>
          new RequestsModal(this.app, this, this.lastRequests).open(),
        ),
    });
    this.addCommand({
      id: 'knock',
      name: 'Knock a colleague (ask what they know)',
      callback: () => new KnockComposerModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'answers',
      name: 'Answers to my knocks',
      callback: () => new AnswersListModal(this.app, this.device.receivedAnswers).open(),
    });
    this.addCommand({
      id: 'uninstall',
      name: 'Remove from this vault…',
      callback: () => new UninstallModal(this.app, this).open(),
    });

    // First run in this vault, nothing configured yet: open setup once the
    // workspace is ready (never mid-load).
    if (!loadIdentity(this.app)?.did && !this.data.lastPublished) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => new SetupWizard(this.app, this).open(), 400);
      });
    }
  }

  refreshStatusBar(): void {
    if (!this.statusEl) return;
    const last = this.data.lastPublished;
    const base = last
      ? `Vantell: live · ${last.topics.length} topic${last.topics.length === 1 ? '' : 's'}`
      : 'Vantell: not live';
    this.statusEl.setText(
      this.requestCount > 0
        ? `${base} · ${this.requestCount} request${this.requestCount === 1 ? '' : 's'}`
        : base,
    );
  }

  setRequestCount(n: number): void {
    this.requestCount = n;
    this.refreshStatusBar();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VANTELL_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VANTELL_VIEW, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  refreshPanel(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VANTELL_VIEW)) {
      const v = leaf.view;
      if (v instanceof VantellView) void v.render();
    }
  }

  openSetup(): void {
    new SetupWizard(this.app, this).open();
  }

  async pollInbox(startup: boolean): Promise<void> {
    if (!loadIdentity(this.app)?.did) return;
    try {
      const { requests, notifications, answers } = await checkInbox(this);
      for (const n of notifications) new Notice(n, 8000);
      if (answers.length > 0) {
        // Persist first, so a missed popup can always be reopened.
        this.device.receivedAnswers = [
          ...answers.map((a) => ({
            fromDid: a.fromDid,
            fromName: a.fromName,
            topic: a.topic,
            summary: a.summary,
            sources: a.sources,
            at: new Date().toISOString(),
          })),
          ...this.device.receivedAnswers,
        ].slice(0, 50);
        // Mark any matching sent knock as answered.
        const answeredFrom = new Set(answers.map((a) => a.fromDid));
        for (const k of this.device.sentKnocks) {
          if (k.status !== 'answered' && answeredFrom.has(k.toDid)) k.status = 'answered';
        }
        this.saveDevice();
        for (const a of answers) {
          new Notice(
            `${a.fromName} answered your knock${a.topic ? ` about ${a.topic}` : ''} — see "Answers to my knocks".`,
            8000,
          );
          new AnswerModal(this.app, a.fromName, a.topic, a.summary, a.sources).open();
        }
      }
      const openReqs = requests.filter((r) => r.consent !== 'denied');
      const newlyArrived = openReqs.length > this.lastRequests.length && !startup;
      this.lastRequests = openReqs;
      this.setRequestCount(openReqs.length);
      if (openReqs.length > 0 && (newlyArrived || startup)) {
        new Notice(
          `${openReqs.length} request${openReqs.length === 1 ? '' : 's'} waiting — open the Vantell panel to review.`,
          8000,
        );
      }
      this.refreshPanel();
    } catch {
      /* offline or key rotated — quiet; the next poll retries */
    }
  }

  private withActiveFile(checking: boolean, run: (f: TFile) => Promise<void>): boolean {
    const f = this.app.workspace.getActiveFile();
    if (!(f instanceof TFile) || f.extension !== 'md') return false;
    if (!checking) {
      void run(f).then(() => void this.annotateActiveState(f));
    }
    return true;
  }

  private async annotateActiveState(f: TFile): Promise<void> {
    // Touch the state so future dynamic UI (status pane) stays honest; today
    // this is a no-op hook kept cheap on purpose.
    await noteShareState(this.app, f).catch(() => undefined);
  }

  private async showStatus(): Promise<void> {
    const notice = new Notice('Checking your vault — everything stays on this device…', 0);
    try {
      const ctx = await scanVault(this.app);
      const s = summarize(ctx.result);
      const diff = diffAgainst(this.data.lastPublished, ctx.result);
      const lines = [
        `${s.topics.length} topic${s.topics.length === 1 ? '' : 's'}, ${s.shareableNotes} shareable of ${s.totalNotes} notes.`,
        ...diff,
        'Run “Set up / choose your folders” to change or re-publish.',
      ];
      new Notice(lines.join('\n'), 10_000);
    } catch (err) {
      new Notice(err instanceof Error ? err.message : 'The check failed.');
    } finally {
      notice.hide();
    }
  }
}
