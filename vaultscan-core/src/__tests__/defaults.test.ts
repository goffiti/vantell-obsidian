/**
 * Scoped visibility defaults (build-spec §1.1) — resolution, precedence,
 * provenance counts, root-pattern rejection, config round-trip, and the
 * candidates interaction. Mirrored by the Python suite additions.
 */
import { describe, expect, it } from 'vitest';
import { scan } from '../classify';
import {
  DEFAULT_VAULT_CONFIG,
  cloneConfig,
  defaultPatternInvalidReason,
  loadVaultConfig,
  matchDefaultVisibility,
  resolveDefaultVisibility,
  saveVaultConfig,
  withDefaultVisibility,
  withoutDefaultVisibility,
} from '../config';
import { listCandidates } from '../mark';
import { makeMemoryProvider } from '../memoryProvider';
import type { VaultConfig } from '../types';

function cfg(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return { ...cloneConfig(DEFAULT_VAULT_CONFIG), ...overrides };
}

const DOSSIER = 'Name: John Smith\nEmail: john@corp.example\nRole: CEO\n\nMet at conf.\n';
const MAILISH = 'From: a@x.com\nTo: b@x.com\nSubject: hi\nDate: Mon\n\nquoted mail\n';
const LONG_BODY = `# Rollout plan\n\n${'Substantial authored content. '.repeat(20)}\n`;

const WIKI_DEFAULT = { 'wiki/**': { visibility: 'org' } };

describe('resolveDefaultVisibility', () => {
  it('accepts subtree patterns, applies max_level default 2', () => {
    const { rules, rejected } = resolveDefaultVisibility(
      cfg({
        default_visibility: {
          'wiki/**': { visibility: 'org', max_level: 3 },
          'docs/**': { visibility: 'team' },
        },
      }),
    );
    expect(rejected).toEqual([]);
    expect(rules).toEqual([
      { pattern: 'wiki/**', visibility: 'org', max_level: 3 },
      { pattern: 'docs/**', visibility: 'team', max_level: 2 },
    ]);
  });

  it('rejects vault-root / wildcard-only patterns outright (§1.1)', () => {
    for (const pat of ['**', '*', '*/**', '**/**', '?', '/', '*/*']) {
      expect(defaultPatternInvalidReason(pat), pat).toContain('deliberate subtree');
    }
    expect(defaultPatternInvalidReason('wiki/**')).toBeNull();
    const { rules, rejected } = resolveDefaultVisibility(
      cfg({ default_visibility: { '**': { visibility: 'org' } } }),
    );
    expect(rules).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain('deliberate subtree');
  });

  it('rejects bad visibility and out-of-range max_level, keeps valid rules', () => {
    const { rules, rejected } = resolveDefaultVisibility(
      cfg({
        default_visibility: {
          'a/**': { visibility: 'public' },
          'b/**': { visibility: 'org', max_level: 7 },
          'c/**': { visibility: 'team' },
        },
      }),
    );
    expect(rules.map((r) => r.pattern)).toEqual(['c/**']);
    expect(rejected.map((r) => r.pattern).sort()).toEqual(['a/**', 'b/**']);
  });

  it('matches first pattern in config order, case-insensitively', () => {
    const { rules } = resolveDefaultVisibility(
      cfg({
        default_visibility: {
          'wiki/deep/**': { visibility: 'team' },
          'wiki/**': { visibility: 'org' },
        },
      }),
    );
    expect(matchDefaultVisibility('wiki/deep/a.md', rules)?.visibility).toBe('team');
    expect(matchDefaultVisibility('WIKI/other.md', rules)?.visibility).toBe('org');
    expect(matchDefaultVisibility('notes/a.md', rules)).toBeNull();
  });
});

