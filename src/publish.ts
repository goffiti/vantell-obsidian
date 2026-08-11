/**
 * Scan → review data → publish orchestration.
 *
 * The scan runs entirely on-device via @vantell/vaultscan-core. Only the
 * transmit-safe scan output can reach a payload builder; the plain-language
 * review summary is derived here so every screen speaks user language
 * ("other people's words"), not scanner language ("capture layer").
 */
import type { App } from 'obsidian';
import {
  buildManifest,
  buildVaultReport,
  loadVaultConfig,
  scan,
  signedManifest,
  type ManifestPayload,
  type ScanResult,
  type VaultConfig,
  type VaultReportPayload,
} from '@vantell/vaultscan-core';
import { signedPost } from './api';
import { makeObsidianProvider } from './provider';
import type { StoredIdentity } from './identity';

export interface VaultScanContext {
  cfg: VaultConfig;
  result: ScanResult;
}

export async function scanVault(app: App): Promise<VaultScanContext> {
  const fp = makeObsidianProvider(app);
  const { cfg } = await loadVaultConfig(fp);
  const result = await scan(fp, cfg, {
    yieldEvery: 150,
    yieldFn: () => new Promise((r) => window.setTimeout(r, 0)),
  });
  return { cfg, result };
}

/** Plain-language review summary — everything the user needs to say yes.
 * Display model, deliberately simpler than the wire model: everything the
 * owner did not choose is ONE number ("stays here, no names leave") —
 * whether it sat in a locked, excluded, or merely unchosen folder is an
 * implementation detail the review must not make the owner reconcile. The
 * safety net is only surfaced where it means something: inside chosen
 * folders, where it caught notes the owner might have expected to share. */
export interface ReviewSummary {
  topics: { label: string; notes: number }[];
  /** sampleTitles ride the vault report (up to 3 per folder) — the review
   * must show them, because they leave the vault (SEC-12). */
  namedFolders: { name: string; notes: number; sampleTitles: string[] }[];
  /** Everything not chosen — unpicked + locked + excluded, one number. */
  unchosenNotes: number;
  /** Capture/person/excluded notes INSIDE chosen folders — the safety net. */
  protectedInChosen: number;
  shareableNotes: number;
  totalNotes: number;
  warnings: string[];
}

export function summarize(result: ScanResult): ReviewSummary {
  const ts = result.transmitSafe;
  const named = ts.folders.filter((f) => !f.path.startsWith('('));
  const aggregated = ts.folders.filter((f) => f.path.startsWith('('));
  const namedSet = new Set(named.map((f) => f.path));
  const protectedInChosen = result.localOnly.coverage
    .filter((c) => namedSet.has(c.path))
    .reduce(
      (acc, c) =>
        acc +
        (c.buckets['capture'] ?? 0) +
        (c.buckets['person'] ?? 0) +
        (c.buckets['excluded'] ?? 0),
      0,
    );
  return {
    topics: ts.topics.map((t) => ({ label: t.label, notes: t.notes })),
    namedFolders: named.map((f) => ({
      name: f.path,
      notes: f.note_count,
      sampleTitles: [...f.sample_titles],
    })),
    unchosenNotes: aggregated.reduce((acc, f) => acc + f.note_count, 0),
    protectedInChosen,
    shareableNotes: ts.stats.shareable_notes,
    totalNotes: ts.stats.total_notes,
    warnings: result.localOnly.warnings,
  };
}

export interface PublishedRecord {
  at: string;
  stats: { total_notes: number; shareable_notes: number };
  topics: { label: string; notes: number }[];
}

/** Sign and send the two payloads. Returns what to remember for diffs. */
export async function publishScan(
  result: ScanResult,
  ident: StoredIdentity,
  fallbackBase: string,
  displayName: string,
): Promise<{ manifest: ManifestPayload; report: VaultReportPayload; record: PublishedRecord }> {
  if (!ident.did) throw new Error('This device is not linked yet.');
  const ts = result.transmitSafe;
  const unsigned = buildManifest(ts, {
    did: ident.did,
    pubkey: ident.pubkey,
    displayName,
  });
  const manifest = await signedManifest(unsigned, ident.private_key_b64);
  const report = buildVaultReport(ts);
  await signedPost(ident, fallbackBase, '/v1/manifest', manifest);
  await signedPost(ident, fallbackBase, '/v1/vault-report', report);
  return {
    manifest,
    report,
    record: {
      at: new Date().toISOString(),
      stats: {
        total_notes: ts.stats.total_notes,
        shareable_notes: ts.stats.shareable_notes,
      },
      topics: ts.topics.map((t) => ({ label: t.label, notes: t.notes })),
    },
  };
}

/** Human diff vs the last publish — feeds the status view. */
export function diffAgainst(
  record: PublishedRecord | undefined,
  result: ScanResult,
): string[] {
  const ts = result.transmitSafe;
  if (!record) return ['Not live yet — nothing has been published from this vault.'];
  const lines: string[] = [];
  const dShareable = ts.stats.shareable_notes - record.stats.shareable_notes;
  if (dShareable !== 0) {
    lines.push(
      `${Math.abs(dShareable)} ${dShareable > 0 ? 'more' : 'fewer'} shareable note${Math.abs(dShareable) === 1 ? '' : 's'} than last published`,
    );
  }
  const oldTopics = new Map(record.topics.map((t) => [t.label, t.notes]));
  const newTopics = new Map(ts.topics.map((t) => [t.label, t.notes]));
  for (const [label] of newTopics) {
    if (!oldTopics.has(label)) lines.push(`new topic: ${label}`);
  }
  for (const [label] of oldTopics) {
    if (!newTopics.has(label)) lines.push(`topic gone: ${label}`);
  }
  if (lines.length === 0) lines.push('No changes since the last publish.');
  return lines;
}
