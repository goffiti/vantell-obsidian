/**
 * report_scope: selected — only shared-from folders keep their names in the
 * vault report; everything else aggregates into "(private folders)".
 * Mirrored by the Python suite (tests/test_report_scope.py).
 */
import { describe, expect, it } from 'vitest';
import { PRIVATE_AGG, scan } from '../classify';
import { DEFAULT_VAULT_CONFIG, cloneConfig, resolveReportScope } from '../config';
import { makeMemoryProvider } from '../memoryProvider';
import type { VaultConfig } from '../types';

function cfg(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return { ...cloneConfig(DEFAULT_VAULT_CONFIG), ...overrides };
}

const BODY = `# Note\n\n${'Substantial authored content. '.repeat(20)}\n`;
const SHARED = `---\nvisibility: org\n---\n${BODY}`;

const VAULT = {
  'wiki/how-we-deploy.md': BODY,
  'wiki/oncall.md': BODY,
  'projects/secret-thing.md': BODY,
  'projects/other.md': BODY,
  'ideas/startup.md': BODY,
  'notes-at-root.md': BODY,
  'Email Sync/msg.md': 'From: a@x\nTo: b@x\nSubject: s\nDate: d\n\nbody\n',
};

describe('resolveReportScope', () => {
  it("absent and 'all' resolve to all; 'selected' to selected", () => {
    expect(resolveReportScope(cfg())).toEqual({ scope: 'all', warning: null });
    expect(resolveReportScope(cfg({ report_scope: 'all' })).scope).toBe('all');
    expect(resolveReportScope(cfg({ report_scope: 'selected' })).scope).toBe('selected');
  });

  it('fails CLOSED on unknown values, with a warning', () => {
    const r = resolveReportScope(cfg({ report_scope: 'slected' }));
    expect(r.scope).toBe('selected');
    expect(r.warning).toContain('fail closed');
  });
});

describe('scan with report_scope: selected', () => {
  it('names only rule-selected folders; the rest aggregate with names local-only', async () => {
    const fp = makeMemoryProvider(VAULT);
    const c = cfg({
      report_scope: 'selected',
      default_visibility: { 'wiki/**': { visibility: 'org' } },
    });
    const { transmitSafe, localOnly } = await scan(fp, c);

    const paths = transmitSafe.folders.map((f) => f.path);
    expect(paths).toContain('wiki');
    expect(paths).toContain(PRIVATE_AGG[0]);
    expect(paths).toContain('(capture folders)'); // Email Sync stays a locked agg
    expect(paths).not.toContain('projects');
    expect(paths).not.toContain('ideas');
    expect(paths).not.toContain('(root)');

    const priv = transmitSafe.folders.find((f) => f.path === PRIVATE_AGG[0])!;
    expect(priv.note_count).toBe(4); // projects(2) + ideas(1) + (root)(1)
    expect(priv.locked).toBe(true);
    expect(priv.sample_titles).toEqual([]);

    // Real names stay local, tagged 'private'.
    const privLocal = localOnly.lockedLocal.filter((l) => l.kind === 'private');
    expect(privLocal.map((l) => l.path).sort()).toEqual(['(root)', 'ideas', 'projects']);

    // Stats and topics are unaffected by the scope.
    expect(transmitSafe.stats.total_notes).toBe(7);
    expect(transmitSafe.stats.shareable_notes).toBe(2);
    expect(transmitSafe.topics.map((t) => t.label)).toEqual(['wiki']);
  });

  it('an explicitly shared note selects its folder (and root)', async () => {
    const fp = makeMemoryProvider({ ...VAULT, 'projects/other.md': SHARED, 'notes-at-root.md': SHARED });
    const { transmitSafe } = await scan(fp, cfg({ report_scope: 'selected' }));
    const paths = transmitSafe.folders.map((f) => f.path);
    expect(paths).toContain('projects');
    expect(paths).toContain('(root)');
    expect(paths).not.toContain('wiki');
    expect(paths).not.toContain('ideas');
  });

  it('a rule that covers zero notes still selects (and still warns)', async () => {
    const fp = makeMemoryProvider(VAULT);
    const c = cfg({
      report_scope: 'selected',
      default_visibility: { 'wiki/missing-subfolder/**': { visibility: 'org' } },
    });
    const { transmitSafe, localOnly } = await scan(fp, c);
    expect(transmitSafe.folders.map((f) => f.path)).toContain('wiki');
    expect(localOnly.warnings.some((w) => w.includes('matches no authored notes'))).toBe(true);
  });

  it("report_scope: all (and absent) keeps today's behavior", async () => {
    const fp = makeMemoryProvider(VAULT);
    for (const c of [cfg(), cfg({ report_scope: 'all' })]) {
      const { transmitSafe } = await scan(fp, c);
      const paths = transmitSafe.folders.map((f) => f.path);
      expect(paths).toEqual(expect.arrayContaining(['wiki', 'projects', 'ideas', '(root)']));
      expect(paths).not.toContain(PRIVATE_AGG[0]);
    }
  });

  it('unknown scope value scans fail-closed and surfaces the warning', async () => {
    const fp = makeMemoryProvider(VAULT);
    const { transmitSafe, localOnly } = await scan(fp, cfg({ report_scope: 'everything' }));
    expect(transmitSafe.folders.map((f) => f.path)).toContain(PRIVATE_AGG[0]);
    expect(localOnly.warnings.some((w) => w.includes('fail closed'))).toBe(true);
  });
});
