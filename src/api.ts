/**
 * Network layer — the complete list of calls this plugin can make, all to
 * the Vantell API, all via Obsidian's requestUrl (cross-platform, no CORS):
 *
 *   POST /v1/pair/claim    — once per device: pairing code + public key
 *   POST /v1/manifest      — going live / updating (DID-signed)
 *   POST /v1/vault-report  — going live / updating (DID-signed)
 *
 * Nothing else. Payloads are built by @vantell/vaultscan-core from the
 * transmit-safe scan output only — note contents have no field to ride in.
 */
import { requestUrl } from 'obsidian';
import { didHeaders } from '@vantell/vaultscan-core';
import type { StoredIdentity } from './identity';

export const DEFAULT_API = 'https://api.vantell.ai';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function apiBase(ident: { api?: string } | null, fallback: string): string {
  return (ident?.api ?? fallback).replace(/\/+$/, '');
}

/** Claim a pairing code: binds this device's public key to the account that
 * issued the code and returns the DID (and the API base to pin). */
export async function claimPairingCode(
  base: string,
  code: string,
  pubkey: string,
): Promise<{ did: string; api: string }> {
  const res = await requestUrl({
    url: `${apiBase(null, base)}/v1/pair/claim`,
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ code: code.trim().toUpperCase(), pubkey }),
    throw: false,
  });
  if (res.status === 404) {
    throw new ApiError(
      'That code was not accepted — it may have expired (codes last 60 minutes) or been used already. Get a fresh one at app.vantell.ai/connect.',
      res.status,
    );
  }
  if (res.status !== 200 && res.status !== 201) {
    throw new ApiError(`Linking failed (HTTP ${res.status}). Please try again.`, res.status);
  }
  const body = res.json as { did?: string; api?: string };
  if (!body.did) throw new ApiError('Linking failed: no identity in the response.', res.status);
  return { did: body.did, api: body.api ?? base };
}

/** DID-signed GET — used for /v1/inbox, /v1/agent/knocks, /v1/registry.
 * The signature covers the bare path (query excluded) and an empty body. */
export async function signedGet<T>(
  ident: StoredIdentity,
  fallbackBase: string,
  path: string,
): Promise<T> {
  if (!ident.did) throw new ApiError('This device is not linked yet.', 0);
  const headers = await didHeaders(
    'GET',
    path,
    new Uint8Array(0),
    ident.private_key_b64,
    ident.did,
  );
  const res = await requestUrl({
    url: `${apiBase(ident, fallbackBase)}${path}`,
    method: 'GET',
    headers,
    throw: false,
  });
  if (res.status !== 200) {
    throw new ApiError(`Request failed (HTTP ${res.status}).`, res.status);
  }
  return res.json as T;
}

/** Approve or deny a knock addressed to the caller (DID-signed). */
export async function respondKnock(
  ident: StoredIdentity,
  fallbackBase: string,
  knockId: string,
  action: 'approve' | 'deny',
  standing = false,
): Promise<void> {
  await signedPost(ident, fallbackBase, `/v1/agent/knocks/${encodeURIComponent(knockId)}/respond`, {
    action,
    standing,
  });
}

/** DID-signed POST — used for /v1/manifest and /v1/vault-report. The
 * signature covers the sha256 of the EXACT bytes sent. */
export async function signedPost(
  ident: StoredIdentity,
  fallbackBase: string,
  path: string,
  payload: unknown,
): Promise<void> {
  if (!ident.did) throw new ApiError('This device is not linked yet.', 0);
  const bodyText = JSON.stringify(payload);
  const bodyBytes = new TextEncoder().encode(bodyText);
  const headers = await didHeaders('POST', path, bodyBytes, ident.private_key_b64, ident.did);
  const res = await requestUrl({
    url: `${apiBase(ident, fallbackBase)}${path}`,
    method: 'POST',
    contentType: 'application/json',
    headers,
    body: bodyText,
    throw: false,
  });
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(
      'The server no longer accepts this device\'s key — another device may have been linked since. Re-link this device to continue publishing from it.',
      res.status,
    );
  }
  if (res.status !== 200 && res.status !== 201) {
    throw new ApiError(`Upload failed (HTTP ${res.status}).`, res.status);
  }
}
