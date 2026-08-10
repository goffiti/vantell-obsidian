/**
 * Per-note sharing commands. The ONLY way this plugin ever modifies a note:
 * the user invokes it on that specific note, and the edit is one visible
 * frontmatter property (visibility) — the body survives byte-exactly
 * (enforced by core's round-trip check).
 */
import { Notice, TFile, type App } from 'obsidian';
import {
  classifyNote,
  compileRegexes,
  loadVaultConfig,
  markNote,
  markNotePrivate,
  parseFrontmatter,
  type ShareVisibility,
} from '@vantell/vaultscan-core';
import { makeObsidianProvider } from './provider';

const REFUSALS: Record<string, string> = {
  capture:
    "This note looks like other people's words (an email, chat, or transcript) — it stays private. That protection can't be switched off.",
  person:
    'This note looks like notes about a person — it stays private. That protection can\'t be switched off.',
  excluded: 'This note is in a folder on your private list — it stays private.',
  regex:
    'This note matches one of your privacy patterns (like “salary” or “confidential”) — it stays private. You can adjust the patterns in .vantell.yml.',
  malformed:
    'This note\'s properties block has a syntax problem — fix the YAML at the top first.',
};

export async function shareNote(
  app: App,
  file: TFile,
  visibility: ShareVisibility,
): Promise<void> {
  const fp = makeObsidianProvider(app);
  const { cfg } = await loadVaultConfig(fp);
  const text = await app.vault.read(file);
  const out = markNote(file.path, text, cfg, { visibility });
  if (!out.ok) {
    new Notice(REFUSALS[out.refused.bucket] ?? 'This note can\'t be shared.');
    return;
  }
  await app.vault.modify(file, out.content);
  new Notice(
    `Shared with your ${visibility === 'team' ? 'team' : 'org'} — a “visibility” property was added to this note.`,
  );
}

export async function stopSharingNote(app: App, file: TFile): Promise<void> {
  const text = await app.vault.read(file);
  const out = markNotePrivate(text);
  if (!out.ok) {
    new Notice(REFUSALS['malformed']!);
    return;
  }
  if (!out.changed) {
    new Notice('This note is already private.');
    return;
  }
  await app.vault.modify(file, out.content);
  new Notice('This note is now private — it also opts out of any folder sharing.');
}

/** Current effective state, for dynamic command naming / status display. */
export async function noteShareState(
  app: App,
  file: TFile,
): Promise<'shared' | 'private' | 'protected'> {
  const fp = makeObsidianProvider(app);
  const { cfg } = await loadVaultConfig(fp);
  const text = await app.vault.cachedRead(file);
  const { fm, body } = parseFrontmatter(text);
  const cls = classifyNote(file.path, fm, body, cfg, compileRegexes(cfg.exclude_if_matches ?? []));
  if (cls.bucket !== 'authored') return 'protected';
  const vis = (fm as Record<string, unknown>)['visibility'];
  return typeof vis === 'string' && vis !== 'private' ? 'shared' : 'private';
}
