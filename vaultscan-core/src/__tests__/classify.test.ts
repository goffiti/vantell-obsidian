/**
 * Parity tests for the scan pipeline, mirroring the Python fake-vault cases
 * (fixture built in-memory).
 */
import { describe, expect, it } from 'vitest';
import { gateCheck, scan } from '../classify';
import { DEFAULT_VAULT_CONFIG, withFolderAction } from '../config';
import { makeMemoryProvider } from '../memoryProvider';
import type { VaultConfig } from '../types';

const DAY = 86_400_000;

function cfg(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    capture_paths: [...DEFAULT_VAULT_CONFIG.capture_paths],
    person_paths: [...DEFAULT_VAULT_CONFIG.person_paths],
    exclude_paths: [...DEFAULT_VAULT_CONFIG.exclude_paths],
    exclude_if_matches: [...DEFAULT_VAULT_CONFIG.exclude_if_matches],
    confirmed_authored: [...DEFAULT_VAULT_CONFIG.confirmed_authored],
    ...overrides,
  };
}

const DOSSIER = 'Name: John Smith\nEmail: john@corp.example\nRole: CEO\n\nMet at conf.\n';
const MAILISH = 'From: a@x.com\nTo: b@x.com\nSubject: hi\nDate: Mon\n\nquoted mail\n';
const CHATTY =
  '[09:12] anna: hello\n[09:14] tom: hi\n[09:20] anna: ok\n[09:31] tom: yes\n[09:44] anna: done\n[09:51] tom: bye\n';

function fakeVault() {
  return makeMemoryProvider({
    'Emails/2020/mail1.md': MAILISH,
    'EMAILS2/mail2.md': MAILISH, // case/prefix variant of Email*/**
    'Cronos Mail Archive/old.md': 'plain body, path is what locks it\n',
    'Emails/capvis.md': '---\nvisibility: org\n---\ntrying to leak a capture\n',
    'People/jane.md': 'Jane note, path is what locks it\n',
    'Notes/dossier.md': DOSSIER,
    'Notes/mailish.md': MAILISH,
    'Notes/captured.md': '---\nsource: capture\n---\nclipped\n',
    'Notes/malformed.md': '---\nnot: [valid\n---\nbody\n',
    'Notes/secret.md': 'the salary discussion notes\n',
    'Notes/pub.md':
      '---\nvisibility: org\ntopics: [ai, agents]\ntitle: My Pub\n---\n# Pub\n\ncontent\n',
    'Notes/hidden.md': '---\nvisibility: team\n---\nvisible %%hidden bit%% end\n',
    'Notes/priv.md': 'just a private thought\n',
    'Personal/journal.md': 'dear diary\n',
  });
}

