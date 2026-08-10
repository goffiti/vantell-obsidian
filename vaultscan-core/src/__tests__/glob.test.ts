import { describe, expect, it } from 'vitest';
import { pathMatches } from '../glob';

describe('pathMatches (fnmatch-style, case-insensitive)', () => {
  it('matches simple prefix globs and crosses / like fnmatch', () => {
    expect(pathMatches('Captures/x.md', ['Captures/**'])).toBe(true);
    expect(pathMatches('Captures/deep/nested/x.md', ['Captures/**'])).toBe(true);
    expect(pathMatches('Other/x.md', ['Captures/**'])).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(pathMatches('captures/X.MD', ['Captures/**'])).toBe(true);
    expect(pathMatches('CAPTURES/x.md', ['captures/**'])).toBe(true);
    expect(pathMatches('emails/2020/x.md', ['Email*/**'])).toBe(true);
  });

  it('leading **/ also matches at the vault root', () => {
    expect(pathMatches('a/Emails/x.md', ['**/Email*/**'])).toBe(true);
    expect(pathMatches('Emails/x.md', ['**/Email*/**'])).toBe(true);
    expect(pathMatches('kyp/peeps/jane.md', ['**/peeps/**'])).toBe(true);
    expect(pathMatches('peeps/jane.md', ['**/peeps/**'])).toBe(true);
  });

  it('mid-pattern wildcards: *Mail Archive*/**', () => {
    expect(pathMatches('Cronos Mail Archive/2020/x.md', ['*Mail Archive*/**'])).toBe(true);
    expect(pathMatches('cronos mail archive/x.md', ['*Mail Archive*/**'])).toBe(true);
    expect(pathMatches('Mail/x.md', ['*Mail Archive*/**'])).toBe(false);
  });

  it('? and [seq] behave like fnmatch', () => {
    expect(pathMatches('a1/x.md', ['a?/**'])).toBe(true);
    expect(pathMatches('ab1/x.md', ['a?/**'])).toBe(false);
    expect(pathMatches('v1/x.md', ['v[12]/**'])).toBe(true);
    expect(pathMatches('v3/x.md', ['v[12]/**'])).toBe(false);
    expect(pathMatches('v3/x.md', ['v[!12]/**'])).toBe(true);
  });

  it('regex metacharacters in patterns are literal', () => {
    expect(pathMatches('a+b/x.md', ['a+b/**'])).toBe(true);
    expect(pathMatches('ab/x.md', ['a+b/**'])).toBe(false);
    expect(pathMatches('a.b/x.md', ['a.b/**'])).toBe(true);
    expect(pathMatches('axb/x.md', ['a.b/**'])).toBe(false);
  });

  it('bare * crosses directory separators (fnmatch semantics)', () => {
    // Documented vantell_lib behavior: '*.md' matches root files AND nested paths.
    expect(pathMatches('root.md', ['*.md'])).toBe(true);
    expect(pathMatches('a/b.md', ['*.md'])).toBe(true);
  });
});
