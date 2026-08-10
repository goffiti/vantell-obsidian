import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import process from 'node:process';

const banner = `/*
Vantell for Obsidian — source: https://github.com/goffiti/vantell-obsidian
Share what you know, never your notes.
*/`;

const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  // NOT the root tsconfig: its "paths" map runtime deps to vendored .d.ts
  // files (type-only, for the directory's no-install review lint) and would
  // make esbuild bundle empty modules.
  tsconfig: 'tsconfig.esbuild.json',
  bundle: true,
  // 'obsidian'/'electron'/codemirror come from the host app. Node builtins
  // are listed only so an accidental import FAILS AT RUNTIME on desktop the
  // same way it would on mobile — nothing in this plugin may use them.
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtinModules,
    'node:*',
  ],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
