#!/usr/bin/env node
/**
 * Lint the plugin THE WAY THE COMMUNITY DIRECTORY'S REVIEW DOES: against a
 * copy of the public-repo layout with NO node_modules, so every import must
 * resolve through the vendored declarations (types/, vaultscan-core/types/)
 * via tsconfig "paths". Anything `error`-typed here will flood the real
 * review with no-unsafe-* warnings.
 *
 * Run from obsidian-plugin/ (needs its devDependencies):
 *   npm run lint:review
 * Lives in obsidian-plugin/scripts/ so its imports resolve from the
 * plugin's node_modules.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

const monorepo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
// Outside the repo on purpose: no node_modules anywhere up the tree.
const sim = path.join(homedir(), '.cache', 'vantell-review-sim');

rmSync(sim, { recursive: true, force: true });
mkdirSync(sim, { recursive: true });
execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', 'main.js',
  '--exclude', 'package-lock.json', `${monorepo}/obsidian-plugin/`, `${sim}/`]);
execFileSync('rsync', ['-a', '--exclude', 'node_modules',
  `${monorepo}/packages/vaultscan-core/`, `${sim}/vaultscan-core/`]);
rmSync(path.join(sim, 'eslint.config.mjs'), { force: true });

// Public layout: vaultscan-core sits at the repo root, not ../packages/.
const tsconfigPath = path.join(sim, 'tsconfig.json');
const raw = readFileSync(tsconfigPath, 'utf8').replace(/^\s*\/\/.*$/gm, '');
const tsconfig = JSON.parse(raw);
for (const [k, v] of Object.entries(tsconfig.compilerOptions.paths ?? {})) {
  tsconfig.compilerOptions.paths[k] = v.map((p) =>
    p.replace('../packages/vaultscan-core', 'vaultscan-core'),
  );
}
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');

const eslint = new ESLint({
  cwd: sim,
  overrideConfigFile: true,
  overrideConfig: tseslint.config(
    ...tseslint.configs.recommendedTypeChecked,
    ...obsidianmd.configs.recommended,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir: sim },
      },
    },
  ),
});

// The real review lints only shipped sources — it has never flagged a test
// file (vitest is unresolvable there and would drown the signal).
const results = (
  await eslint.lintFiles(['src/**/*.ts', 'vaultscan-core/src/**/*.ts'])
).filter((r) => !/\.test\.ts$|__tests__/.test(r.filePath));
const formatter = await eslint.loadFormatter('stylish');
console.log(await formatter.format(results));
const errors = results.reduce((n, r) => n + r.errorCount, 0);
const warnings = results.reduce((n, r) => n + r.warningCount, 0);
const unsafe = results
  .flatMap((r) => r.messages)
  .filter((m) => m.ruleId?.includes('no-unsafe')).length;
console.log(`review-sim: ${errors} errors, ${warnings} warnings (${unsafe} no-unsafe-*)`);
process.exit(errors > 0 ? 1 : 0);
