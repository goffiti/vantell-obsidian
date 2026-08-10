/**
 * fnmatch-style glob matching — port of vantell_lib.path_matches.
 *
 * Python's fnmatch treats the path as a flat string: '*' crosses '/', so
 * '**' collapses to '*'. Matching is CASE-INSENSITIVE on both sides, and a
 * leading '**\/' also matches at the vault root.
 */

/** Translate an fnmatch pattern ('*', '?', '[seq]', '[!seq]') to a RegExp.
 * Mirrors Python fnmatch.translate for the subset the config uses. */
export function fnmatchToRegExp(pat: string): RegExp {
  let out = '';
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i]!;
    i += 1;
    if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if (c === '[') {
      let j = i;
      if (j < n && pat[j] === '!') j += 1;
      if (j < n && pat[j] === ']') j += 1;
      while (j < n && pat[j] !== ']') j += 1;
      if (j >= n) {
        out += '\\[';
      } else {
        let stuff = pat.slice(i, j).replace(/\\/g, '\\\\');
        i = j + 1;
        if (stuff.startsWith('!')) stuff = '^' + stuff.slice(1);
        else if (stuff.startsWith('^')) stuff = '\\' + stuff;
        out += `[${stuff}]`;
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // 's' flag: '.' crosses newlines, like Python's (?s:...)\Z translation.
  return new RegExp(`^(?:${out})$`, 's');
}

/**
 * Glob match of a posix relpath against patterns like 'Captures/**' or
 * '**\/Email/**'. Case-insensitive, '**' collapsed to '*', and a leading
 * '**\/' variant matched at the root — exactly vantell_lib.path_matches.
 */
export function pathMatches(relpath: string, patterns: readonly string[]): boolean {
  const rp = relpath.toLowerCase();
  for (const pat of patterns) {
    const p = String(pat).toLowerCase();
    const candidates = new Set<string>([p]);
    if (p.startsWith('**/')) candidates.add(p.slice(3));
    for (const c of candidates) {
      if (fnmatchToRegExp(c.split('**').join('*')).test(rp)) return true;
    }
  }
  return false;
}
