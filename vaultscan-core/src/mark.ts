/**
 * Frontmatter-writing semantics — port of mark.py.
 *
 * Body preserved byte-exactly; '---' block created above content if absent;
 * REFUSES on capture/person/excluded/regex-hit/malformed classification —
 * the categorical rules of build-spec §1.0 bind this module too.
 */
import { displayValue } from './display';
import { MALFORMED, parseFrontmatter, serializeNote, type Frontmatter } from './frontmatter';
import { pathMatches } from './glob';
import { looksCaptureNote, looksPersonNote } from './heuristics';
import {
  compileRegexes,
  matchDefaultVisibility,
  resolveDefaultVisibility,
  type CompiledRegexes,
} from './config';
import { SHAREABLE_VIS } from './types';
import type { FileProvider, ShareVisibility, VaultConfig } from './types';

export const DEFAULT_MIN_CHARS = 300;
export const DERIVED_MAX_LEVEL = 2; // build-spec §8: derived notes get a stricter ceiling

const SHARE_KEYS = ['visibility', 'topics', 'max_level', 'derived_from'] as const;

// Person-name-shaped title: 2-4 words, first strictly Capitalized, rest
// capitalized (initials allowed). DEMOTE-ONLY: false positives merely hide
// a note from the candidates list.
const PERSON_TITLE_RE = /^[A-Z][a-z'’.-]+(?: [A-Z][a-zA-Z'’.-]*\.?){1,3}$/;

