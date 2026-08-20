#!/usr/bin/env node
/**
 * Flow lint (doc/trust-architecture.md §3, rule 2): the vault-synced store
 * must never grow a mesh/conversation field again. Parses the actual
 * VantellData interface in src/data.ts and fails when it contains any
 * L-DEVICE-labeled field, or when code writes such a field through
 * plugin.data. The mirror of check_routes.mjs, pointed at data instead of
 * endpoints. Run via `npm run lint`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src');

// L-DEVICE fields (and any future aliases) — conversation content, cursors,
// per-device endpoints. Keep in sync with doc/trust-architecture.md §3 and
// the CONTRACTS "storage labels" table.
const L_DEVICE_FIELDS = [
  'apiBase',
  'inboxCursor',
  'handledEnvelopes',
  'pendingEnvelopes',
  'receivedAnswers',
  'sentKnocks',
  'sentAnswers',
  'private_key_b64',
  'ciphertext',
  'question',
  'summary',
];

const dataTs = readFileSync(path.join(srcDir, 'data.ts'), 'utf8');
const m = dataTs.match(/export interface VantellData \{([\s\S]*?)\n\}/);
if (!m) {
  console.error('check_flows: could not find the VantellData interface in src/data.ts');
  process.exit(1);
}
const vaultSyncedFields = [...m[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]);

const violations = [];
for (const f of vaultSyncedFields) {
  if (L_DEVICE_FIELDS.includes(f)) {
    violations.push(`VantellData.${f} — L-DEVICE data in the vault-synced store`);
  }
}

// Writes through the synced store to an L-DEVICE field anywhere in src/.
const writeRe = new RegExp(`\\bdata\\.(${L_DEVICE_FIELDS.join('|')})\\b`);
for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
  const text = readFileSync(path.join(srcDir, f), 'utf8');
  const hit = text.match(writeRe);
  if (hit) violations.push(`src/${f}: '${hit[0]}' — L-DEVICE field accessed via the synced store`);
}

if (violations.length) {
  for (const v of violations) console.error(`check_flows: ${v}`);
  console.error(
    'check_flows: L-DEVICE data belongs in DeviceState (device-local), never in data.json — see doc/trust-architecture.md §3.',
  );
  process.exit(1);
}
console.log(
  `check_flows: data.json carries ${vaultSyncedFields.length} fields, none L-DEVICE-labeled.`,
);
