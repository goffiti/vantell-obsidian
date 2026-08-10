/**
 * The scan pipeline — port of scan.py with behavioral parity:
 * pre-scan classification gate, two-layer per-note classification,
 * locked-folder aggregation (name minimization), stats/folders/topics.
 */
import { pathMatches } from './glob';
import { MALFORMED, parseFrontmatter, type Frontmatter } from './frontmatter';
import {
  chatLogDominated,
  folderNameSuspicion,
  hasHiddenContent,
  looksCaptureNote,
  looksPersonNote,
} from './heuristics';
import {
  compileRegexes,
  confirmedAuthoredSet,
  matchDefaultVisibility,
  resolveDefaultVisibility,
  resolveReportScope,
} from './config';
import { SHAREABLE_VIS } from './types';
import type {
  CoverageRow,
  FileProvider,
  GateSuspect,
  LockedFolderLocal,
  ReportFolder,
  ScanResult,
  TopicRow,
  VaultConfig,
} from './types';

export const GATE_MIN_FILES_DEFAULT = 200; // top-level size gate
/** Manifest topic cap — beyond this, lower-volume topics are dropped with a
 * warning. Keeps tag-rich vaults from publishing a 400-label manifest. */
export const TOPIC_CAP = 50;
const GATE_SAMPLE_MAX = 12; // content-suspicion sample size per folder
const GATE_HEAD_BYTES = 8192; // how much of each sampled file the gate reads

const WIKI_FOLDER_NAMES = new Set(['wiki', 'docs', 'kb', 'knowledge', 'handbook']);

// Locked-folder name minimization: locked (categorical) and fully-excluded
// folders are aggregated into these generic rows — their real names never
// leave the page.
// report_scope: selected — folders the owner does NOT share from are
// aggregated into this single row; their names stay on this machine.
export const PRIVATE_AGG: [string, string] = [
  '(private folders)',
  'Not selected for sharing — folder names stay on this machine.',
];

export const LOCKED_AGG: Record<'capture' | 'person' | 'excluded', [string, string]> = {
  capture: [
    '(capture folders)',
    'Captured third-party material — never shareable. Folder names stay on this machine.',
  ],
  person: [
    '(person folders)',
    'Person-centric material — never shareable. Folder names stay on this machine.',
  ],
  excluded: [
    '(excluded folders)',
    'Excluded by you — never scanned for sharing. Folder names stay on this machine.',
  ],
};

function noteTitle(fm: Record<string, unknown>, path: string): string {
  const t = fm['title'];
  if (typeof t === 'string') return t.trim();
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]*$/, '');
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface GateOptions {
  minFiles?: number;
  onProgress?: (filesSeen: number) => void;
}

/**
 * Pre-scan classification gate — port of scan.py gate_check. Returns
 * suspect-folder records; any record means the scan must stop until the
 * owner classifies the folder in .vantell.yml. Reads only sampled heads.
 */
