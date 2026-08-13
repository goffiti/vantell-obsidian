/**
 * Manifest / vault-report / signing parity tests. Verifies signatures with
 * @noble/ed25519 directly (the API server verifies with PyNaCl over the same
 * canonical bytes).
 */
import { describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import {
  b64ToBytes,
  bytesToB64,
  canonicalJson,
  didHeaders,
  generateIdentity,
  sha256Hex,
} from '../identity';
import {
  buildManifest,
  buildVaultReport,
  manifestSigningString,
  signedManifest,
} from '../publishPayloads';
import { scan } from '../classify';
import { DEFAULT_VAULT_CONFIG } from '../config';
import { makeMemoryProvider } from '../memoryProvider';
import type { TransmitSafeScan } from '../types';

const DID = 'did:knock:acme:tim';

async function sampleScan(): Promise<TransmitSafeScan> {
  const fp = makeMemoryProvider({
    'Emails/locked-mail.md': 'From: a\nTo: b\nSubject: s\nDate: d\n\nbody\n',
    'People/jane-doe.md': 'person note under a person path\n',
    'Journal/diary-entry.md': 'excluded-path note, folder fully excluded\n',
    'Notes/pub.md': '---\nvisibility: org\ntopics: [ai]\ntitle: Pub\n---\ncontent\n',
    'Notes/priv.md': 'private\n',
  });
  return (await scan(fp, DEFAULT_VAULT_CONFIG)).transmitSafe;
}

describe('canonicalJson', () => {
  it('matches Python json.dumps(sort_keys, compact, ensure_ascii=False)', () => {
    expect(canonicalJson({ b: 1, a: [1, 2], c: 'é', d: { y: null, x: true } })).toBe(
      '{"a":[1,2],"b":1,"c":"é","d":{"x":true,"y":null}}',
    );
  });
});

describe('manifest (build-spec §2.1)', () => {
  it('has the exact shape and constants', async () => {
    const m = buildManifest(await sampleScan(), {
      did: DID,
      pubkey: 'PUB',
      displayName: 'Tim',
      generatedAt: '2026-01-01T00:00:00Z',
    });
    expect(Object.keys(m).sort()).toEqual([
      'agent_id', 'availability', 'display_name', 'generated_at', 'knock',
      'max_level_default', 'pubkey', 'tiers', 'topics',
    ]);
    expect(m.knock).toBe('0.1');
    expect(m.tiers).toEqual(['t0']);
    expect(m.availability).toEqual({ mode: 'manual', typical_latency_s: 14400 });
    expect(m.max_level_default).toBe(2);
    expect(m.topics).toEqual([
      { label: 'ai', depth: 0.4, notes: 1, recency_days: 0 },
      { label: 'notes', depth: 0.4, notes: 1, recency_days: 0 },
    ]);
  });

  it('sig verifies over canonical JSON without the sig field', async () => {
    const ident = await generateIdentity();
    const unsigned = buildManifest(await sampleScan(), {
      did: DID,
      pubkey: ident.pubkey,
      displayName: 'Tim',
      generatedAt: '2026-01-01T00:00:00Z',
    });
    const m = await signedManifest(unsigned, ident.private_key_b64);
    expect(typeof m.sig).toBe('string');
    const ok = await ed.verifyAsync(
      b64ToBytes(m.sig!),
      new TextEncoder().encode(manifestSigningString(m)),
      b64ToBytes(ident.pubkey),
    );
    expect(ok).toBe(true);
    // tamper → fails
    const tampered = { ...m, display_name: 'Mallory' };
    const bad = await ed.verifyAsync(
      b64ToBytes(m.sig!),
      new TextEncoder().encode(manifestSigningString(tampered)),
      b64ToBytes(ident.pubkey),
    );
    expect(bad).toBe(false);
  });
});

describe('DID request signing (CONTRACTS.md)', () => {
  it('signs METHOD\\nPATH\\nTIMESTAMP\\nSHA256_HEX(body)', async () => {
    const ident = await generateIdentity();
    const body = new TextEncoder().encode('{"stats":{}}');
    const h = await didHeaders('POST', '/v1/vault-report?x=1', body, ident.private_key_b64, DID);
    expect(h['X-Knock-Did']).toBe(DID);
    expect(h['X-Knock-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(h['X-Knock-Body-Sha256']).toBe(await sha256Hex(body));
    // Since 0.9.0 the signature covers the FULL path INCLUDING the query
    // (SEC-15, CONTRACTS.md) — the server dual-accepts the legacy stripped
    // form during migration.
    const msg = `POST\n/v1/vault-report?x=1\n${h['X-Knock-Timestamp']}\n${h['X-Knock-Body-Sha256']}`;
    const ok = await ed.verifyAsync(
      b64ToBytes(h['X-Knock-Signature']!),
      new TextEncoder().encode(msg),
      b64ToBytes(ident.pubkey),
    );
    expect(ok).toBe(true);
  });

  it('empty body hashes as sha256("")', async () => {
    const h = await didHeaders(
      'GET', '/v1/inbox', new Uint8Array(0),
      (await generateIdentity()).private_key_b64, DID,
    );
    expect(h['X-Knock-Body-Sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('vault report + name minimization end-to-end', () => {
  it('report carries only stats + folders', async () => {
    const report = buildVaultReport(await sampleScan());
    expect(Object.keys(report).sort()).toEqual(['folders', 'stats']);
    expect(Object.keys(report.stats).sort()).toEqual([
      'capture_files', 'people_notes', 'shareable_notes', 'total_notes',
    ]);
  });

  it('no real locked or excluded folder name appears in any built payload', async () => {
    const scanOut = await sampleScan();
    const ident = await generateIdentity();
    const manifest = await signedManifest(
      buildManifest(scanOut, { did: DID, pubkey: ident.pubkey, displayName: 'Tim' }),
      ident.private_key_b64,
    );
    const report = buildVaultReport(scanOut);
    const wire = JSON.stringify(manifest) + JSON.stringify(report) + JSON.stringify(scanOut);
    for (const lockedName of [
      'Emails', 'People', 'Journal', 'locked-mail', 'jane-doe', 'Jane', 'diary',
    ]) {
      expect(wire).not.toContain(lockedName);
    }
    expect(wire).toContain('(capture folders)');
    expect(wire).toContain('(person folders)');
    expect(wire).toContain('(excluded folders)');
  });

  it('base64 helpers round-trip', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(100));
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
  });
});
