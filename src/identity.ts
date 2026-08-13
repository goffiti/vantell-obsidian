/**
 * Device identity storage — the ONE place the Ed25519 seed lives.
 *
 * HARD RULE: the seed goes into DEVICE-LOCAL storage only
 * (App.saveLocalStorage — per-vault, per-device, excluded from Obsidian
 * Sync / iCloud / git). It must NEVER be written into the vault or into the
 * plugin's data.json: both sync, and a synced signing key is a leaked
 * signing key. Nothing here logs or transmits the seed.
 */
import type { App } from 'obsidian';
import { generateIdentity, type DeviceIdentity } from '@vantell/vaultscan-core';

const STORE_KEY = 'vantell-identity';

/** Device-local, vault-scoped storage. Public API on App since 1.5; typed
 * defensively with a window.localStorage fallback (same locality behavior —
 * Obsidian's own implementation delegates to appId-prefixed localStorage). */
interface LocalStore {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, value: unknown): void;
}

function store(app: App): LocalStore {
  const a = app as unknown as Partial<LocalStore> & { appId?: string };
  if (typeof a.loadLocalStorage === 'function' && typeof a.saveLocalStorage === 'function') {
    return a as LocalStore;
  }
  const prefix = `${a.appId ?? 'obsidian'}-`;
  return {
    loadLocalStorage: (key) => {
      const raw = window.localStorage.getItem(prefix + key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    saveLocalStorage: (key, value) => {
      if (value === null || value === undefined) window.localStorage.removeItem(prefix + key);
      else window.localStorage.setItem(prefix + key, JSON.stringify(value));
    },
  };
}

/** Device-local JSON value (never synced with the vault) — the L-DEVICE
 * store of doc/trust-architecture.md. Used for the mesh state (DeviceState)
 * alongside the string secrets below. */
export function loadLocalJson(app: App, key: string): unknown {
  return store(app).loadLocalStorage(key);
}

export function saveLocalJson(app: App, key: string, value: unknown): void {
  store(app).saveLocalStorage(key, value);
}

/** Device-local string secret (never synced with the vault). Shared by the
 * signing identity and the optional Anthropic API key. */
export function loadLocalSecret(app: App, key: string): string | null {
  const v = store(app).loadLocalStorage(key);
  return typeof v === 'string' && v ? v : null;
}

export function saveLocalSecret(app: App, key: string, value: string | null): void {
  store(app).saveLocalStorage(key, value && value.trim() ? value.trim() : null);
}

export interface StoredIdentity extends DeviceIdentity {
  /** API base pinned at pairing time (the /v1/pair/claim response). */
  api?: string;
}

export function loadIdentity(app: App): StoredIdentity | null {
  const v = store(app).loadLocalStorage(STORE_KEY);
  if (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as StoredIdentity).private_key_b64 === 'string' &&
    typeof (v as StoredIdentity).pubkey === 'string'
  ) {
    return v as StoredIdentity;
  }
  return null;
}

export function saveIdentity(app: App, ident: StoredIdentity): void {
  store(app).saveLocalStorage(STORE_KEY, ident);
}

export function clearIdentity(app: App): void {
  store(app).saveLocalStorage(STORE_KEY, null);
}

/** Existing identity, or a freshly generated (un-paired) one — persisted. */
export async function loadOrCreateIdentity(app: App): Promise<StoredIdentity> {
  const existing = loadIdentity(app);
  if (existing) return existing;
  const fresh = await generateIdentity();
  saveIdentity(app, fresh);
  return fresh;
}
