/**
 * "Draft from my notes" — optional, opt-in AI drafting for a knock answer.
 *
 * PRIVACY CONTRACT (stated to the user before first use, in the README, and
 * in Settings):
 *   - This is the ONE place note *content* can leave the device, and only:
 *       · when the owner explicitly clicks "Draft from my notes",
 *       · reading ONLY shareable notes matching the request's topic (the same
 *         notes the owner already consented to summarize by approving the
 *         knock), never locked/private/unchosen notes,
 *       · to the owner's OWN Anthropic account, using the owner's API key.
 *   - The draft lands in the editable answer box. Nothing is sent to the
 *     asker until the owner reviews it and clicks Send. This never auto-answers.
 *
 * The key lives in device-local storage (never synced), like the signing key.
 */
import { requestUrl, type App } from 'obsidian';
import {
  SHAREABLE_VIS,
  classifyNote,
  compileRegexes,
  loadVaultConfig,
  matchDefaultVisibility,
  noteTopicLabels,
  parseFrontmatter,
  resolveDefaultVisibility,
  MALFORMED,
} from '@vantell/vaultscan-core';
import { loadLocalSecret, saveLocalSecret } from './identity';
import { makeObsidianProvider } from './provider';

const API_KEY_STORE = 'vantell-anthropic-key';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_SOURCE_NOTES = 5;
const MAX_NOTE_CHARS = 1500; // per note (after condensing), to bound size + cost

/** Sections that are link-lists / metadata, not substance — dropped from the
 * excerpt a draft sees. */
const DROP_SECTIONS = [
  'entities',
  'concepts',
  'sources',
  'related',
  'where it shows up',
  'klanten',
  'pricing',
  'open questions',
];

/** Strip a note down to what actually helps draft an answer: drop Obsidian
 * link scaffolding (wikilinks, "(→ …)" reference arrows), callout blocks, and
 * metadata-only sections. Cuts prompt size (and API cost) a lot without
 * losing the prose that carries the owner's actual thinking. */
