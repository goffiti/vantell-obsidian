/**
 * .vantell.yml defaults / load / save — port of the vault-config section of
 * vantell_lib.py, through a FileProvider.
 */
import yaml from 'js-yaml';
import { displayValue } from './display';
import { pathMatches } from './glob';
import { SHAREABLE_VIS } from './types';
import type {
  DefaultVisibilityRule,
  FileProvider,
  ShareVisibility,
  VaultConfig,
} from './types';

export const CONFIG_FILENAME = '.vantell.yml';

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  capture_paths: [
    'Captures/**', 'Clippings/**', 'Inbox/**',
    'Email*/**', '**/Email*/**', 'Mail*/**', '**/Mail*/**',
    '*Mail Archive*/**',
    'Chat*/**', '**/Chat*/**',
    'Transcript*/**', '**/Transcript*/**',
    'Meeting*/**', 'Granola/**', 'Evernote/**', 'Calendar/**',
  ],
  person_paths: [
    'People/**', 'Peeps/**', '**/peeps/**', 'Contacts/**', 'CRM/**',
  ],
  exclude_paths: [
    'Personal/**', 'Journal/**', 'Private/**',
    // Hidden folders are never notes: covers .git, .claude, and the Obsidian
    // config folder WHATEVER the user renamed it to (it's conventionally
    // dot-prefixed; Obsidian's own file index never lists it anyway — this
    // matters for filesystem walkers like the vantell-connect skill).
    '**/.*/**',
  ],
  exclude_if_matches: [
    '(?i)\\b(salary|severance|nda|confidential)\\b',
  ],
  confirmed_authored: [],
  default_visibility: {},
};

export const VAULT_CONFIG_HEADER = `\
# .vantell.yml — vantell-connect vault configuration
#
# capture_paths / person_paths are CATEGORICAL exclusions (build-spec §1.0):
# no frontmatter can make notes under them shareable. exclude_paths is your
# own extra safety margin. exclude_if_matches are regexes checked against
# note bodies; a hit excludes the note and warns you.
#
# All path globs are matched case-insensitively.
#
# The scan additionally runs suspicion heuristics: any folder whose name or
# sampled contents look like mail/chat/transcript captures or person
# dossiers — and any large top-level folder — BLOCKS the scan until you
# classify it above, or list the exact folder path under confirmed_authored:
# to acknowledge it as genuinely authored notes. confirmed_authored silences
# the gate for that folder only; per-file heuristics still demote
# person/capture-looking notes inside it.
#
# Files at the vault root (no folder) are gated as the pseudo-folder
# "(root)": list "(root)" under confirmed_authored: to acknowledge them.
#
# default_visibility declares scoped sharing defaults (build-spec §1.1):
#   default_visibility:
#     "wiki/**": {visibility: org, max_level: 3}
# Authored notes under a matching glob with NO per-note 'visibility:'
# frontmatter become shareable at that visibility (max_level optional, 0-4,
# default 2). First matching pattern wins. Per-note frontmatter always
# overrides the default, in both directions ('visibility: private' opts a
# note back out). The categorical exclusions and exclude rules above run
# FIRST — a default can never rescue a capture, person, or excluded note.
# Vault-root patterns ('**', '*', or anything made only of wildcards) are
# rejected: a default must name a deliberate subtree, and adding one is an
# owner decision made after reviewing the notes it covers.
#
# report_scope controls which top-level folder NAMES appear in the vault
# report sent to your own portal dashboard:
#   report_scope: all        # every top-level folder is named (default)
#   report_scope: selected   # only folders you share from are named; all
#                            # others aggregate into one "(private folders)"
#                            # row (counts only, no names)
# Any unknown value is treated as 'selected' (fail closed) with a warning.
#
# Review this file before publishing. Nothing under any of these paths ever
# leaves your machine.
`;

/** Deep-ish copy of a config — every list and the default_visibility map
 * are fresh objects, so callers can mutate the copy safely. */
export function cloneConfig(cfg: VaultConfig): VaultConfig {
  const dv: Record<string, DefaultVisibilityRule> = {};
  for (const [k, v] of Object.entries(cfg.default_visibility ?? {})) dv[k] = { ...v };
  const out: VaultConfig = {
    capture_paths: [...cfg.capture_paths],
    person_paths: [...cfg.person_paths],
    exclude_paths: [...cfg.exclude_paths],
    exclude_if_matches: [...cfg.exclude_if_matches],
    confirmed_authored: [...cfg.confirmed_authored],
    default_visibility: dv,
  };
  if (cfg.report_scope !== undefined) out.report_scope = cfg.report_scope;
  return out;
}

