import { describe, expect, it } from 'vitest';
import { listCandidates, markNote, unmarkNote } from '../mark';
import { parseFrontmatter, MALFORMED } from '../frontmatter';
import { scan } from '../classify';
import { DEFAULT_VAULT_CONFIG } from '../config';
import { makeMemoryProvider } from '../memoryProvider';
import type { VaultConfig } from '../types';

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

const LONG_BODY = `# Rollout plan\n\n${'Substantial authored content. '.repeat(20)}\n`;

describe('markNote — frontmatter writing', () => {
  it('creates a --- block above a plain note, body byte-identical', () => {
    const body = '# Note\n\nplain content, no frontmatter\nwith trailing spaces  \n';
    const out = markNote('Notes/a.md', body, cfg(), { visibility: 'team' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toBe('---\nvisibility: team\n---\n' + body);
    const round = parseFrontmatter(out.content);
    expect(round.body).toBe(body);
    expect(out.changes).toEqual(['visibility: none -> team']);
  });

  it('merges into existing YAML preserving keys and body byte-exact', () => {
    const body = '# T\n\ncontent é unicode\n';
    const text = `---\ntitle: Existing\ncustom: kept\n---\n${body}`;
    const out = markNote('Notes/a.md', text, cfg(), {
      visibility: 'org',
      topics: ['ai', 'agents'],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const round = parseFrontmatter(out.content);
    expect(round.fm).toEqual({
      title: 'Existing',
      custom: 'kept',
      visibility: 'org',
      topics: ['ai', 'agents'],
    });
    expect(round.body).toBe(body);
    // existing keys stay first (insertion order preserved)
    expect(out.content.indexOf('title')).toBeLessThan(out.content.indexOf('visibility'));
  });

  it('derived_from caps max_level at 2 (build-spec §8)', () => {
    const out = markNote('Notes/a.md', 'authored derivation\n', cfg(), {
      visibility: 'org',
      derivedFrom: 'capture',
      maxLevel: 4,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { fm } = parseFrontmatter(out.content);
    expect(fm).not.toBe(MALFORMED);
    expect((fm as Record<string, unknown>)['max_level']).toBe(2);
    expect((fm as Record<string, unknown>)['derived_from']).toBe('capture');
  });

  it('refuses capture-path files categorically', () => {
    const out = markNote('Emails/x.md', 'anything\n', cfg(), { visibility: 'org' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refused.bucket).toBe('capture');
    expect(out.refused.reason).toContain('categorically unshareable');
  });

  it('refuses person-dossier content (heuristic demotion)', () => {
    const out = markNote('Notes/j.md', 'Name: Jane Doe\nEmail: j@x.com\n\nnotes\n', cfg(), {
      visibility: 'team',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refused.bucket).toBe('person');
  });

  it('refuses excluded paths, regex hits, and malformed frontmatter', () => {
    const excl = markNote('Personal/x.md', 'mine\n', cfg(), { visibility: 'team' });
    expect(!excl.ok && excl.refused.bucket).toBe('excluded');
    const rgx = markNote('Notes/x.md', 'the salary numbers\n', cfg(), { visibility: 'team' });
    expect(!rgx.ok && rgx.refused.bucket).toBe('regex');
    const mal = markNote('Notes/x.md', '---\nnot: [valid\n---\nbody\n', cfg(), {
      visibility: 'team',
    });
    expect(!mal.ok && mal.refused.bucket).toBe('malformed');
  });

  it('unmarkNote removes exactly the sharing keys', () => {
    const text = '---\ntitle: T\nvisibility: org\ntopics: [a]\nmax_level: 2\n---\nBody\n';
    const out = unmarkNote(text);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removed).toEqual(['visibility', 'topics', 'max_level']);
    const round = parseFrontmatter(out.content);
    expect(round.fm).toEqual({ title: 'T' });
    expect(round.body).toBe('Body\n');
  });
});

describe('listCandidates', () => {
  it('filters to authored, private, substantial, non-person-titled notes', async () => {
    const fp = makeMemoryProvider({
      'Notes/good-plan.md': LONG_BODY,
      'Notes/short.md': 'too short\n',
      'Notes/decided.md': `---\nvisibility: private\n---\n${LONG_BODY}`,
      'Notes/John Smith.md': LONG_BODY, // person-shaped title → hidden
      'Emails/cap.md': LONG_BODY, // capture path → not authored
    });
    const rows = await listCandidates(fp, cfg());
    expect(rows.map((r) => r.rel)).toEqual(['Notes/good-plan.md']);
    expect(rows[0]!.topicsGuess).toContain('notes');
    expect(rows[0]!.words).toBeGreaterThan(50);
  });

  it('shareable count rises after marking a candidate', async () => {
    const fp = makeMemoryProvider({
      'Notes/candidate.md': LONG_BODY,
      'Notes/other.md': 'small\n',
    });
    const before = await scan(fp, cfg());
    expect(before.transmitSafe.stats.shareable_notes).toBe(0);

    const rows = await listCandidates(fp, cfg());
    expect(rows).toHaveLength(1);
    const marked = markNote(rows[0]!.rel, await fp.read(rows[0]!.rel), cfg(), {
      visibility: 'org',
      topics: ['rollouts'],
    });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;
    await fp.write(rows[0]!.rel, marked.content);

    const after = await scan(fp, cfg());
    expect(after.transmitSafe.stats.shareable_notes).toBe(1);
    expect(after.transmitSafe.topics.map((t) => t.label)).toContain('rollouts');
    // marking is no longer a candidate on the next pass
    expect(await listCandidates(fp, cfg())).toHaveLength(0);
  });
});
