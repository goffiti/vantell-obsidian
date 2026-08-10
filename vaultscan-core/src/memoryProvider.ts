/**
 * In-memory FileProvider — backs the vitest parity fixtures and the mock-mode
 * demo vault. Mirrors walk_md ordering: per-directory sorted, depth-first,
 * dot-directories (and dot-files) pruned.
 */
import type { FileProvider } from './types';

export interface MemoryVault extends FileProvider {
  /** Direct access for assertions. */
  files: Map<string, string>;
  setMtime(path: string, epochMs: number): void;
}

interface DirNode {
  dirs: Map<string, DirNode>;
  files: Set<string>; // full relpaths
}

function buildTree(paths: Iterable<string>): DirNode {
  const root: DirNode = { dirs: new Map(), files: new Set() };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let next = node.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: new Set() };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.add(p);
  }
  return root;
}

/** Depth-first walk with per-directory sorted entries (files and dirs
 * interleaved alphabetically, like Python's sorted(iterdir())). */
function walk(node: DirNode, out: string[]): void {
  type Entry = { name: string; kind: 'dir'; node: DirNode } | { name: string; kind: 'file'; path: string };
  const entries: Entry[] = [];
  for (const [name, child] of node.dirs) entries.push({ name, kind: 'dir', node: child });
  for (const p of node.files) entries.push({ name: p.split('/').pop()!, kind: 'file', path: p });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.kind === 'dir') walk(e.node, out);
    else out.push(e.path);
  }
}

export function makeMemoryProvider(
  initial: Record<string, string>,
  mtimes: Record<string, number> = {},
): MemoryVault {
  const files = new Map(Object.entries(initial));
  const mtimeMap = new Map(Object.entries(mtimes));
  return {
    files,
    setMtime(path, epochMs) {
      mtimeMap.set(path, epochMs);
    },
    async listMarkdown() {
      const md = [...files.keys()].filter((p) => p.toLowerCase().endsWith('.md'));
      const out: string[] = [];
      walk(buildTree(md), out);
      return out;
    },
    async read(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`no such file: ${path}`);
      return v;
    },
    async exists(path) {
      return files.has(path);
    },
    async write(path, content) {
      files.set(path, content);
    },
    async mtimeMs(path) {
      return mtimeMap.get(path) ?? Date.now();
    },
  };
}
