/**
 * "Already protected automatically" summary — which top-level folders the
 * current .vantell.yml already covers (capture / person / exclude), so the
 * gate UI can show what needs no decision from the owner.
 *
 * Pure and local-only: the folder names computed here are for on-page
 * display and never enter any network payload.
 */
import { pathMatches } from './glob';
import type { VaultConfig } from './types';

export type AutoProtectedBucket = 'capture' | 'person' | 'excluded';

export interface AutoProtectedRow {
  /** Top-level folder, or '(root)' for files at the vault root. */
  folder: string;
  bucket: AutoProtectedBucket;
  count: number;
}

/**
 * Count, per top-level folder, the files already covered by the config's
 * path globs. Precedence per file mirrors the scan pipeline: capture beats
 * person beats exclude. Folders with zero covered files are omitted; rows
 * are sorted by count descending (folder name as tiebreaker).
 */
export function autoProtectedSummary(paths: string[], cfg: VaultConfig): AutoProtectedRow[] {
  const perFolder = new Map<string, Record<AutoProtectedBucket, number>>();
  for (const rel of paths) {
    let bucket: AutoProtectedBucket;
    if (pathMatches(rel, cfg.capture_paths ?? [])) bucket = 'capture';
    else if (pathMatches(rel, cfg.person_paths ?? [])) bucket = 'person';
    else if (pathMatches(rel, cfg.exclude_paths ?? [])) bucket = 'excluded';
    else continue;
    const top = rel.includes('/') ? rel.split('/')[0]! : '(root)';
    let counts = perFolder.get(top);
    if (!counts) {
      counts = { capture: 0, person: 0, excluded: 0 };
      perFolder.set(top, counts);
    }
    counts[bucket] += 1;
  }
  const rows: AutoProtectedRow[] = [];
  for (const [folder, counts] of perFolder) {
    for (const bucket of ['capture', 'person', 'excluded'] as const) {
      if (counts[bucket] > 0) rows.push({ folder, bucket, count: counts[bucket] });
    }
  }
  return rows.sort(
    (a, b) =>
      b.count - a.count || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0),
  );
}
