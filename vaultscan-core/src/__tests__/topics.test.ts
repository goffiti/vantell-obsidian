/** Topic extraction: tags + subfolders make manifests tangible; the cap
 * keeps tag-rich vaults from publishing a 400-label manifest.
 * Mirrored by tests/test_topics.py. */
import { describe, expect, it } from 'vitest';
import { TOPIC_CAP, scan } from '../classify';
import { DEFAULT_VAULT_CONFIG, cloneConfig } from '../config';
import { makeMemoryProvider } from '../memoryProvider';
import type { VaultConfig } from '../types';

function cfg(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return { ...cloneConfig(DEFAULT_VAULT_CONFIG), ...overrides };
}

const SHARED_CFG = { default_visibility: { 'wiki/**': { visibility: 'org' } } };
const BODY = `# T\n\n${'Real authored content here. '.repeat(15)}\n`;

describe('topic labels', () => {
  it('collects tags (list and legacy string), subfolder, and folder', async () => {
    const fp = makeMemoryProvider({
      'wiki/tools/langfuse.md': `---\ntags: [llm-observability, "#evals"]\n---\n${BODY}`,
      'wiki/agents/patterns.md': `---\ntags: multi-agent, orchestration\n---\n${BODY}`,
      'wiki/plain.md': BODY,
    });
    const { transmitSafe } = await scan(fp, cfg(SHARED_CFG));
    const labels = transmitSafe.topics.map((t) => t.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'wiki', // top folder — every shared note
        'tools', // second-level folder
        'agents',
        'llm-observability', // tags list
        'evals', // '#' stripped
        'multi-agent', // legacy comma/space string form
        'orchestration',
      ]),
    );
    expect(transmitSafe.topics.find((t) => t.label === 'wiki')!.notes).toBe(3);
  });

  it('explicit topics: frontmatter still counts, lowercased', async () => {
    const fp = makeMemoryProvider({
      'wiki/a.md': `---\ntopics: [Security]\n---\n${BODY}`,
    });
    const { transmitSafe } = await scan(fp, cfg(SHARED_CFG));
    expect(transmitSafe.topics.map((t) => t.label)).toContain('security');
  });

  it('unshared notes contribute no topics at all', async () => {
    const fp = makeMemoryProvider({
      'private-stuff/x.md': `---\ntags: [secret-project]\n---\n${BODY}`,
    });
    const { transmitSafe } = await scan(fp, cfg());
    expect(transmitSafe.topics).toEqual([]);
  });

  it(`caps at ${TOPIC_CAP} topics with a warning naming the dropped count`, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      files[`wiki/n${String(i).padStart(2, '0')}.md`] =
        `---\ntags: [tag-${String(i).padStart(2, '0')}]\n---\n${BODY}`;
    }
    const fp = makeMemoryProvider(files);
    const { transmitSafe, localOnly } = await scan(fp, cfg(SHARED_CFG));
    expect(transmitSafe.topics).toHaveLength(TOPIC_CAP);
    // 'wiki' (60 notes) survives; the drop hits the low-volume tail.
    expect(transmitSafe.topics[0]!.label).toBe('wiki');
    expect(localOnly.warnings.some((w) => w.includes('capped at 50') && w.includes('11'))).toBe(
      true,
    );
  });
});
