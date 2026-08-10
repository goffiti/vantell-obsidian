/** stripShareFrontmatter — the uninstall sweep removes Vantell's keys and
 * nothing else; the body and foreign metadata survive byte-exactly. */
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../frontmatter';
import { stripShareFrontmatter } from '../mark';

const BODY = '# Title\n\nBody stays byte-identical.\n';

describe('stripShareFrontmatter', () => {
  it('removes visibility/max_level/derived_from, keeps everything else', () => {
    const text = `---\ntitle: Keep me\ntags: [a, b]\ntopics: [security]\nvisibility: org\nmax_level: 3\nderived_from: capture\n---\n${BODY}`;
    const out = stripShareFrontmatter(text);
    if (!out.ok) throw new Error('expected ok');
    expect(out.removed.sort()).toEqual(['derived_from', 'max_level', 'visibility']);
    const { fm, body } = parseFrontmatter(out.content);
    expect(body).toBe(BODY);
    expect(fm).toEqual({ title: 'Keep me', tags: ['a', 'b'], topics: ['security'] });
  });

  it('never removes topics, and leaves foreign visibility values alone', () => {
    const text = `---\nvisibility: custom-workflow-state\ntopics: [mine]\n---\n${BODY}`;
    const out = stripShareFrontmatter(text);
    if (!out.ok) throw new Error('expected ok');
    expect(out.removed).toEqual([]);
    expect(out.content).toBe(text);
  });

  it('untouched notes come back identical; private is a Vantell value', () => {
    const plain = `# No frontmatter\n\nHello.\n`;
    const outPlain = stripShareFrontmatter(plain);
    if (!outPlain.ok) throw new Error('expected ok');
    expect(outPlain.content).toBe(plain);

    const priv = `---\nvisibility: private\n---\n${BODY}`;
    const outPriv = stripShareFrontmatter(priv);
    if (!outPriv.ok) throw new Error('expected ok');
    expect(outPriv.removed).toEqual(['visibility']);
  });

  it('refuses malformed frontmatter instead of guessing', () => {
    const out = stripShareFrontmatter('---\n: not yaml [\n---\nbody\n');
    expect(out.ok).toBe(false);
  });
});
