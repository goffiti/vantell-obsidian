/**
 * Two stores, two labels (doc/trust-architecture.md §3):
 *
 *   - VantellData → data.json. SYNCS WITH THE VAULT, so it may hold only
 *     benign preferences and already-public metadata. Conversation content,
 *     cursors, and anything per-device is FORBIDDEN here — enforced by
 *     scripts/check_flows.mjs, not just this comment.
 *   - DeviceState → device-local storage (same mechanism as the signing
 *     key). Never syncs, never enters the vault, dies with the device.
 *     This is where the mesh lives: envelopes, answers, knocks, cursor,
 *     and the API base (a synced base would be a tamper path — SEC-3).
 */
import type { PublishedRecord } from './publish';

/** Inbox envelope as stored between polls — routing metadata + the sealed
 * payload, exactly as the relay returned it. Never note content. */
export interface StoredEnvelope {
  id: string;
  from: string;
  ciphertext: string;
  created_at: string;
  /** 'sealed' = crypto_box_seal to this device's key; absent = legacy b64. */
  enc?: string;
}

/** An answer received to one of the owner's knocks — kept so it can be
 * reopened, not just shown once. */
export interface ReceivedAnswer {
  fromName: string;
  topic: string | null;
  summary: string;
  at: string;
  /** Titles the answerer ticked as sources (absent on pre-0.8.11 records). */
  sources?: string[];
  /** Who sent it — how the panel threads it (absent on pre-0.11 records,
   * which fall back to name matching). */
  fromDid?: string;
}

/** An answer the owner wrote and sent — the outgoing half of a thread. Kept
 * device-local so the conversation reads as a conversation, not a one-sided
 * inbox. Same label as everything else here: never in the synced vault. */
export interface SentAnswer {
  toDid: string;
  toName: string;
  topic: string | null;
  summary: string;
  /** Note TITLES the owner ticked as sources — never note contents. */
  sources: string[];
  at: string;
  /** The question this answered, kept so the thread still reads as an
   * exchange after the envelope is cleared. Their words, device-local. */
  question?: string;
  questionAt?: string;
}

/** A knock the owner sent — the outbox side of the panel. */
export interface SentKnock {
  toDid: string;
  toName: string;
  topic: string | null;
  question: string;
  at: string;
  status: 'sent' | 'answered';
}

/** L-DEVICE: per-device mesh state. Device-local storage ONLY. */
export interface DeviceState {
  /** Advanced: API base for linking (the pin from pairing lives on the
   * identity; this is the pre-pairing fallback — device-local so vault
   * sync can never redirect another device). */
  apiBase: string;
  /** Inbox cursor — created_at of the newest envelope ever ingested. */
  inboxCursor?: string;
  /** Envelopes resolved (answered, declined, dismissed) — never re-surfaced.
   * Written only through `markHandled`, which is what actually enforces the
   * cap; the inbox cursor stops the relay re-serving what falls off. */
  handledEnvelopes: string[];
  /** Ingested but unresolved envelopes (open requests). */
  pendingEnvelopes: StoredEnvelope[];
  /** Answers received to the owner's knocks — newest first, capped. */
  receivedAnswers: ReceivedAnswer[];
  /** Knocks the owner has sent — newest first, capped. */
  sentKnocks: SentKnock[];
  /** Answers the owner has sent — newest first, capped. */
  sentAnswers: SentAnswer[];
}

export const DEFAULT_DEVICE: DeviceState = {
  apiBase: 'https://api.vantell.ai',
  handledEnvelopes: [],
  pendingEnvelopes: [],
  receivedAnswers: [],
  sentKnocks: [],
  sentAnswers: [],
};

/** L-VAULTCFG-adjacent: preferences and already-public metadata only. */
export interface VantellData {
  displayName: string;
  lastPublished?: PublishedRecord;
  /** Anthropic model for optional "Draft from my notes" (non-secret; the API
   * key itself lives in device-local storage, never here). */
  aiModel: string;
  /** True once the owner has acknowledged that drafting sends shareable-note
   * text to their own Anthropic account. Gates the first draft. */
  aiDraftConsented: boolean;
}

export const DEFAULT_DATA: VantellData = {
  displayName: '',
  aiModel: 'claude-opus-5',
  aiDraftConsented: false,
};

/** One-time migration (pre-0.9.0 data.json carried the mesh): lift legacy
 * fields into DeviceState and report whether data.json needs rewriting. */
export function migrateLegacyData(
  raw: Record<string, unknown>,
  device: DeviceState,
): { device: DeviceState; hadLegacy: boolean } {
  const legacyKeys = [
    'apiBase',
    'inboxCursor',
    'handledEnvelopes',
    'pendingEnvelopes',
    'receivedAnswers',
    'sentKnocks',
  ] as const;
  const hadLegacy = legacyKeys.some((k) => k in raw);
  if (!hadLegacy) return { device, hadLegacy };
  const merged: DeviceState = {
    apiBase:
      typeof raw['apiBase'] === 'string' && raw['apiBase'] ? raw['apiBase'] : device.apiBase,
    inboxCursor:
      typeof raw['inboxCursor'] === 'string' ? raw['inboxCursor'] : device.inboxCursor,
    handledEnvelopes: Array.isArray(raw['handledEnvelopes'])
      ? (raw['handledEnvelopes'] as string[])
      : device.handledEnvelopes,
    pendingEnvelopes: Array.isArray(raw['pendingEnvelopes'])
      ? (raw['pendingEnvelopes'] as StoredEnvelope[])
      : device.pendingEnvelopes,
    receivedAnswers: Array.isArray(raw['receivedAnswers'])
      ? (raw['receivedAnswers'] as ReceivedAnswer[])
      : device.receivedAnswers,
    sentKnocks: Array.isArray(raw['sentKnocks'])
      ? (raw['sentKnocks'] as SentKnock[])
      : device.sentKnocks,
    // Never existed in the pre-0.9.0 layout — nothing to lift.
    sentAnswers: device.sentAnswers,
  };
  return { device: merged, hadLegacy };
}
