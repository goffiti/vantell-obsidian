# Vendored type declarations

- `obsidian.d.ts` — the official Obsidian API typings (MIT, © Obsidian.md),
  copied verbatim from the `obsidian` npm package (1.13.1).
- `stubs.d.ts` — minimal ambient stubs for modules `obsidian.d.ts` imports.

These exist so TypeScript resolution works **without node_modules**: the
community directory's automated review lints the repo without installing
dependencies, and unresolved imports become the `error` type, flooding the
report with `no-unsafe-*` warnings on every line that touches the Obsidian
API. `tsconfig.json` maps the modules here via `paths`; the esbuild bundle
uses `tsconfig.esbuild.json` (no paths) so runtime resolution is untouched.