function cloneDefaults(): VaultConfig {
  return cloneConfig(DEFAULT_VAULT_CONFIG);
}

function dumpConfig(cfg: VaultConfig): string {
  return VAULT_CONFIG_HEADER + yaml.dump(cfg, { sortKeys: false, lineWidth: -1 });
}

/** Return {cfg, created}. Creates .vantell.yml with defaults if absent —
 * like vantell_lib.load_vault_config (merge keeps only non-null values). */
export async function loadVaultConfig(
  fp: FileProvider,
): Promise<{ cfg: VaultConfig; created: boolean }> {
  if (await fp.exists(CONFIG_FILENAME)) {
    let parsed: unknown = {};
    try {
      parsed = yaml.load(await fp.read(CONFIG_FILENAME)) ?? {};
    } catch {
      parsed = {};
    }
    const merged = cloneDefaults();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      for (const k of Object.keys(merged) as (keyof VaultConfig)[]) {
        if (k === 'default_visibility') continue; // map, handled below
        const v = rec[k];
        if (v !== null && v !== undefined && Array.isArray(v)) {
          (merged[k] as string[]) = v.map((x) => String(x));
        }
      }
      const scopeRaw = rec['report_scope'];
      if (scopeRaw !== null && scopeRaw !== undefined) {
        merged.report_scope = displayValue(scopeRaw);
      }
      const dvRaw = rec['default_visibility'];
      if (dvRaw !== null && dvRaw !== undefined && typeof dvRaw === 'object' && !Array.isArray(dvRaw)) {
        const dv: Record<string, DefaultVisibilityRule> = {};
        for (const [pat, val] of Object.entries(dvRaw as Record<string, unknown>)) {
          if (typeof val === 'string') {
            dv[pat] = { visibility: val }; // shorthand: "wiki/**": org
          } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            const vv = val as Record<string, unknown>;
            const rule: DefaultVisibilityRule = { visibility: displayValue(vv['visibility'] ?? '') };
            if (typeof vv['max_level'] === 'number') rule.max_level = vv['max_level'];
            dv[pat] = rule;
          } else {
            // Keep a knowably-invalid rule so resolveDefaultVisibility can
            // reject it WITH a warning instead of dropping it silently.
            dv[pat] = { visibility: String(val) };
          }
        }
        merged.default_visibility = dv;
      }
    }
    return { cfg: merged, created: false };
  }
  const cfg = cloneDefaults();
  await fp.write(CONFIG_FILENAME, dumpConfig(cfg));
  return { cfg, created: true };
}

/** Persist an updated config (gate decisions) back into the vault. */
export async function saveVaultConfig(fp: FileProvider, cfg: VaultConfig): Promise<void> {
  await fp.write(CONFIG_FILENAME, dumpConfig(cfg));
}

/** Resolve cfg.report_scope to an effective scope. Absent or 'all' → 'all'
 * (today's behavior, every top-level folder named in the report). 'selected'
 * → only shared-from folders keep their names. Any OTHER value fails CLOSED
 * to 'selected' — a typo'd scope must narrow disclosure, never widen it —
 * and `warning` says so for the scan to surface. */
export function resolveReportScope(cfg: VaultConfig): {
  scope: 'all' | 'selected';
  warning: string | null;
} {
  const raw = cfg.report_scope;
  if (raw === undefined || raw === 'all') return { scope: 'all', warning: null };
  if (raw === 'selected') return { scope: 'selected', warning: null };
  return {
    scope: 'selected',
    warning:
      `report_scope '${raw}' is not a known value (all|selected) — ` +
      `treating it as 'selected' (fail closed): only shared-from folders are named in the report`,
  };
}

/** Review-step reclassification actions for a named folder. */
export type FolderAction = 'capture' | 'person' | 'exclude';

/** Return a copy of cfg with `<folder>/**` appended to the list the action
 * maps to — the same mapping the Classify (gate) step uses. */
export function withFolderAction(
  cfg: VaultConfig,
  folder: string,
  action: FolderAction,
): VaultConfig {
  const next = cloneConfig(cfg);
  const glob = `${folder}/**`;
  if (action === 'capture') next.capture_paths.push(glob);
  else if (action === 'person') next.person_paths.push(glob);
  else next.exclude_paths.push(glob);
  return next;
}

/* ------------------------------------------- scoped visibility defaults */

/** A validated default_visibility rule, ready for matching. */
export interface ResolvedDefaultRule {
  pattern: string;
  visibility: ShareVisibility;
  max_level: number;
}

