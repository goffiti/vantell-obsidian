/**
 * Minimal, strictly-typed declarations for the subset of js-yaml this
 * package uses (load + dump). Vendored so type resolution works without
 * node_modules — the Obsidian directory's automated review lints without
 * installing dependencies. The full @types/js-yaml can't be vendored
 * verbatim: its `any`s trip that same review.
 */
export interface DumpOptions {
  /** Sort object keys when dumping. */
  sortKeys?: boolean;
  /** Max line width; -1 disables wrapping. */
  lineWidth?: number;
}

export function load(str: string): unknown;
export function dump(obj: unknown, opts?: DumpOptions): string;

declare const yaml: {
  load: typeof load;
  dump: typeof dump;
};
export default yaml;