export function condenseNote(body: string): string {
  const kept: string[] = [];
  let skip = false;
  for (const line of body.split('\n')) {
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (h) {
      const name = h[1]!.toLowerCase().replace(/[*_`]/g, '').trim();
      skip = DROP_SECTIONS.some((d) => name.startsWith(d));
      if (!skip) kept.push(line);
      continue;
    }
    if (skip) continue;
    if (/^\s*>/.test(line)) continue; // blockquote / callout
    kept.push(line);
  }
  return kept
    .join('\n')
    // [[path/to/thing|Alias]] → Alias ; [[path/to/thing]] → thing
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, (_m, p: string) => p.split('/').pop() ?? p)
    // trailing reference arrows: "— (→ …)" / "(→ …)"
    .replace(/\s*[—-]?\s*\(→[^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const DEFAULT_MODEL = 'claude-opus-5';
export const MODEL_CHOICES: { value: string; label: string }[] = [
  { value: 'claude-opus-5', label: 'Claude Opus 5 (most capable)' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (balanced)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
];

export function loadApiKey(app: App): string | null {
  return loadLocalSecret(app, API_KEY_STORE);
}

export function saveApiKey(app: App, key: string | null): void {
  saveLocalSecret(app, API_KEY_STORE, key);
}

export function hasApiKey(app: App): boolean {
  return loadApiKey(app) !== null;
}

export interface DraftSource {
  rel: string;
  title: string;
  body: string;
}

export interface DraftGather {
  notes: DraftSource[];
  /** True when at least one note actually relates to the topic (label or
   * words). False means we fell back to recent shareable notes. */
  topicMatched: boolean;
}

/** Topic words for loose matching: individual words ≥3 chars, plus a
 * de-pluralized variant so "agents" catches "agent". The full phrase is
 * scored separately (higher). */
function topicTokens(topic: string): string[] {
  const spaced = topic.toLowerCase().replace(/[-_/]+/g, ' ').trim();
  const toks = new Set<string>();
  for (const w of spaced.split(/\s+/)) {
    if (w.length >= 3) {
      toks.add(w);
      if (w.endsWith('s')) toks.add(w.slice(0, -1));
    }
  }
  return [...toks];
}

/** Auto-generated aggregations (news digests, source registries, changelogs)
 * are link/checkbox rolls, not the owner's own conclusions — worthless as
 * "what do you know" material and huge. Detect and exclude them from drafts. */
function looksLikeLinkRoll(title: string, body: string): boolean {
  if (/\b(digest|nieuws|newsletter|registry|changelog|roundup|source registry)\b/i.test(title)) {
    return true;
  }
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 8) return false;
  const listy = lines.filter(
    (l) => /https?:\/\//.test(l) || /^\s*[-*]\s*\[[ x\-]?\]/.test(l),
  ).length;
  return listy / lines.length > 0.35;
}

/** Shareable notes to draft from, best-first. Only authored + shareable notes
 * are ever eligible (same classification as the scanner). Relevance to the
 * knock topic is a PREFERENCE, not a hard filter — the owner already decided
 * they can answer by approving the knock, so if nothing carries the topic we
 * fall back to their most recent shareable notes and let their Claude judge
 * relevance. Capped in count and per-note length. */
export async function gatherDraftSources(app: App, topic: string | null): Promise<DraftGather> {
  const fp = makeObsidianProvider(app);
  const { cfg } = await loadVaultConfig(fp);
  const compiled = compileRegexes(cfg.exclude_if_matches ?? []);
  const dv = resolveDefaultVisibility(cfg);
  const phrase = topic ? topic.toLowerCase().replace(/[-_/]+/g, ' ').trim() : '';
  const tokens = topic ? topicTokens(topic) : [];

  interface Scored extends DraftSource {
    score: number;
    mtime: number;
  }
  const all: Scored[] = [];
  for (const rel of await fp.listMarkdown()) {
    let text: string;
    try {
      text = await fp.read(rel);
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(text);
    if (fm === MALFORMED) continue;
    const fmd = fm as Record<string, unknown>;
    if (classifyNote(rel, fm, body, cfg, compiled).bucket !== 'authored') continue;
    const vis = fmd['visibility'];
    const shareable =
      (typeof vis === 'string' && SHAREABLE_VIS.includes(vis)) ||
      (vis === undefined && matchDefaultVisibility(rel, dv.rules) !== null);
    if (!shareable) continue;

    const title =
      typeof fmd['title'] === 'string'
        ? fmd['title']
        : (rel.split('/').pop() ?? rel).replace(/\.md$/i, '');
    // Digests / link-rolls are noise for "what do you know" — skip them.
    if (looksLikeLinkRoll(title, body)) continue;

    // Score relevance: label and the topic PHRASE weigh far more than an
    // incidental single word, so a note about the actual topic beats one that
    // merely mentions "agent" once.
    let score = 0;
    if (topic) {
      const titleL = title.toLowerCase();
      const bodyL = body.toLowerCase();
      if (noteTopicLabels(rel, fmd).has(topic.toLowerCase())) score += 100;
      if (phrase && titleL.includes(phrase)) score += 50;
      else if (phrase && bodyL.includes(phrase)) score += 30;
      let tokenHits = 0;
      for (const t of tokens) {
        if (titleL.includes(t)) tokenHits += 5;
        else if (bodyL.includes(t)) tokenHits += 3;
      }
      score += Math.min(tokenHits, 15);
    }
    let mtime = 0;
    try {
      mtime = (await fp.mtimeMs?.(rel)) ?? 0;
    } catch {
      mtime = 0;
    }
    // Score against the raw body (wikilinks carry topic words), but ship the
    // condensed excerpt to keep the prompt small and cheap.
    all.push({ rel, title, body: condenseNote(body).slice(0, MAX_NOTE_CHARS), score, mtime });
  }

  // Notes that clear a modest relevance bar count as "matched". Digests are
  // already excluded above, so this only separates on-topic authored notes
  // from unrelated ones — it can't re-admit link-roll noise.
  const RELEVANCE_MIN = 3;
  const matched = all
    .filter((n) => n.score >= RELEVANCE_MIN)
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  const pick = (matched.length > 0 ? matched : [...all].sort((a, b) => b.mtime - a.mtime)).slice(
    0,
    MAX_SOURCE_NOTES,
  );
  return {
    notes: pick.map(({ rel, title, body }) => ({ rel, title, body })),
    topicMatched: matched.length > 0,
  };
}

export interface DraftRequest {
  question: string;
  topic: string | null;
  level: number | null;
  sources: DraftSource[];
}

/** The instruction preamble shared by both drafting paths. `where` says
 * whether the notes are pasted in ('below') or must be opened from the vault
 * ('vault' — the lean paste mode, where the owner's Claude has the files). */
function draftInstructions(level: number | null, where: 'below' | 'vault'): string {
  const levelLine =
    level !== null
      ? `They asked at disclosure level ${level} — give a substantive summary, not a one-liner, but do not paste notes verbatim.`
      : 'Give a substantive but concise summary.';
  const ground =
    where === 'below'
      ? 'Ground it ONLY in my notes below — do not invent facts, names, or numbers that are not in them.'
      : 'Ground it ONLY in my actual notes — open the ones listed below in my vault (and anything they link to) and read them first. Do not invent facts, names, or numbers that are not in them.';
  return (
    'You are helping me reply to a colleague who asked what I know about a topic. ' +
    'Write the reply in the first person, as me, in a natural collegial voice. ' +
    `${ground} ` +
    'If my notes do not actually answer the question, say so plainly instead of padding. ' +
    `${levelLine} ` +
    'Output only the message body — no preamble, no "Here is", no sign-off.'
  );
}

function notesBlock(sources: DraftSource[]): string {
  return sources.map((s, i) => `--- Note ${i + 1}: ${s.title} ---\n${s.body}`).join('\n\n');
}

/** A prompt the owner pastes into their OWN Claude — no API key, no plugin
 * egress. Two shapes:
 *   - lean (default): question + context + the relevant note PATHS, letting a
 *     vault-connected Claude (Claude Code, attached folder) do the retrieval.
 *     Tiny — no note bodies.
 *   - `includeBodies`: self-contained with condensed excerpts, for a Claude
 *     that can't see the vault (e.g. plain claude.ai). */
export function buildPastePrompt(req: DraftRequest, opts?: { includeBodies?: boolean }): string {
  const head =
    `${draftInstructions(req.level, opts?.includeBodies ? 'below' : 'vault')}\n\n` +
    `A colleague asked:\n"${req.question}"\n\n` +
    `Topic: ${req.topic ?? '(unspecified)'}\n\n`;
  if (opts?.includeBodies) {
    return head + `My notes that may be relevant (the only material to draw on):\n\n${notesBlock(req.sources)}`;
  }
  const list = req.sources.map((s) => `- ${s.rel} — ${s.title}`).join('\n');
  return (
    head +
    `These notes in my vault look most relevant — open them (and anything they link to), read them, then answer from them:\n\n${list}`
  );
}

export class AiError extends Error {}

/** Call the owner's Anthropic account to draft an answer from the provided
 * (already shareable, already topic-matched) note excerpts. Returns the draft
 * text — the caller puts it in the editable box for review. */
export async function draftAnswer(
  app: App,
  model: string,
  req: DraftRequest,
): Promise<string> {
  const key = loadApiKey(app);
  if (!key) throw new AiError('No Anthropic API key is set (add one in Vantell settings).');
  if (req.sources.length === 0) {
    throw new AiError('No shareable notes match this topic — nothing to draft from.');
  }

  const system = draftInstructions(req.level, 'below');
  const userContent =
    `A colleague asked:\n"${req.question}"\n\n` +
    `Topic: ${req.topic ?? '(unspecified)'}\n\n` +
    `Here are my own notes that may be relevant (the only material to draw on):\n\n${notesBlock(req.sources)}`;

  const res = await requestUrl({
    url: ANTHROPIC_URL,
    method: 'POST',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
    throw: false,
  });

  if (res.status === 401) {
    throw new AiError('Anthropic rejected the API key (HTTP 401) — check it in Vantell settings.');
  }
  if (res.status === 429) {
    throw new AiError('Anthropic rate-limited the request (HTTP 429) — try again in a moment.');
  }
  if (res.status !== 200) {
    const msg = ((res.json as { error?: { message?: string } })?.error?.message) ?? '';
    throw new AiError(`Drafting failed (HTTP ${res.status})${msg ? `: ${msg}` : ''}.`);
  }

  const body = res.json as {
    stop_reason?: string;
    content?: { type: string; text?: string }[];
  };
  if (body.stop_reason === 'refusal') {
    throw new AiError('The model declined to draft this one — write the answer yourself.');
  }
  const text = (body.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new AiError('The model returned no text — try again or write it yourself.');
  return text;
}