describe('scan — scoped defaults in the authored layer', () => {
  it('a defaulted note becomes shareable with provenance counted; explicit frontmatter is not double-counted', async () => {
    const fp = makeMemoryProvider({
      'wiki/page.md': '# Retail patterns\n\nauthored wiki page, no frontmatter\n',
      'wiki/tagged.md': '---\nvisibility: team\ntopics: [x]\n---\nexplicitly shared\n',
      'notes/other.md': 'private elsewhere\n',
    });
    const { transmitSafe, localOnly } = await scan(
      fp,
      cfg({ default_visibility: WIKI_DEFAULT, confirmed_authored: ['wiki', 'notes'] }),
    );
    expect(transmitSafe.stats.shareable_notes).toBe(2);
    expect(transmitSafe.shareable_via_default).toBe(1);
    expect(transmitSafe.excluded.private_default_or_marked).toBe(1); // notes/other only
    // topics computed as usual — folder label covers the defaulted note
    const wiki = transmitSafe.topics.find((t) => t.label === 'wiki');
    expect(wiki?.notes).toBe(2);
    // no zero-match warning when the pattern covers notes
    expect(localOnly.warnings.join('\n')).not.toContain('matches no authored notes');
  });

  it('explicit visibility: private beats the default (opt-out, §1.1)', async () => {
    const fp = makeMemoryProvider({
      'wiki/optout.md': '---\nvisibility: private\n---\nkept private on purpose\n',
      'wiki/covered.md': 'shared via default\n',
    });
    const { transmitSafe } = await scan(
      fp,
      cfg({ default_visibility: WIKI_DEFAULT, confirmed_authored: ['wiki'] }),
    );
    expect(transmitSafe.stats.shareable_notes).toBe(1);
    expect(transmitSafe.shareable_via_default).toBe(1);
    expect(transmitSafe.excluded.private_default_or_marked).toBe(1);
  });

  it('categorical layers, exclude_paths and regex bail-outs are immune to defaults', async () => {
    const fp = makeMemoryProvider({
      'wiki/dossier.md': DOSSIER, // person heuristic demotion
      'wiki/mail.md': MAILISH, // capture heuristic demotion
      'wiki/clip.md': '---\nsource: capture\n---\nclipped\n', // fm provenance
      'wiki/pay.md': 'the salary bands\n', // regex bail-out
      'wiki/ok.md': 'genuinely authored wiki content\n',
      'Personal/wiki-note.md': 'excluded path\n',
    });
    const c = cfg({
      default_visibility: { 'wiki/**': { visibility: 'org' }, 'personal/**': { visibility: 'org' } },
      confirmed_authored: ['wiki'],
    });
    const { transmitSafe, localOnly } = await scan(fp, c);
    expect(transmitSafe.stats.shareable_notes).toBe(1); // only wiki/ok.md
    expect(transmitSafe.shareable_via_default).toBe(1);
    expect(transmitSafe.stats.people_notes).toBe(1);
    expect(transmitSafe.stats.capture_files).toBe(2);
    expect(transmitSafe.excluded.regex_matches).toBe(1);
    expect(transmitSafe.excluded.excluded_paths).toBe(1);
    const w = localOnly.warnings.join('\n');
    // §1.1: covered-but-demoted notes drop out visibly
    expect(w).toContain("'wiki/dossier.md' is covered by default_visibility 'wiki/**'");
    expect(w).toContain("'wiki/mail.md' is covered by default_visibility 'wiki/**'");
    expect(w).toContain("'wiki/clip.md' is covered by default_visibility 'wiki/**'");
    expect(w).toContain('the default cannot rescue it');
    // the personal/** default covers zero authored notes → warned
    expect(w).toContain("default_visibility pattern 'personal/**' matches no authored notes");
  });

  it('rejected root patterns warn and share nothing', async () => {
    const fp = makeMemoryProvider({ 'notes/a.md': 'authored\n' });
    const { transmitSafe, localOnly } = await scan(
      fp,
      cfg({ default_visibility: { '**': { visibility: 'org' } }, confirmed_authored: ['notes'] }),
    );
    expect(transmitSafe.stats.shareable_notes).toBe(0);
    const w = localOnly.warnings.join('\n');
    expect(w).toContain("default_visibility pattern '**' is invalid");
    expect(w).toContain('deliberate subtree');
  });

  it('zero-match pattern warns even when valid', async () => {
    const fp = makeMemoryProvider({ 'notes/a.md': 'authored\n' });
    const { localOnly } = await scan(
      fp,
      cfg({ default_visibility: { 'wiki/**': { visibility: 'org' } }, confirmed_authored: ['notes'] }),
    );
    expect(localOnly.warnings.join('\n')).toContain(
      "default_visibility pattern 'wiki/**' matches no authored notes",
    );
  });

  it('defaultableByFolder counts exactly the notes a NEW default would share', async () => {
    const fp = makeMemoryProvider({
      'wiki/covered.md': 'already default-shared\n',
      'notes/plain-a.md': 'no frontmatter\n',
      'notes/plain-b.md': 'no frontmatter either\n',
      'notes/optout.md': '---\nvisibility: private\n---\nexplicit\n',
      'notes/shared.md': '---\nvisibility: org\n---\nexplicit\n',
      'notes/mail.md': MAILISH, // demoted — a default could not share it
    });
    const { localOnly } = await scan(
      fp,
      cfg({ default_visibility: WIKI_DEFAULT, confirmed_authored: ['wiki', 'notes'] }),
    );
    expect(localOnly.defaultableByFolder['notes']).toBe(2);
    expect(localOnly.defaultableByFolder['wiki']).toBeUndefined(); // already covered
  });

  it('the wiki-looking-folder warning stops firing once a default covers it', async () => {
    const files = {
      'Wiki/a.md': 'authored a\n',
      'Wiki/b.md': 'authored b\n',
      'Wiki/c.md': 'authored c\n',
    };
    const bare = await scan(makeMemoryProvider(files), cfg());
    expect(bare.localOnly.warnings.join('\n')).toContain('looks like a curated wiki');
    const withDefault = await scan(
      makeMemoryProvider(files),
      cfg({ default_visibility: WIKI_DEFAULT }),
    );
    expect(withDefault.localOnly.warnings.join('\n')).not.toContain('looks like a curated wiki');
    expect(withDefault.transmitSafe.shareable_via_default).toBe(3);
  });
});