export async function gateCheck(
  fp: FileProvider,
  cfg: VaultConfig,
  opts: GateOptions = {},
): Promise<GateSuspect[]> {
  const cap = cfg.capture_paths ?? [];
  const per = cfg.person_paths ?? [];
  const exc = cfg.exclude_paths ?? [];
  const confirmed = confirmedAuthoredSet(cfg);
  const minFiles = opts.minFiles ?? GATE_MIN_FILES_DEFAULT;

  interface FolderStat {
    folder: string;
    total: number;
    uncovered: number;
    samples: string[];
  }
  const folders = new Map<string, FolderStat>();
  const paths = await fp.listMarkdown();
  let seen = 0;
  for (const rel of paths) {
    seen += 1;
    if (opts.onProgress && seen % 200 === 0) opts.onProgress(seen);
    const parts = rel.split('/');
    const covered =
      pathMatches(rel, cap) || pathMatches(rel, per) || pathMatches(rel, exc);
    // Root-level files: gated as the pseudo-folder "(root)".
    const keys =
      parts.length === 1
        ? ['(root)']
        : parts.length >= 3
          ? [parts[0]!, parts[0]! + '/' + parts[1]!]
          : [parts[0]!];
    for (const k of keys) {
      let st = folders.get(k);
      if (!st) {
        st = { folder: k, total: 0, uncovered: 0, samples: [] };
        folders.set(k, st);
      }
      st.total += 1;
      if (!covered) {
        st.uncovered += 1;
        if (st.samples.length < GATE_SAMPLE_MAX) st.samples.push(rel);
      }
    }
  }

  const suspects: GateSuspect[] = [];
  for (const k of [...folders.keys()].sort()) {
    const st = folders.get(k)!;
    if (st.uncovered === 0 || confirmed.has(k.toLowerCase())) continue;
    const reasons: string[] = [];
    const tok = folderNameSuspicion(k);
    if (tok) reasons.push(`name contains '${tok}'`);
    let personHits = 0;
    let captureHits = 0;
    const sampled = st.samples.length;
    for (const p of st.samples) {
      let head: string;
      try {
        head = (await fp.read(p)).slice(0, GATE_HEAD_BYTES);
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(head);
      // malformed/truncated frontmatter: sample the raw head instead
      const body = parsed.fm === MALFORMED ? head : parsed.body;
      if (looksPersonNote(body)) personHits += 1;
      else if (looksCaptureNote(body) || chatLogDominated(body)) captureHits += 1;
    }
    if (sampled && personHits * 2 >= sampled) {
      reasons.push(
        `${personHits}/${sampled} sampled notes look like person dossiers (Name:/Email:/Role: headers)`,
      );
    }
    if (sampled && captureHits * 2 >= sampled) {
      reasons.push(
        `${captureHits}/${sampled} sampled notes look like mail/chat/transcript captures`,
      );
    }
    if (!k.includes('/') && st.uncovered >= minFiles) {
      reasons.push(
        `${st.uncovered} unclassified notes (>= ${minFiles}) — size alone is worth a decision`,
      );
    }
    if (reasons.length) {
      suspects.push({
        folder: k,
        md_files: st.total,
        unclassified: st.uncovered,
        why: reasons.join('; '),
        sampleTitles: st.samples.slice(0, 3).map((p) => {
          const base = p.split('/').pop() ?? p;
          return base.replace(/\.[^.]*$/, '');
        }),
      });
    }
  }
  return suspects;
}

/**
 * Topic labels for one shareable note: explicit `topics:`, Obsidian `tags:`
 * (leading '#' stripped, nested tags kept whole), the top-level folder, and
 * the second-level folder when there is one. Only shareable notes should be
 * fed here — sharing a folder consents to its subtree, and subfolder/tag
 * labels are what make a manifest tangible. Single source of truth for the
 * scan AND for any client answering "which notes inform topic X".
 */
export function noteTopicLabels(rel: string, fmd: Record<string, unknown>): Set<string> {
  const labels = new Set<string>();
  const addLabel = (raw: unknown): void => {
    const s = String(raw).trim().replace(/^#/, '').toLowerCase();
    if (s) labels.add(s);
  };
  const fmTopics = fmd['topics'];
  if (Array.isArray(fmTopics)) fmTopics.forEach(addLabel);
  else if (typeof fmTopics === 'string' && fmTopics.trim()) addLabel(fmTopics);
  const fmTags = fmd['tags'];
  if (Array.isArray(fmTags)) fmTags.forEach(addLabel);
  else if (typeof fmTags === 'string') {
    // Legacy Obsidian string form: "a, b" or space-separated.
    fmTags.split(/[,\s]+/).forEach((t) => t && addLabel(t));
  }
  const top = rel.includes('/') ? rel.split('/')[0]! : '(root)';
  if (top !== '(root)') {
    addLabel(top);
    const parts = rel.split('/');
    if (parts.length >= 3) addLabel(parts[1]!);
  }
  return labels;
}

export interface ScanOptions {
  nowMs?: number;
  onProgress?: (filesScanned: number, total: number) => void;
  /** Yield to the event loop every N files so the UI can paint. */
  yieldEvery?: number;
}

/** Full vault scan — port of scan.py scan(). */
export async function scan(
  fp: FileProvider,
  cfg: VaultConfig,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const { regexes, bad: badRegexes } = compileRegexes(cfg.exclude_if_matches ?? []);
  const nowMs = opts.nowMs ?? Date.now();

  const warnings: string[] = [];
  const counts = {
    capture: 0,
    person: 0,
    excluded_path: 0,
    excluded_regex: 0,
    private: 0,
    shareable: 0,
    shareable_default: 0,
    malformed: 0,
    hidden_content: 0,
    capture_heuristic: 0,
    person_heuristic: 0,
  };

  // Scoped visibility defaults (§1.1). Invalid rules warn instead of
  // silently sharing (or silently not sharing).
  const dv = resolveDefaultVisibility(cfg);
  for (const rej of dv.rejected) {
    warnings.push(
      `default_visibility pattern '${rej.pattern}' is invalid — ${rej.reason}; the default is ignored`,
    );
  }
  const scopeRes = resolveReportScope(cfg);
  if (scopeRes.warning) warnings.push(scopeRes.warning);
  const defaultHits = new Map<string, number>(); // pattern -> authored notes matched
  const defaultableByFolder = new Map<string, number>();
  // §1.1: a note covered by a default that gains capture/person provenance
  // drops out of the export — visibly, never silently.
  const warnDefaultDemoted = (rel: string, what: string): void => {
    const r = matchDefaultVisibility(rel, dv.rules);
    if (r) {
      warnings.push(
        `WARNING: '${rel}' is covered by default_visibility '${r.pattern}' but is ${what} — the default cannot rescue it; it stays out (§1.1)`,
      );
    }
  };
  interface FolderAcc {
    path: string;
    note_count: number;
    sample_titles: string[];
  }
  const folders = new Map<string, FolderAcc>();
  const topics = new Map<string, { label: string; notes: number; recency_days: number }>();
  const authoredByFolder = new Map<string, number>();
  const shareableByFolder = new Map<string, number>();
  const confirmed = confirmedAuthoredSet(cfg);
  const bucketsByFolder = new Map<string, Record<string, number>>();

  const bucket = (top: string, name: string): void => {
    let b = bucketsByFolder.get(top);
    if (!b) {
      b = {};
      bucketsByFolder.set(top, b);
    }
    b[name] = (b[name] ?? 0) + 1;
  };

  if (badRegexes) {
    warnings.push(
      `${badRegexes} pattern(s) in exclude_if_matches are invalid regexes and were skipped — fix .vantell.yml`,
    );
  }

  const paths = await fp.listMarkdown();
  let total = 0;
  for (const rel of paths) {
    const top = rel.includes('/') ? rel.split('/')[0]! : '(root)';
    total += 1;
    if (opts.onProgress) opts.onProgress(total, paths.length);
    if (opts.yieldEvery && total % opts.yieldEvery === 0) {
      await new Promise((r) => globalThis.setTimeout(r, 0));
    }

    let f = folders.get(top);
    if (!f) {
      f = { path: top, note_count: 0, sample_titles: [] };
      folders.set(top, f);
    }
    f.note_count += 1;

    // Path-decided classifications never need the file contents — through the
    // browser file API, skipping these reads is the difference between seconds
    // and minutes on a capture-heavy vault (126k+ locked files observed in the
    // field). Trade-off vs the Python skill: per-note "visibility set on a
    // locked file" warnings and content-heuristic demotions inside locked or
    // excluded folders are skipped — every such file is non-shareable either
    // way; only which locked bucket it counts under can differ.
    if (pathMatches(rel, cfg.capture_paths ?? [])) {
      counts.capture += 1;
      bucket(top, 'capture');
      continue;
    }
    if (pathMatches(rel, cfg.person_paths ?? [])) {
      counts.person += 1;
      bucket(top, 'person');
      continue;
    }
    if (pathMatches(rel, cfg.exclude_paths ?? [])) {
      counts.excluded_path += 1;
      bucket(top, 'excluded');
      continue;
    }

    let text: string;
    try {
      text = await fp.read(rel);
    } catch {
      warnings.push(`unreadable, skipped: ${rel}`);
      continue;
    }
    const parsed = parseFrontmatter(text);
    const fm: Frontmatter = parsed.fm;
    const body = parsed.body;
    const malformed = fm === MALFORMED;
    const fmd: Record<string, unknown> = malformed ? {} : fm;
    const vis = fmd['visibility'];
    const visShareable = typeof vis === 'string' && SHAREABLE_VIS.includes(vis);

    // 1. capture layer by frontmatter provenance (path matches handled above)
    if (fmd['source'] === 'capture') {
      counts.capture += 1;
      bucket(top, 'capture');
      if (vis !== undefined && vis !== null && vis !== 'private') {
        warnings.push(
          `WARNING: visibility '${String(vis)}' set on capture-layer file — categorically ignored (§1.0): ${rel}`,
        );
      }
      warnDefaultDemoted(rel, 'capture-layer (source: capture)');
      continue;
    }

    // 2. person subject by frontmatter (path matches handled above)
    if (fmd['subject'] === 'person') {
      counts.person += 1;
      bucket(top, 'person');
      if (vis !== undefined && vis !== null && vis !== 'private') {
        warnings.push(
          `WARNING: visibility '${String(vis)}' set on person-centric note — categorically ignored (§1.0): ${rel}`,
        );
      }
      warnDefaultDemoted(rel, 'person-subject (subject: person)');
      continue;
    }

    // 2b. content heuristics — DEMOTE-ONLY, even inside confirmed_authored
    if (looksPersonNote(body)) {
      counts.person += 1;
      counts.person_heuristic += 1;
      bucket(top, 'person');
      if (visShareable) {
        warnings.push(
          `WARNING: visibility '${String(vis)}' set on a note that looks like a person dossier (plain-text Name:/Email:/Role: headers) — demoted to person-subject, categorically ignored: ${rel}`,
        );
      }
      warnDefaultDemoted(rel, 'demoted to person-subject by the dossier heuristic');
      continue;
    }
    if (looksCaptureNote(body)) {
      counts.capture += 1;
      counts.capture_heuristic += 1;
      bucket(top, 'capture');
      if (visShareable) {
        warnings.push(
          `WARNING: visibility '${String(vis)}' set on a note that looks like captured mail (From:/To:/Subject:/Date: headers) — demoted to capture layer, categorically ignored: ${rel}`,
        );
      }
      warnDefaultDemoted(rel, 'demoted to capture layer by the mail-header heuristic');
      continue;
    }

    const authoredBucket = confirmed.has(top.toLowerCase()) ? 'confirmed-authored' : 'authored';

    // 4. malformed frontmatter → private, warned
    if (malformed) {
      counts.malformed += 1;
      counts.private += 1;
      bucket(top, authoredBucket);
      warnings.push(`malformed frontmatter — treated as private: ${rel}`);
      authoredByFolder.set(top, (authoredByFolder.get(top) ?? 0) + 1);
      continue;
    }

    // 5. regex bail-out (§1.3) — a hit excludes AND warns
    const hit = regexes.find((r) => r.re.test(body));
    if (hit) {
      counts.excluded_regex += 1;
      bucket(top, 'excluded');
      if (visShareable) {
        warnings.push(
          `WARNING: marked shareable ('${String(vis)}') but body matches exclude pattern /${hit.pattern}/ — excluded, are you sure about this note?: ${rel}`,
        );
      } else {
        warnings.push(`body matches exclude pattern /${hit.pattern}/ — excluded: ${rel}`);
      }
      continue;
    }

    // 6. authored layer — explicit frontmatter first, then scoped defaults
    // (§1.1). Explicit per-note visibility always wins, in both directions:
    // 'visibility: private' (or any explicit value) opts out of a default.
    authoredByFolder.set(top, (authoredByFolder.get(top) ?? 0) + 1);
    bucket(top, authoredBucket);
    const explicitVis = vis !== undefined && vis !== null;
    const defRule = matchDefaultVisibility(rel, dv.rules);
    if (defRule) defaultHits.set(defRule.pattern, (defaultHits.get(defRule.pattern) ?? 0) + 1);
    const viaDefault = !explicitVis && defRule !== null;
    if (!visShareable && !viaDefault) {
      counts.private += 1;
      if (!explicitVis) {
        // A NEW folder default would make exactly these notes shareable.
        defaultableByFolder.set(top, (defaultableByFolder.get(top) ?? 0) + 1);
      }
      continue;
    }

    // shareable — explicitly, or via a scoped folder default
    counts.shareable += 1;
    if (viaDefault) counts.shareable_default += 1;
    shareableByFolder.set(top, (shareableByFolder.get(top) ?? 0) + 1);
    if (hasHiddenContent(body)) {
      counts.hidden_content += 1;
      warnings.push(
        `note contains hidden comments (%% or <!-- ) — they would be stripped by a full publisher and are never transmitted: ${rel}`,
      );
    }
    const title = noteTitle(fmd, rel);
    if (f.sample_titles.length < 3) f.sample_titles.push(title);

    // topics: frontmatter `topics:` list + top-level folder name
    let ageDays = 0;
    if (fp.mtimeMs) {
      try {
        ageDays = Math.max(0, Math.floor((nowMs - (await fp.mtimeMs(rel))) / 86_400_000));
      } catch {
        ageDays = 0;
      }
    }
    const labels = noteTopicLabels(rel, fmd);
    for (const label of labels) {
      let t = topics.get(label);
      if (!t) {
        t = { label, notes: 0, recency_days: ageDays };
        topics.set(label, t);
      }
      t.notes += 1;
      t.recency_days = Math.min(t.recency_days, ageDays);
    }
  }

  // Locked folders (categorical) and fully-excluded folders: NAME
  // MINIMIZATION — their names are aggregated into at most three generic
  // rows. Real names go to localOnly.lockedLocal, never into the
  // transmit-safe report. Mixed folders (any authored note) keep their name.
  const lockedLocal: LockedFolderLocal[] = [];
  const lockedTotals = { capture: 0, person: 0, excluded: 0 };
  const publicFolders: ReportFolder[] = [];
  // report_scope: selected — a top-level folder keeps its name only when the
  // owner shares from it: it holds a shareable note, or a default_visibility
  // rule deliberately targets it (first path segment, glob-matched — a rule
  // is a selection even while it covers zero notes yet). "(root)" can only
  // be selected by a shareable note; rules never target it.
  const ruleFirstSegs = dv.rules.map((r) => r.pattern.split('/')[0]!);
  const isSelectedTop = (top: string): boolean =>
    (shareableByFolder.get(top) ?? 0) > 0 ||
    (top !== '(root)' && ruleFirstSegs.some((seg) => pathMatches(top, [seg])));
  let privateTotal = 0;
  for (const top of [...folders.keys()].sort()) {
    const f = folders.get(top)!;
    const b = bucketsByFolder.get(top) ?? {};
    const nz = new Set(Object.keys(b).filter((k) => (b[k] ?? 0) > 0));
    const onlyLocked =
      nz.size > 0 &&
      [...nz].every((k) => k === 'capture' || k === 'person' || k === 'excluded');
    if (onlyLocked) {
      const kind = nz.has('capture') ? 'capture' : nz.has('person') ? 'person' : 'excluded';
      lockedTotals[kind] += f.note_count;
      lockedLocal.push({ path: top, note_count: f.note_count, kind });
      continue;
    }
    if (scopeRes.scope === 'selected' && !isSelectedTop(top)) {
      privateTotal += f.note_count;
      lockedLocal.push({ path: top, note_count: f.note_count, kind: 'private' });
      continue;
    }
    publicFolders.push({ path: f.path, note_count: f.note_count, sample_titles: f.sample_titles });
  }
  if (privateTotal > 0) {
    publicFolders.push({
      path: PRIVATE_AGG[0],
      note_count: privateTotal,
      sample_titles: [],
      locked: true,
      locked_reason: PRIVATE_AGG[1],
    });
  }
  for (const kind of ['capture', 'person', 'excluded'] as const) {
    if (lockedTotals[kind]) {
      const [aggName, aggReason] = LOCKED_AGG[kind];
      publicFolders.push({
        path: aggName,
        note_count: lockedTotals[kind],
        sample_titles: [],
        locked: true,
        locked_reason: aggReason,
      });
    }
  }

  // A default pattern that covers nothing shareable is a config smell —
  // most often a typo'd path, or a folder whose notes are all categorically
  // excluded. Never silent.
  for (const rule of dv.rules) {
    if (!defaultHits.get(rule.pattern)) {
      warnings.push(
        `default_visibility pattern '${rule.pattern}' matches no authored notes — nothing becomes shareable through it (categorical exclusions and exclude rules run first; check the path)`,
      );
    }
  }

  // Flag wiki-looking folders with nothing shared — the §1.1 answer is a
  // scoped default, added through the review flow (never silently).
  for (const [top, nAuth] of authoredByFolder) {
    if (
      WIKI_FOLDER_NAMES.has(top.toLowerCase()) &&
      nAuth >= 3 &&
      (shareableByFolder.get(top) ?? 0) === 0
    ) {
      warnings.push(
        `folder '${top}/' looks like a curated wiki (${nAuth} authored notes, none shareable). Add a scoped default — default_visibility: {"${top}/**": {visibility: org}} in .vantell.yml, or "Share by default" in the Connect review — or per-note 'visibility:' frontmatter.`,
      );
    }
  }

  // depth heuristic per topic: min(1.0, 0.3 + 0.1*log2(1 + notes))
  let topicRows: TopicRow[] = [...topics.values()]
    .map((t) => ({
      ...t,
      depth: Math.round(Math.min(1.0, 0.3 + 0.1 * Math.log2(1 + t.notes)) * 100) / 100,
    }))
    .sort((a, b) => (a.notes !== b.notes ? b.notes - a.notes : a.label < b.label ? -1 : 1));
  if (topicRows.length > TOPIC_CAP) {
    const dropped = topicRows.length - TOPIC_CAP;
    topicRows = topicRows.slice(0, TOPIC_CAP);
    warnings.push(
      `manifest topics capped at ${TOPIC_CAP} — ${dropped} lower-volume topic(s) left out; ` +
        `add explicit 'topics:' frontmatter to promote what matters`,
    );
  }

  const coverage: CoverageRow[] = [...bucketsByFolder.keys()]
    .sort()
    .map((top) => ({ path: top, buckets: bucketsByFolder.get(top)! }));

  const caution =
    counts.capture + counts.person === 0 && total > 1000
      ? `CAUTION: 0 notes classified as capture or person-subject in a vault of ${total} notes — that is unusual for a real vault. Verify capture_paths/person_paths in .vantell.yml before approving a publish.`
      : null;

  return {
    transmitSafe: {
      generated_at: nowIso(nowMs),
      stats: {
        total_notes: total,
        shareable_notes: counts.shareable,
        capture_files: counts.capture,
        people_notes: counts.person,
      },
      // Provenance split, kept OUTSIDE stats: the /v1/vault-report contract
      // validates stats deny-by-default, and this count never rides the wire.
      shareable_via_default: counts.shareable_default,
      excluded: {
        capture_layer: counts.capture,
        capture_content_heuristic: counts.capture_heuristic,
        person_subject: counts.person,
        person_content_heuristic: counts.person_heuristic,
        excluded_paths: counts.excluded_path,
        regex_matches: counts.excluded_regex,
        private_default_or_marked: counts.private,
        malformed_frontmatter: counts.malformed,
      },
      folders: publicFolders.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      topics: topicRows,
    },
    localOnly: {
      coverage,
      lockedLocal,
      defaultableByFolder: Object.fromEntries(defaultableByFolder),
      warnings,
      caution,
    },
  };
}
