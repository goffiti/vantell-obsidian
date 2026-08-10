/**
 * Suspicion heuristics — port of the vantell_lib section of the same name.
 *
 * Field finding: real vaults keep mail archives, chat exports and person
 * dossiers under names the defaults never guessed and in files with
 * plain-text 'Name: X' headers instead of YAML frontmatter. These heuristics
 * catch both. They are DEMOTE-ONLY: a hit can only make a note more private
 * (capture/person), never shareable.
 */

export const SUSPECT_FOLDER_TOKENS: readonly string[] = [
  'mail', 'email', 'inbox', 'chat', 'transcript', 'meeting', 'calendar',
  'granola', 'evernote', 'clipping', 'archive', 'peep', 'people', 'person',
  'contact', 'crm', 'dossier',
  // chat/collab export tools (field: a Teams/ channel-export folder slipped
  // the gate on name alone)
  'teams', 'slack', 'discord', 'whatsapp', 'signal', 'imessage', 'messages',
];

const PERSON_HEADER_RES: RegExp[] = [
  /^Name:\s/i, /^Email:\s/i, /^Role:\s/i, /^Company:\s/i,
  /^LinkedIn:\s/i, /^Phone:\s/i,
];

const CAPTURE_HEADER_RES: RegExp[] = [
  /^From:\s/i, /^To:\s/i, /^Subject:\s/i, /^Date:\s/i,
];

const CHAT_TS_RE = /^\s*[[(]?\d{1,2}:\d{2}/;

const HIDDEN_CONTENT_RE = /%%|<!--/;

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Return the matching dictionary token if ANY path segment of the folder
 * (case-insensitive) contains a capture/person-suggestive word, else null. */
export function folderNameSuspicion(folderRel: string): string | null {
  for (const seg of folderRel.split('/')) {
    const s = seg.toLowerCase();
    for (const tok of SUSPECT_FOLDER_TOKENS) {
      if (s.includes(tok)) return tok;
    }
  }
  return null;
}

/** Plain-text person dossier: >= 2 of Name:/Email:/Role:/Company:/LinkedIn:/
 * Phone: header lines within the first 15 lines of the body (frontmatter
 * already stripped by the caller). */
export function looksPersonNote(body: string): boolean {
  const head = splitLines(body).slice(0, 15);
  let n = 0;
  for (const re of PERSON_HEADER_RES) {
    if (head.some((ln) => re.test(ln))) n += 1;
  }
  return n >= 2;
}

/** Mail-shaped capture: >= 2 of From:/To:/Subject:/Date: header lines within
 * the first 15 lines of the body. */
export function looksCaptureNote(body: string): boolean {
  const head = splitLines(body).slice(0, 15);
  let n = 0;
  for (const re of CAPTURE_HEADER_RES) {
    if (head.some((ln) => re.test(ln))) n += 1;
  }
  return n >= 2;
}

/** Chat export: at least 5 of the first 40 non-empty lines (of the first 80)
 * start with a timestamp like '[00:12]', '(9:41', '14:03 ...'. */
export function chatLogDominated(body: string): boolean {
  const lines = splitLines(body).slice(0, 80).filter((ln) => ln.trim() !== '').slice(0, 40);
  const hits = lines.filter((ln) => CHAT_TS_RE.test(ln)).length;
  return hits >= 5 && hits * 2 >= lines.length;
}

/** Hidden-content awareness (§1.4): %%…%% or HTML comments a reading view
 * would hide. Feeds a warning only — bodies are never exported. */
export function hasHiddenContent(body: string): boolean {
  return HIDDEN_CONTENT_RE.test(body);
}