export interface ResolvedDefaults {
  /** In config order — first matching pattern wins. */
  rules: ResolvedDefaultRule[];
  rejected: { pattern: string; reason: string }[];
}

export const DEFAULT_RULE_MAX_LEVEL = 2;

/** §1.1: a scope must name a deliberate subtree. A pattern made only of
 * wildcard characters (*, ?, /) matches everything at the vault root and is
 * rejected outright. Returns the rejection reason, or null when valid. */
export function defaultPatternInvalidReason(pattern: string): string | null {
  if (![...pattern].some((c) => c !== '*' && c !== '?' && c !== '/')) {
    return (
      'matches everything — a vault-root default is rejected; ' +
      'scope must name a deliberate subtree (build-spec §1.1)'
    );
  }
  return null;
}

/** Validate cfg.default_visibility into matchable rules. Invalid entries
 * come back in `rejected` so the scan can warn instead of silently sharing
 * (or silently not sharing). */
export function resolveDefaultVisibility(cfg: VaultConfig): ResolvedDefaults {
  const rules: ResolvedDefaultRule[] = [];
  const rejected: { pattern: string; reason: string }[] = [];
  for (const [pattern, rule] of Object.entries(cfg.default_visibility ?? {})) {
    const bad = defaultPatternInvalidReason(pattern);
    if (bad) {
      rejected.push({ pattern, reason: bad });
      continue;
    }
    if (!SHAREABLE_VIS.includes(rule.visibility)) {
      rejected.push({ pattern, reason: 'visibility must be team|org|federation' });
      continue;
    }
    let maxLevel = DEFAULT_RULE_MAX_LEVEL;
    if (rule.max_level !== undefined) {
      if (!Number.isInteger(rule.max_level) || rule.max_level < 0 || rule.max_level > 4) {
        rejected.push({ pattern, reason: 'max_level must be an integer 0-4' });
        continue;
      }
      maxLevel = rule.max_level;
    }
    rules.push({
      pattern,
      visibility: rule.visibility as ShareVisibility,
      max_level: maxLevel,
    });
  }
  return { rules, rejected };
}

/** First matching rule for a relpath (config order), or null. Same glob
 * matcher as every other path rule — case-insensitive, '**' collapses. */
export function matchDefaultVisibility(
  rel: string,
  rules: readonly ResolvedDefaultRule[],
): ResolvedDefaultRule | null {
  for (const r of rules) {
    if (pathMatches(rel, [r.pattern])) return r;
  }
  return null;
}

/** Add (or replace) the `<folder>/**` scoped default — the rule shape the
 * Review-step "Share by default" select writes. Merges with existing rules. */
export function withDefaultVisibility(
  cfg: VaultConfig,
  folder: string,
  visibility: ShareVisibility,
): VaultConfig {
  const next = cloneConfig(cfg);
  next.default_visibility = {
    ...(next.default_visibility ?? {}),
    [`${folder}/**`]: { visibility },
  };
  return next;
}

/** Remove the `<folder>/**` scoped default ("Stop sharing by default"). */
export function withoutDefaultVisibility(cfg: VaultConfig, folder: string): VaultConfig {
  const next = cloneConfig(cfg);
  const dv = { ...(next.default_visibility ?? {}) };
  delete dv[`${folder}/**`];
  next.default_visibility = dv;
  return next;
}

export interface CompiledRegexes {
  regexes: { re: RegExp; pattern: string }[];
  /** Patterns that failed to compile — the scan warns, never crashes. */
  bad: number;
}

/** Compile exclude_if_matches patterns. Python inline flags like '(?i)' at
 * the start are translated to JS RegExp flags. Broken regexes are skipped
 * and counted. */
export function compileRegexes(patterns: readonly string[]): CompiledRegexes {
  const out: { re: RegExp; pattern: string }[] = [];
  let bad = 0;
  for (const p of patterns) {
    let source = p;
    let flags = '';
    const m = /^\(\?([a-zA-Z]+)\)/.exec(source);
    if (m) {
      const inline = m[1]!;
      if (/^[imsu]+$/.test(inline)) {
        flags = [...new Set(inline)].join('');
        source = source.slice(m[0].length);
      }
    }
    try {
      out.push({ re: new RegExp(source, flags), pattern: p });
    } catch {
      bad += 1;
    }
  }
  return { regexes: out, bad };
}

export function confirmedAuthoredSet(cfg: VaultConfig): Set<string> {
  const s = new Set<string>();
  for (const f of cfg.confirmed_authored ?? []) {
    const v = String(f).trim().replace(/^\/+|\/+$/g, '').toLowerCase();
    if (v) s.add(v);
  }
  return s;
}