describe('scan — classification order and counts', () => {
  it('classifies the fake vault exactly like scan.py', async () => {
    const fp = fakeVault();
    const now = Date.now();
    fp.setMtime('Notes/pub.md', now - 10 * DAY);
    fp.setMtime('Notes/hidden.md', now - 3 * DAY);
    const { transmitSafe, localOnly } = await scan(fp, cfg(), { nowMs: now });

    // captures: Emails/mail1, EMAILS2/mail2, Cronos Mail Archive, capvis (path),
    // Notes/captured (source: capture), Notes/mailish (heuristic) = 6
    expect(transmitSafe.stats.capture_files).toBe(6);
    expect(transmitSafe.excluded.capture_content_heuristic).toBe(1);
    // person: People/jane (path), Notes/dossier (heuristic) = 2
    expect(transmitSafe.stats.people_notes).toBe(2);
    expect(transmitSafe.excluded.person_content_heuristic).toBe(1);
    // excluded: Personal (path) + secret (regex)
    expect(transmitSafe.excluded.excluded_paths).toBe(1);
    expect(transmitSafe.excluded.regex_matches).toBe(1);
    // private: malformed + priv
    expect(transmitSafe.excluded.private_default_or_marked).toBe(2);
    expect(transmitSafe.excluded.malformed_frontmatter).toBe(1);
    // shareable: pub + hidden
    expect(transmitSafe.stats.shareable_notes).toBe(2);
    expect(transmitSafe.stats.total_notes).toBe(14);

    const w = localOnly.warnings.join('\n');
    // Path-locked files are classified WITHOUT being read (performance:
    // 126k+ locked files in the field) — so the per-note visibility-on-capture
    // warning intentionally no longer fires for path-matched captures.
    expect(w).not.toContain("visibility 'org' set on capture-layer file");
    expect(w).toContain('malformed frontmatter — treated as private: Notes/malformed.md');
    expect(w).toContain('body matches exclude pattern');
    expect(w).toContain('hidden comments');
  });

  it('visibility on heuristic-demoted notes warns and stays ignored', async () => {
    const fp = makeMemoryProvider({
      'Notes/sneaky-dossier.md': `---\nvisibility: org\n---\n${DOSSIER}`,
      'Notes/sneaky-mail.md': `---\nvisibility: team\n---\n${MAILISH}`,
    });
    const { transmitSafe, localOnly } = await scan(fp, cfg());
    expect(transmitSafe.stats.shareable_notes).toBe(0);
    const w = localOnly.warnings.join('\n');
    expect(w).toContain('looks like a person dossier');
    expect(w).toContain('looks like captured mail');
  });

  it('heuristics demote even inside confirmed_authored folders', async () => {
    const fp = makeMemoryProvider({ 'Mine/dossier.md': DOSSIER, 'Mine/ok.md': 'fine\n' });
    const { transmitSafe } = await scan(fp, cfg({ confirmed_authored: ['Mine'] }));
    expect(transmitSafe.stats.people_notes).toBe(1);
  });

  it('computes topics from frontmatter + folder, with the depth formula', async () => {
    const fp = fakeVault();
    const now = Date.now();
    fp.setMtime('Notes/pub.md', now - 10 * DAY);
    fp.setMtime('Notes/hidden.md', now - 3 * DAY);
    const { transmitSafe } = await scan(fp, cfg(), { nowMs: now });
    const byLabel = Object.fromEntries(transmitSafe.topics.map((t) => [t.label, t]));
    // 'notes' from the top-level folder of both shareable notes
    expect(byLabel['notes']?.notes).toBe(2);
    expect(byLabel['ai']?.notes).toBe(1);
    expect(byLabel['agents']?.notes).toBe(1);
    // depth = round(min(1, 0.3 + 0.1*log2(1+n)), 2)
    expect(byLabel['ai']?.depth).toBeCloseTo(0.4, 5);
    expect(byLabel['notes']?.depth).toBeCloseTo(
      Math.round((0.3 + 0.1 * Math.log2(3)) * 100) / 100,
      5,
    );
    // recency: min age across notes carrying the label
    expect(byLabel['notes']?.recency_days).toBe(3);
    expect(byLabel['ai']?.recency_days).toBe(10);
  });

  it('warns about wiki-looking folders with nothing shared', async () => {
    const fp = makeMemoryProvider({
      'Wiki/a.md': 'authored a\n',
      'Wiki/b.md': 'authored b\n',
      'Wiki/c.md': 'authored c\n',
    });
    const { localOnly } = await scan(fp, cfg());
    expect(localOnly.warnings.join('\n')).toContain("folder 'Wiki/' looks like a curated wiki");
  });

  it('CAUTION fires for big vaults with zero capture/person', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1001; i++) files[`Bulk/n${String(i).padStart(4, '0')}.md`] = `note ${i}\n`;
    const { localOnly } = await scan(makeMemoryProvider(files), cfg());
    expect(localOnly.caution).toContain('CAUTION');
    const small = await scan(fakeVault(), cfg());
    expect(small.localOnly.caution).toBeNull();
  });

  it('broken exclude_if_matches regex is skipped with a warning', async () => {
    const fp = makeMemoryProvider({ 'Notes/a.md': 'hello\n' });
    const { localOnly } = await scan(fp, cfg({ exclude_if_matches: ['([unclosed'] }));
    expect(localOnly.warnings.join('\n')).toContain('invalid regexes');
  });
});