describe('config — default_visibility round-trip and helpers', () => {
  it('save + load round-trips rules, including the string shorthand', async () => {
    const fp = makeMemoryProvider({});
    const { cfg: created } = await loadVaultConfig(fp);
    expect(created.default_visibility).toEqual({});
    // generated header documents the section
    expect(await fp.read('.vantell.yml')).toContain('default_visibility');

    const withRules = cloneConfig(created);
    withRules.default_visibility = {
      'wiki/**': { visibility: 'org', max_level: 3 },
      'docs/**': { visibility: 'team' },
    };
    await saveVaultConfig(fp, withRules);
    const { cfg: reloaded } = await loadVaultConfig(fp);
    expect(reloaded.default_visibility).toEqual(withRules.default_visibility);

    // hand-written shorthand form parses too
    await fp.write('.vantell.yml', 'default_visibility:\n  "wiki/**": org\n');
    const { cfg: shorthand } = await loadVaultConfig(fp);
    expect(shorthand.default_visibility).toEqual({ 'wiki/**': { visibility: 'org' } });
  });

  it('withDefaultVisibility / withoutDefaultVisibility merge without mutating', () => {
    const base = cfg({ default_visibility: { 'docs/**': { visibility: 'team' } } });
    const added = withDefaultVisibility(base, 'wiki', 'org');
    expect(added.default_visibility).toEqual({
      'docs/**': { visibility: 'team' },
      'wiki/**': { visibility: 'org' },
    });
    expect(base.default_visibility).toEqual({ 'docs/**': { visibility: 'team' } });
    const removed = withoutDefaultVisibility(added, 'docs');
    expect(removed.default_visibility).toEqual({ 'wiki/**': { visibility: 'org' } });
    expect(added.default_visibility!['docs/**']).toBeDefined();
  });
});

describe('listCandidates — defaulted notes are not candidates', () => {
  it('excludes notes already shareable via a folder default; explicit-private notes stay excluded too', async () => {
    const fp = makeMemoryProvider({
      'wiki/covered.md': LONG_BODY, // default-shared → not a candidate
      'wiki/optout.md': `---\nvisibility: private\n---\n${LONG_BODY}`, // owner decided
      'notes/free.md': LONG_BODY, // genuine candidate
    });
    const withDefault = cfg({ default_visibility: WIKI_DEFAULT, confirmed_authored: ['wiki', 'notes'] });
    const rows = await listCandidates(fp, withDefault);
    expect(rows.map((r) => r.rel)).toEqual(['notes/free.md']);
    // sanity: without the default the wiki note IS a candidate
    const bare = await listCandidates(fp, cfg({ confirmed_authored: ['wiki', 'notes'] }));
    expect(bare.map((r) => r.rel).sort()).toEqual(['notes/free.md', 'wiki/covered.md']);
  });
});
