/**
 * FileProvider backed by the Obsidian Vault API — cross-platform (desktop
 * and mobile), no Node/Electron APIs.
 *
 * Indexed markdown files go through the vault index (`getMarkdownFiles`,
 * `cachedRead`); `.vantell.yml` is a dotfile Obsidian does not index, so
 * config reads/writes go through the DataAdapter, which handles any path.
 */
import { TFile, type App } from 'obsidian';
import type { FileProvider } from '@vantell/vaultscan-core';

export function makeObsidianProvider(app: App): FileProvider {
  const { vault } = app;

  const tfile = (path: string): TFile | null => {
    const f = vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  };

  return {
    async listMarkdown(): Promise<string[]> {
      // Obsidian's index already prunes dot-directories. Lexicographic sort
      // approximates the Python walker's per-directory sorted depth-first
      // order; scan semantics do not depend on order beyond sample picking.
      return vault
        .getMarkdownFiles()
        .map((f) => f.path)
        .sort();
    },

    async read(path: string): Promise<string> {
      const f = tfile(path);
      if (f) return vault.cachedRead(f);
      return vault.adapter.read(path);
    },

    async exists(path: string): Promise<boolean> {
      if (tfile(path)) return true;
      return vault.adapter.exists(path);
    },

    async write(path: string, content: string): Promise<void> {
      const f = tfile(path);
      if (f) {
        await vault.modify(f, content);
        return;
      }
      // Dotfiles (.vantell.yml) and new files: the adapter creates on write.
      await vault.adapter.write(path, content);
    },

    async mtimeMs(path: string): Promise<number> {
      const f = tfile(path);
      if (f) return f.stat.mtime;
      const st = await vault.adapter.stat(path);
      return st?.mtime ?? Date.now();
    },

    invalidateListing(): void {
      // No listing cache — getMarkdownFiles reads the live index.
    },
  };
}

/** Top-level folders with markdown-note counts — feeds the folder picker.
 * Root-level notes count under the pseudo-folder "(root)". Names never
 * leave the device; the picker is local UI. */
export function topLevelFolders(app: App): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of app.vault.getMarkdownFiles()) {
    const top = f.path.includes('/') ? f.path.split('/')[0]! : '(root)';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
