/**
 * Tolerant YAML frontmatter parsing + writing — port of
 * vantell_lib.parse_frontmatter and mark.py's serialize().
 *
 * The writer preserves the note body BYTE-EXACTLY: only the '---' block is
 * (re)generated, and it is prepended above existing content when absent.
 */
import yaml from 'js-yaml';

/** Sentinel: frontmatter present but unparseable → callers treat the note as
 * private and count a warning. */
export const MALFORMED: unique symbol = Symbol('malformed-frontmatter');

export type Frontmatter = Record<string, unknown> | typeof MALFORMED;

export interface ParsedNote {
  fm: Frontmatter;
  body: string;
}

/** splitlines(keepends=True) equivalent for \n / \r\n line endings. */
function splitKeepEnds(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Return {fm, body}. fm is {} when no frontmatter, a mapping when parsed, or
 * MALFORMED when a leading '---' block exists but is not a valid YAML
 * mapping.
 */
export function parseFrontmatter(text: string): ParsedNote {
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const lines = splitKeepEnds(text);
  if (lines.length === 0 || lines[0]!.trim() !== '---') return { fm: {}, body: text };
  let end: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === '---' || t === '...') {
      end = i;
      break;
    }
  }
  if (end === null) return { fm: MALFORMED, body: text };
  const raw = lines.slice(1, end).join('');
  const body = lines.slice(end + 1).join('');
  let fm: unknown;
  try {
    fm = yaml.load(raw);
  } catch {
    return { fm: MALFORMED, body };
  }
  if (fm === null || fm === undefined) return { fm: {}, body };
  if (!isPlainObject(fm)) return { fm: MALFORMED, body };
  return { fm, body };
}

/** Serialize fm + body — mark.py's serialize(): '---\n<yaml>---\n<body>',
 * or the bare body when fm is empty. The body is appended untouched. */
export function serializeNote(fm: Record<string, unknown>, body: string): string {
  if (Object.keys(fm).length === 0) return body;
  const block = yaml.dump(fm, { sortKeys: false, lineWidth: -1 });
  return '---\n' + block + '---\n' + body;
}