const MD_LINK_RE = /\[\[[^\]]+\]\]|\]\(/g;
const HEADING_RE = /^#{1,6}\s+\S/m;

export type Bucket = 'capture' | 'person' | 'excluded' | 'malformed' | 'regex' | 'authored';

export interface Classification {
  bucket: Bucket;
  reason: string;
}

/** Mirror scan.py's per-note pipeline (steps 1-6, same order). 'authored'
 * is the only markable bucket. */
export function classifyNote(
  rel: string,
  fm: Frontmatter,
  body: string,
  cfg: VaultConfig,
  compiled: CompiledRegexes,
): Classification {
  const malformed = fm === MALFORMED;
  const fmd: Record<string, unknown> = malformed ? {} : fm;

  // 1. capture layer — categorical (§1.0)
  if (pathMatches(rel, cfg.capture_paths ?? []) || fmd['source'] === 'capture') {
    return {
      bucket: 'capture',
      reason:
        "capture layer (capture_paths or 'source: capture') — categorically unshareable (§1.0)",
    };
  }
  // 2. person subject — categorical (§1.0)
  if (pathMatches(rel, cfg.person_paths ?? []) || fmd['subject'] === 'person') {
    return {
      bucket: 'person',
      reason:
        "person-subject (person_paths or 'subject: person') — categorically unshareable (§1.0)",
    };
  }
  // 2b. content heuristics — DEMOTE-ONLY
  if (looksPersonNote(body)) {
    return {
      bucket: 'person',
      reason:
        'content heuristic: body has plain-text person-dossier headers (Name:/Email:/Role:/...) — demoted to person-subject, categorically unshareable',
    };
  }
  if (looksCaptureNote(body)) {
    return {
      bucket: 'capture',
      reason:
        'content heuristic: body has mail headers (From:/To:/Subject:/Date:) — demoted to capture layer, categorically unshareable',
    };
  }
  // 3. owner's exclude list
  if (pathMatches(rel, cfg.exclude_paths ?? [])) {
    return { bucket: 'excluded', reason: 'under exclude_paths in .vantell.yml' };
  }
  // 4. malformed frontmatter
  if (malformed) {
    return {
      bucket: 'malformed',
      reason:
        'frontmatter present but unparseable — the scan treats this as private; fix the YAML block first',
    };
  }
  // 5. regex bail-out
  const hit = compiled.regexes.find((r) => r.re.test(body));
  if (hit) {
    return {
      bucket: 'regex',
      reason: `body matches exclude pattern /${hit.pattern}/ — the scan would exclude it anyway; edit the note or .vantell.yml first`,
    };
  }
  // 6. authored
  return { bucket: 'authored', reason: '' };
}

/* ------------------------------------------------------------- candidates */

export interface ShareCandidate {
  rel: string;
  title: string;
  words: number;
  score: number;
  topicsGuess: string[];
}

function noteSignals(body: string): { words: number; hasHeadings: boolean; linkDensity: number } {
  const words = body.split(/\s+/).filter((w) => w !== '').length;
  const hasHeadings = HEADING_RE.test(body);
  const links = (body.match(MD_LINK_RE) ?? []).length;
  const linkDensity = (links / Math.max(words, 1)) * 100;
  return { words, hasHeadings, linkDensity };
}

function guessTopics(rel: string, body: string): string[] {
  const labels: string[] = [];
  if (rel.includes('/')) labels.push(rel.split('/')[0]!.toLowerCase());
  for (const ln of body.split(/\r\n|\r|\n/)) {
    if (ln.startsWith('#')) {
      const h = ln.replace(/^#+/, '').trim().toLowerCase().slice(0, 32);
      if (h && !labels.includes(h)) labels.push(h);
    }
    if (labels.length >= 3) break;
  }
  return labels;
}

/** Authored-layer notes that are candidates for sharing: classified authored
 * by the exact scan pipeline, NOT already shareable after defaults — i.e.
 * no explicit visibility key AND not covered by a default_visibility rule
 * (§1.1: defaulted notes are shareable already, so ticking them would be
 * redundant) — body >= minChars, title not person-name-shaped. Ranked. */
export async function listCandidates(
  fp: FileProvider,
  cfg: VaultConfig,
  minChars: number = DEFAULT_MIN_CHARS,
): Promise<ShareCandidate[]> {
  const compiled = compileRegexes(cfg.exclude_if_matches ?? []);
  const { rules: defaultRules } = resolveDefaultVisibility(cfg);
  const rows: ShareCandidate[] = [];
  for (const rel of await fp.listMarkdown()) {
    let text: string;
    try {
      text = await fp.read(rel);
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(text);
    const { bucket } = classifyNote(rel, fm, body, cfg, compiled);
    if (bucket !== 'authored') continue;
    const fmd = fm === MALFORMED ? {} : fm;
    if (fmd['visibility'] !== undefined && fmd['visibility'] !== null) continue; // owner already decided
    if (matchDefaultVisibility(rel, defaultRules)) continue; // already shareable via folder default
    if (body.trim().length < minChars) continue;
    const titleFm = fmd['title'];
    const title =
      typeof titleFm === 'string'
        ? titleFm.trim()
        : (rel.split('/').pop() ?? rel).replace(/\.[^.]*$/, '');
    if (PERSON_TITLE_RE.test(title)) continue; // demote-only title heuristic
    const { words, hasHeadings, linkDensity } = noteSignals(body);
    const score =
      Math.round(
        (Math.log2(1 + words) + (hasHeadings ? 2.0 : 0.0) + Math.min(linkDensity, 3.0)) * 10,
      ) / 10;
    rows.push({ rel, title, words, score, topicsGuess: guessTopics(rel, body) });
  }
  rows.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.rel < b.rel ? -1 : 1));
  return rows;
}

/* -------------------------------------------------------------------- set */

export interface MarkOptions {
  visibility: ShareVisibility;
  topics?: string[];
  maxLevel?: number;
  derivedFrom?: 'capture';
}

export type MarkOutcome =
  | { ok: true; content: string; changes: string[]; bodyBytes: number }
  | { ok: false; refused: Classification };

/**
 * Compute the rewritten note for a sharing decision — mark.py `set`.
 * Preserves every existing frontmatter key and the body byte-exactly;
 * refuses on any non-authored classification. Pure: caller writes the file.
 */
export function markNote(
  rel: string,
  text: string,
  cfg: VaultConfig,
  opts: MarkOptions,
): MarkOutcome {
  const compiled = compileRegexes(cfg.exclude_if_matches ?? []);
  const { fm, body } = parseFrontmatter(text);
  const cls = classifyNote(rel, fm, body, cfg, compiled);
  if (cls.bucket !== 'authored') return { ok: false, refused: cls };

  // classifyNote never returns 'authored' for malformed frontmatter, but the
  // type system can't see that — narrow explicitly.
  const fmd: Record<string, unknown> = fm === MALFORMED ? {} : { ...fm };
  const changes: string[] = [];

  let maxLevel = opts.maxLevel ?? null;
  if (opts.derivedFrom) {
    if (fmd['derived_from'] !== opts.derivedFrom) {
      changes.push(
        `derived_from: ${displayValue(fmd['derived_from'] ?? 'none')} -> ${opts.derivedFrom}`,
      );
    }
    const requested = maxLevel !== null ? maxLevel : DERIVED_MAX_LEVEL;
    maxLevel = Math.min(requested, DERIVED_MAX_LEVEL); // build-spec §8 ceiling
    fmd['derived_from'] = opts.derivedFrom;
  }

  if (fmd['visibility'] !== opts.visibility) {
    changes.push(`visibility: ${displayValue(fmd['visibility'] ?? 'none')} -> ${opts.visibility}`);
  }
  fmd['visibility'] = opts.visibility;

  if (opts.topics !== undefined) {
    const topics = opts.topics.map((t) => t.trim()).filter((t) => t !== '');
    if (topics.length > 0) {
      const prev = fmd['topics'];
      if (JSON.stringify(prev) !== JSON.stringify(topics)) {
        changes.push(`topics: ${JSON.stringify(prev ?? 'none')} -> ${JSON.stringify(topics)}`);
      }
      fmd['topics'] = topics;
    }
  }

  if (maxLevel !== null) {
    if (fmd['max_level'] !== maxLevel) {
      changes.push(`max_level: ${displayValue(fmd['max_level'] ?? 'none')} -> ${maxLevel}`);
    }
    fmd['max_level'] = maxLevel;
  }

  const content = serializeNote(fmd, body);
  // invariant check: the body must survive byte-exactly
  const round = parseFrontmatter(content);
  if (round.body !== body || round.fm === MALFORMED) {
    throw new Error('internal: rewrite would not round-trip — nothing written');
  }
  return { ok: true, content, changes, bodyBytes: new TextEncoder().encode(body).length };
}

/** Explicitly opt a note OUT of sharing: `visibility: private`. This is the
 * correct "stop sharing" for a note inside a shared-by-default folder —
 * merely removing the key (unmarkNote) would fall back into the folder's
 * default_visibility rule and keep it shared. Body survives byte-exactly. */
export function markNotePrivate(
  text: string,
): { ok: true; content: string; changed: boolean } | { ok: false; reason: string } {
  const { fm, body } = parseFrontmatter(text);
  if (fm === MALFORMED) {
    return { ok: false, reason: 'malformed frontmatter — fix the YAML block by hand first' };
  }
  const fmd: Record<string, unknown> = { ...fm };
  if (fmd['visibility'] === 'private') return { ok: true, content: text, changed: false };
  fmd['visibility'] = 'private';
  const content = serializeNote(fmd, body);
  const round = parseFrontmatter(content);
  if (round.body !== body || round.fm === MALFORMED) {
    throw new Error('internal: rewrite would not round-trip — nothing written');
  }
  return { ok: true, content, changed: true };
}

/**
 * Uninstall sweep: remove Vantell's own frontmatter from a note — and ONLY
 * Vantell's. Conservative on purpose, so an uninstall can never destroy the
 * owner's pre-existing metadata:
 *   - `visibility` is removed only when it holds a Vantell value
 *     (private|team|org|federation);
 *   - `max_level` only when it is the 0-4 integer Vantell writes;
 *   - `derived_from` only when it is Vantell's 'capture';
 *   - `topics` is NEVER removed — it is generic metadata that commonly
 *     predates Vantell, and deleting it would not restore the vault, it
 *     would damage it.
 * Body survives byte-exactly (round-trip enforced).
 */
export function stripShareFrontmatter(
  text: string,
): { ok: true; content: string; removed: string[] } | { ok: false; reason: string } {
  const { fm, body } = parseFrontmatter(text);
  if (fm === MALFORMED) {
    return { ok: false, reason: 'malformed frontmatter — fix the YAML block by hand first' };
  }
  const fmd: Record<string, unknown> = { ...fm };
  const removed: string[] = [];
  const vis = fmd['visibility'];
  if (typeof vis === 'string' && (vis === 'private' || SHAREABLE_VIS.includes(vis))) {
    delete fmd['visibility'];
    removed.push('visibility');
  }
  const ml = fmd['max_level'];
  if (typeof ml === 'number' && Number.isInteger(ml) && ml >= 0 && ml <= 4) {
    delete fmd['max_level'];
    removed.push('max_level');
  }
  if (fmd['derived_from'] === 'capture') {
    delete fmd['derived_from'];
    removed.push('derived_from');
  }
  if (removed.length === 0) return { ok: true, content: text, removed: [] };
  const content = serializeNote(fmd, body);
  const round = parseFrontmatter(content);
  if (round.body !== body || round.fm === MALFORMED) {
    throw new Error('internal: rewrite would not round-trip — nothing written');
  }
  return { ok: true, content, removed };
}

/** Remove sharing keys — mark.py `unset`. Never refused except on malformed
 * frontmatter (won't guess at broken structure). */
export function unmarkNote(
  text: string,
): { ok: true; content: string; removed: string[] } | { ok: false; reason: string } {
  const { fm, body } = parseFrontmatter(text);
  if (fm === MALFORMED) {
    return { ok: false, reason: 'malformed frontmatter — fix the YAML block by hand first' };
  }
  const fmd: Record<string, unknown> = { ...fm };
  const removed = SHARE_KEYS.filter((k) => k in fmd);
  if (removed.length === 0) return { ok: true, content: text, removed: [] };
  for (const k of removed) delete fmd[k];
  return { ok: true, content: serializeNote(fmd, body), removed: [...removed] };
}
