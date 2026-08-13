/**
 * Device identity — Ed25519 keys via @noble/ed25519 (NOT WebCrypto Ed25519),
 * DID request signing per CONTRACTS.md "DID request signing", and manifest
 * signing per build-spec §2.1.
 *
 * PURE module: no storage and no network. Hosts own both —
 *   - the portal (retired browser path) kept the seed in IndexedDB;
 *   - the Obsidian plugin keeps it in device-local storage (never synced);
 *   - tests keep it in memory.
 * The 32-byte private seed must never be logged or included in any payload.
 */
import * as ed from '@noble/ed25519';

export interface DeviceIdentity {
  /** base64 of the 32-byte Ed25519 seed — device-local only, never transmitted. */
  private_key_b64: string;
  /** base64 of the raw 32-byte public key (the format /v1/enroll stores). */
  pubkey: string;
  /** did:knock:<org>:<user> — set after enrollment/pairing. */
  did?: string;
  display_name?: string;
}

/* ---------------------------------------------------------------- base64 */

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* -------------------------------------------------------------- identity */

export async function generateIdentity(): Promise<DeviceIdentity> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed.getPublicKeyAsync(seed);
  return { private_key_b64: bytesToB64(seed), pubkey: bytesToB64(pub) };
}

/* --------------------------------------------------------------- signing */

/** Canonical JSON for signatures: sorted keys, no whitespace, raw unicode —
 * byte-identical to Python json.dumps(sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
      .join(',') +
    '}'
  );
}

async function signB64(message: Uint8Array, seedB64: string): Promise<string> {
  const sig = await ed.signAsync(message, b64ToBytes(seedB64));
  return bytesToB64(sig);
}

/** Ed25519 signature (raw 64 bytes, base64) over the canonical JSON of the
 * manifest WITHOUT its `sig` field. */
export async function signManifest(
  manifest: Record<string, unknown>,
  seedB64: string,
): Promise<string> {
  const unsigned: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(manifest)) if (k !== 'sig') unsigned[k] = val;
  return signB64(new TextEncoder().encode(canonicalJson(unsigned)), seedB64);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function rfc3339Now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** DID request-signing headers per CONTRACTS.md: canonical string
 * METHOD\nPATH\nTIMESTAMP\nSHA256_HEX(body or ""), plus X-Knock-Body-Sha256.
 * `path` is the bare route path (no origin, query stripped by the caller or
 * here). The host performs the actual HTTP request with these headers. */
export async function didHeaders(
  method: string,
  path: string,
  bodyBytes: Uint8Array,
  seedB64: string,
  did: string,
): Promise<Record<string, string>> {
  const ts = rfc3339Now();
  const bodySha = await sha256Hex(bodyBytes);
  // The FULL path including the query string is signed (SEC-15): an
  // unsigned query would let anyone able to tamper with it replay or
  // window the inbox. The server dual-accepts the legacy query-stripped
  // form during migration (CONTRACTS.md).
  const msg = `${method.toUpperCase()}\n${path}\n${ts}\n${bodySha}`;
  const sig = await signB64(new TextEncoder().encode(msg), seedB64);
  return {
    'X-Knock-Did': did,
    'X-Knock-Timestamp': ts,
    'X-Knock-Signature': sig,
    'X-Knock-Body-Sha256': bodySha,
  };
}
