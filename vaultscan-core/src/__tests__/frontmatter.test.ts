import { describe, expect, it } from 'vitest';
import { MALFORMED, parseFrontmatter, serializeNote } from '../frontmatter';

describe('parseFrontmatter', () => {
  it('no frontmatter → {} and the untouched text', () => {
    const { fm, body } = parseFrontmatter('# Hello\n\nWorld\n');
    expect(fm).toEqual({});
    expect(body).toBe('# Hello\n\nWorld\n');
  });

  it('parses a simple block and strips it from the body', () => {
    const { fm, body } = parseFrontmatter('---\nvisibility: team\ntopics: [a, b]\n---\nBody\n');
    expect(fm).toEqual({ visibility: 'team', topics: ['a', 'b'] });
    expect(body).toBe('Body\n');
  });

  it("accepts '...' as a block terminator", () => {
    const { fm, body } = parseFrontmatter('---\ntitle: T\n...\nBody\n');
    expect(fm).toEqual({ title: 'T' });
    expect(body).toBe('Body\n');
  });

  it('unterminated block → MALFORMED with the full text as body', () => {
    const text = '---\ntitle: T\nnever closed\n';
    const { fm, body } = parseFrontmatter(text);
    expect(fm).toBe(MALFORMED);
    expect(body).toBe(text);
  });

  it('invalid YAML → MALFORMED, body still stripped past the block', () => {
    const { fm, body } = parseFrontmatter('---\nnot: [valid\n---\nBody\n');
    expect(fm).toBe(MALFORMED);
    expect(body).toBe('Body\n');
  });

  it('non-mapping YAML (list) → MALFORMED', () => {
    const { fm } = parseFrontmatter('---\n- a\n- b\n---\nBody\n');
    expect(fm).toBe(MALFORMED);
  });

  it('empty block → {}', () => {
    const { fm, body } = parseFrontmatter('---\n---\nBody\n');
    expect(fm).toEqual({});
    expect(body).toBe('Body\n');
  });

  it("'---' with trailing text on line 0 is not a block opener", () => {
    const text = '--- not a block\nBody\n';
    const { fm, body } = parseFrontmatter(text);
    expect(fm).toEqual({});
    expect(body).toBe(text);
  });
});

describe('serializeNote', () => {
  it('empty fm → bare body, byte-exact', () => {
    expect(serializeNote({}, 'raw body\n')).toBe('raw body\n');
  });

  it('creates a --- block ABOVE existing content, body byte-exact', () => {
    const body = '# Note\n\ncontent with trailing spaces   \nand unicode é\n';
    const out = serializeNote({ visibility: 'team' }, body);
    expect(out.startsWith('---\n')).toBe(true);
    const round = parseFrontmatter(out);
    expect(round.fm).toEqual({ visibility: 'team' });
    expect(round.body).toBe(body);
  });

  it('round-trips insertion order (sortKeys: false)', () => {
    const out = serializeNote({ title: 'T', visibility: 'org', topics: ['x'] }, 'b\n');
    const lines = out.split('\n');
    expect(lines[1]).toContain('title');
    expect(out.indexOf('title')).toBeLessThan(out.indexOf('visibility'));
  });
});