describe('scan — locked-folder aggregation (name minimization)', () => {
  it('locked folders collapse to generic rows; real names only in localOnly', async () => {
    const fp = fakeVault();
    const { transmitSafe, localOnly } = await scan(fp, cfg());

    const folderPaths = transmitSafe.folders.map((f) => f.path);
    expect(folderPaths).toContain('(capture folders)');
    expect(folderPaths).toContain('(person folders)');
    expect(folderPaths).toContain('(excluded folders)');
    // Notes/ is mixed (authored + heuristic + regex hits) → keeps its real name
    expect(folderPaths).toContain('Notes');

    // The real locked/excluded names must NOT appear in the transmit-safe JSON.
    const wire = JSON.stringify(transmitSafe);
    for (const lockedName of [
      'Emails', 'EMAILS2', 'Cronos Mail Archive', 'People', 'Personal',
    ]) {
      expect(wire).not.toContain(lockedName);
    }

    // ...but they are available for the owner-only local review.
    const lockedPaths = localOnly.lockedLocal.map((l) => l.path).sort();
    expect(lockedPaths).toEqual([
      'Cronos Mail Archive', 'EMAILS2', 'Emails', 'People', 'Personal',
    ]);
    const cap = transmitSafe.folders.find((f) => f.path === '(capture folders)')!;
    expect(cap.note_count).toBe(4); // Emails(2) + EMAILS2(1) + Cronos Mail Archive(1)
    expect(cap.locked).toBe(true);
    expect(cap.sample_titles).toEqual([]);
    const per = transmitSafe.folders.find((f) => f.path === '(person folders)')!;
    expect(per.note_count).toBe(1);
    const exc = transmitSafe.folders.find((f) => f.path === '(excluded folders)')!;
    expect(exc.note_count).toBe(1); // Personal/journal.md
    expect(exc.locked).toBe(true);
    expect(
      localOnly.lockedLocal.find((l) => l.path === 'Personal')?.kind,
    ).toBe('excluded');
  });

  it('fully-excluded folders (path or regex) fold; mixed folders keep their name', async () => {
    const fp = makeMemoryProvider({
      'Personal/diary.md': 'dear diary\n', // path-excluded
      'Personal/more.md': 'more diary\n', // path-excluded
      'Legal/terms.md': 'this mentions NDA terms\n', // regex-excluded
      'Mixedlock/mail.md': MAILISH, // capture (heuristic)
      'Mixedlock/pay.md': 'salary discussion\n', // regex-excluded
      'Notes/keep.md': 'authored note\n',
      'Notes/pay.md': 'salary discussion\n', // regex-excluded, Notes stays mixed
    });
    const { transmitSafe, localOnly } = await scan(fp, cfg());

    const paths = transmitSafe.folders.map((f) => f.path);
    expect(paths).toContain('(excluded folders)');
    expect(paths).toContain('Notes'); // mixed: keeps its non-excluded part by name

    const wire = JSON.stringify(transmitSafe);
    for (const name of ['Personal', 'Legal', 'Mixedlock', 'diary', 'terms']) {
      expect(wire).not.toContain(name);
    }

    const exc = transmitSafe.folders.find((f) => f.path === '(excluded folders)')!;
    expect(exc.note_count).toBe(3); // Personal(2) + Legal(1)
    expect(exc.locked).toBe(true);
    expect(exc.locked_reason).toContain('never scanned');
    expect(exc.locked_reason).toContain('stay on this machine');
    expect(exc.sample_titles).toEqual([]);

    // capture+excluded only → still no reportable part: folds under capture
    const cap = transmitSafe.folders.find((f) => f.path === '(capture folders)')!;
    expect(cap.note_count).toBe(2); // both Mixedlock notes
    const byPath = Object.fromEntries(localOnly.lockedLocal.map((l) => [l.path, l.kind]));
    expect(byPath).toEqual({
      Legal: 'excluded',
      Mixedlock: 'capture',
      Personal: 'excluded',
    });
  });
});

