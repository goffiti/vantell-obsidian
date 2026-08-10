/**
 * vaultscan — TypeScript port of skill/vantell-connect/scripts (scan.py /
 * vantell_lib.py / mark.py), with behavioral parity. Pure module: no React,
 * no network, no DOM assumptions beyond what callers inject.
 *
 * Privacy invariant, made structural: `ScanResult` splits into
 * `transmitSafe` (the ONLY thing publishPayloads.ts will accept) and
 * `localOnly` (real locked-folder names, coverage, warnings — never leaves
 * page state).
 */

/** Abstract vault access — the browser flow backs this with the File System
 * Access API; tests and the demo back it with an in-memory map. */
export interface FileProvider {
  /** Posix relpaths of every *.md file, dot-directories pruned, in the same
   * order Python's walk_md yields (per-directory sorted, depth-first). */
  listMarkdown(): Promise<string[]>;
  /** Read a file's full text. Throws if unreadable. */
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Overwrite (or create) a file. */
  write(path: string, content: string): Promise<void>;
  /** Last-modified epoch ms — feeds topic recency. Optional. */
  mtimeMs?(path: string): Promise<number>;
  /** Drop any cached file listing (providers may memoize listMarkdown —
   * enumerating 187k files through the FS Access API is the slow part).
   * Call when the vault may have changed on disk. Optional. */
  invalidateListing?(): void;
}

/** One scoped visibility default (build-spec §1.1). `visibility` is kept as a
 * plain string at this layer so invalid values survive load and can be
 * rejected WITH a warning at resolve time instead of vanishing silently. */
export interface DefaultVisibilityRule {
  visibility: string; // valid values: team | org | federation
  max_level?: number; // 0-4; default 2 when absent
}

export interface VaultConfig {
  capture_paths: string[];
  person_paths: string[];
  exclude_paths: string[];
  exclude_if_matches: string[];
  confirmed_authored: string[];
  /** Scoped visibility defaults (§1.1): glob pattern -> rule. Insertion
   * order is match order (first match wins). Optional — older configs and
   * test fixtures may omit it. */
  default_visibility?: Record<string, DefaultVisibilityRule>;
  /** Vault-report folder scope. 'all' (absent = 'all'): every top-level
   * folder is named in the report (locked ones pre-aggregated). 'selected':
   * only folders the owner shares from keep their names; the rest aggregate
   * into one "(private folders)" row. Any other value fails CLOSED to
   * 'selected' with a warning — a typo must never widen disclosure. Kept as
   * a plain string at this layer so invalid values survive load and warn at
   * scan time instead of vanishing silently. */
  report_scope?: string;
}

export type ShareVisibility = 'team' | 'org' | 'federation';
export const SHAREABLE_VIS: readonly string[] = ['team', 'org', 'federation'];

/* ---------- gate ---------- */

export interface GateSuspect {
  folder: string;
  md_files: number;
  unclassified: number;
  why: string;
  /** Local-only aid for the gate UI — stems of sampled files. Never transmitted. */
  sampleTitles: string[];
}

/* ---------- scan output ---------- */

export interface ReportFolder {
  path: string;
  note_count: number;
  sample_titles: string[];
  locked?: boolean;
  locked_reason?: string;
}

export interface TopicRow {
  label: string;
  notes: number;
  recency_days: number;
  depth: number;
}

export interface ScanStats {
  total_notes: number;
  shareable_notes: number;
  capture_files: number;
  people_notes: number;
}

export interface ScanExcluded {
  capture_layer: number;
  capture_content_heuristic: number;
  person_subject: number;
  person_content_heuristic: number;
  excluded_paths: number;
  regex_matches: number;
  private_default_or_marked: number;
  malformed_frontmatter: number;
}

/** The transmit-safe subset — mirrors scan.py's SCAN_JSON_KEYS (minus the
 * local vault path). Locked/excluded folders appear ONLY as the aggregated
 * "(capture folders)" / "(person folders)" / "(excluded folders)" rows. */
export interface TransmitSafeScan {
  generated_at: string;
  stats: ScanStats;
  /** Of stats.shareable_notes, how many are shareable via a
   * default_visibility folder rule rather than explicit frontmatter.
   * Deliberately OUTSIDE stats: the /v1/vault-report contract validates
   * stats deny-by-default to exactly four keys, and this count never rides
   * the wire (buildVaultReport sends stats + folders only). */
  shareable_via_default: number;
  excluded: ScanExcluded;
  folders: ReportFolder[];
  topics: TopicRow[];
}

export interface CoverageRow {
  path: string;
  buckets: Record<string, number>;
}

export interface LockedFolderLocal {
  path: string;
  note_count: number;
  /** 'private' = aggregated by report_scope: selected (not by a lock rule). */
  kind: 'capture' | 'person' | 'excluded' | 'private';
}

/** Never serialized into any network payload — real locked names live here. */
export interface LocalOnlyScan {
  coverage: CoverageRow[];
  lockedLocal: LockedFolderLocal[];
  /** Per top-level folder: authored notes with NO explicit visibility key
   * that are not already shareable via a default — i.e. exactly the notes a
   * NEW folder default would make shareable. Feeds the §1.1
   * review-the-covered-list confirm in the browser flow. */
  defaultableByFolder: Record<string, number>;
  warnings: string[];
  /** The scan.py CAUTION line (0 capture/person in a >1000-note vault), or null. */
  caution: string | null;
}

export interface ScanResult {
  transmitSafe: TransmitSafeScan;
  localOnly: LocalOnlyScan;
}
