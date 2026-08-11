#!/usr/bin/env node
/**
 * SEC-14 guard: the route list in src/api.ts's header comment must match the
 * /v1/* routes actually referenced anywhere in src/. Stale security
 * narration in the file auditors read first costs credibility — so it fails
 * the lint instead of drifting silently. Run via `npm run lint`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const ROUTE_RE = /\/v1\/[a-z-]+(?:\/[a-z-]+)*/g;

const apiHeader = readFileSync(path.join(srcDir, 'api.ts'), 'utf8').split('*/')[0];
const declared = new Set(
  [...apiHeader.matchAll(/^\s*\*\s+(?:GET|POST)\s+(\/v1\/\S+)/gm)].map((m) =>
    // '{id}' path parameters end the comparable prefix.
    m[1].split('/{')[0],
  ),
);

const found = new Set();
for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
  // The Anthropic endpoint in ai.ts is not a Vantell route; the header
  // covers it in prose instead.
  const text = readFileSync(path.join(srcDir, f), 'utf8').replaceAll(
    'api.anthropic.com/v1/messages',
    '',
  );
  for (const m of text.matchAll(ROUTE_RE)) {
    found.add(m[0]);
  }
}

const undeclared = [...found].filter(
  (r) => ![...declared].some((d) => r === d || r.startsWith(d + '/')),
);
const unused = [...declared].filter(
  (d) => ![...found].some((r) => r === d || r.startsWith(d + '/')),
);

if (undeclared.length || unused.length) {
  if (undeclared.length)
    console.error(`Routes used in src/ but missing from the api.ts header: ${undeclared.join(', ')}`);
  if (unused.length)
    console.error(`Routes declared in the api.ts header but not found in src/: ${unused.join(', ')}`);
  process.exit(1);
}
console.log(`check_routes: ${declared.size} declared routes match the source.`);
