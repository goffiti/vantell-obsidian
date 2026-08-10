/**
 * Manifest + vault-report builders — port of publish.py.
 *
 * These functions ONLY accept `TransmitSafeScan` (the aggregated, whitelisted
 * scan output). `LocalOnlyScan` — where real locked-folder names live — has
 * no path into any payload here, making a locked-name leak structurally
 * impossible rather than merely avoided.
 */
import { canonicalJson, signManifest } from './identity';
import type { ReportFolder, ScanStats, TopicRow, TransmitSafeScan } from './types';

const TIERS = ['t0'] as const;
const AVAILABILITY = { mode: 'manual', typical_latency_s: 14400 } as const;
const MAX_LEVEL_DEFAULT = 2;

export interface ManifestPayload {
  knock: '0.1';
  agent_id: string;
  pubkey: string;
  display_name: string;
  tiers: string[];
  availability: { mode: string; typical_latency_s: number };
  topics: { label: string; depth: number; notes: number; recency_days: number }[];
  max_level_default: number;
  generated_at: string;
  sig?: string;
}

export interface VaultReportPayload {
  stats: ScanStats;
  folders: ReportFolder[];
}

function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Build the unsigned Knock manifest per build-spec §2.1. */
export function buildManifest(
  scan: TransmitSafeScan,
  opts: { did: string; pubkey: string; displayName: string; generatedAt?: string },
): ManifestPayload {
  return {
    knock: '0.1',
    agent_id: opts.did,
    pubkey: opts.pubkey,
    display_name: opts.displayName,
    tiers: [...TIERS],
    availability: { ...AVAILABILITY },
    topics: scan.topics.map((t: TopicRow) => ({
      label: t.label,
      depth: t.depth,
      notes: t.notes,
      recency_days: t.recency_days,
    })),
    max_level_default: MAX_LEVEL_DEFAULT,
    generated_at: opts.generatedAt ?? rfc3339Now(),
  };
}

/** Ed25519-sign the manifest (canonical JSON, sorted keys, no `sig`). */
export async function signedManifest(
  unsigned: ManifestPayload,
  seedB64: string,
): Promise<ManifestPayload> {
  const manifest: ManifestPayload = { ...unsigned };
  delete manifest.sig;
  manifest.sig = await signManifest(manifest as unknown as Record<string, unknown>, seedB64);
  return manifest;
}

/** {stats, folders} — metadata only, locked rows pre-aggregated upstream. */
export function buildVaultReport(scan: TransmitSafeScan): VaultReportPayload {
  return {
    stats: { ...scan.stats },
    folders: scan.folders.map((f) => {
      const out: ReportFolder = {
        path: f.path,
        note_count: f.note_count,
        sample_titles: [...f.sample_titles],
      };
      if (f.locked !== undefined) out.locked = f.locked;
      if (f.locked_reason !== undefined) out.locked_reason = f.locked_reason;
      return out;
    }),
  };
}

/** The canonical bytes a manifest signature covers — exposed for tests. */
export function manifestSigningString(manifest: ManifestPayload): string {
  const unsigned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest)) if (k !== 'sig') unsigned[k] = v;
  return canonicalJson(unsigned);
}