describe('withFolderAction — review-step reclassify mapping', () => {
  it('appends <folder>/** to the matching list without mutating the input', () => {
    const base = cfg();
    expect(withFolderAction(base, 'Exports', 'capture').capture_paths).toContain('Exports/**');
    expect(withFolderAction(base, 'Rolodex', 'person').person_paths).toContain('Rolodex/**');
    const ex = withFolderAction(base, 'Drafts', 'exclude');
    expect(ex.exclude_paths).toContain('Drafts/**');
    // untouched lists stay equal; the input config is never mutated
    expect(ex.capture_paths).toEqual(base.capture_paths);
    expect(ex.person_paths).toEqual(base.person_paths);
    expect(base.exclude_paths).not.toContain('Drafts/**');
    expect(base.capture_paths).not.toContain('Exports/**');
  });

  it('a reclassified folder aggregates on the next scan', async () => {
    const fp = makeMemoryProvider({ 'Exports/one.md': 'plain authored text\n' });
    const first = await scan(fp, cfg());
    expect(first.transmitSafe.folders.map((f) => f.path)).toContain('Exports');
    const second = await scan(fp, withFolderAction(cfg(), 'Exports', 'exclude'));
    const paths = second.transmitSafe.folders.map((f) => f.path);
    expect(paths).not.toContain('Exports');
    expect(paths).toContain('(excluded folders)');
  });
});

describe('gateCheck — pre-scan classification gate', () => {
  it('fires on suspect folder names (teams / granola / mail)', async () => {
    const fp = makeMemoryProvider({
      'Teams Export/a.md': 'plain\n',
      'granola-syncs/b.md': 'plain\n',
      'cronos-mail/c.md': 'plain\n',
      'Notes/ok.md': 'plain\n',
    });
    const suspects = await gateCheck(fp, cfg());
    const byFolder = Object.fromEntries(suspects.map((s) => [s.folder, s]));
    expect(byFolder['Teams Export']?.why).toContain("name contains 'teams'");
    expect(byFolder['granola-syncs']?.why).toContain("name contains 'granola'");
    expect(byFolder['cronos-mail']?.why).toContain("name contains 'mail'");
    expect(byFolder['Notes']).toBeUndefined();
  });

  it('folders covered by capture/person/exclude paths are not gated', async () => {
    const fp = makeMemoryProvider({
      'Emails/a.md': MAILISH,
      'Cronos Mail Archive/b.md': 'x\n',
      'People/c.md': 'x\n',
    });
    expect(await gateCheck(fp, cfg())).toEqual([]);
  });

  it('fires on sampled content: person dossiers and chat captures', async () => {
    const fp = makeMemoryProvider({
      'Rolodex/p1.md': DOSSIER,
      'Rolodex/p2.md': DOSSIER,
      'Rolodex/p3.md': DOSSIER,
      'Exports/c1.md': CHATTY,
      'Exports/c2.md': MAILISH,
    });
    const suspects = await gateCheck(fp, cfg());
    const byFolder = Object.fromEntries(suspects.map((s) => [s.folder, s]));
    expect(byFolder['Rolodex']?.why).toContain('look like person dossiers');
    expect(byFolder['Exports']?.why).toContain('look like mail/chat/transcript captures');
  });

  it('fires on sheer size for top-level folders and (root)', async () => {
    const files: Record<string, string> = { 'root-a.md': 'x\n', 'root-b.md': 'x\n', 'root-c.md': 'x\n' };
    for (let i = 0; i < 4; i++) files[`Big/f${i}.md`] = 'plain\n';
    const fp = makeMemoryProvider(files);
    const suspects = await gateCheck(fp, cfg(), { minFiles: 3 });
    const byFolder = Object.fromEntries(suspects.map((s) => [s.folder, s]));
    expect(byFolder['Big']?.why).toContain('size alone is worth a decision');
    expect(byFolder['(root)']?.why).toContain('size alone is worth a decision');
  });

  it('gates second-level folders too', async () => {
    const fp = makeMemoryProvider({ 'A/Slack Dump/x.md': CHATTY });
    const suspects = await gateCheck(fp, cfg());
    const folders = suspects.map((s) => s.folder);
    expect(folders).toContain('A/Slack Dump');
  });

  it('confirmed_authored silences the gate for exactly that folder', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`Big/f${i}.md`] = 'plain\n';
    files['root.md'] = 'x\n';
    const fp = makeMemoryProvider(files);
    const silenced = await gateCheck(
      fp,
      cfg({ confirmed_authored: ['big', '(root)'] }),
      { minFiles: 1 },
    );
    expect(silenced).toEqual([]);
  });
});
