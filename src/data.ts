/**
 * Plugin data (data.json) — SYNCS with the vault, so nothing secret may
 * ever land here. The signing key lives in device-local storage
 * (src/identity.ts); this file holds only preferences and the last
 * published summary (already-public metadata).
 */
import type { PublishedRecord } from './publish';

/** Inbox envelope as stored between polls — routing metadata + the sealed
 * payload, exactly as the relay returned it. Never note content. */
export interface StoredEnvelope {
  id: string;
  from: string;
  ciphertext: string;
  created_at: string;
}

/** An answer received to one of the owner's knocks — kept so it can be
 * reopened, not just shown once. */
export interface ReceivedAnswer {
  fromName: string;
  topic: string | null;
  summary: string;
  at: string;
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

export interface VantellData {
  displayName: string;
  /** Advanced: API base for linking (pinned per-device at pair time). */
  apiBase: string;
  lastPublished?: PublishedRecord;
  /** Inbox cursor — created_at of the newest envelope ever ingested. */
  inboxCursor?: string;
  /** Envelopes answered/dismissed — never re-surfaced. Capped list. */
  handledEnvelopes: string[];
  /** Ingested but unresolved envelopes (open requests). */
  pendingEnvelopes: StoredEnvelope[];
  /** Anthropic model for optional "Draft from my notes" (non-secret; the API
   * key itself lives in device-local storage, never here). */
  aiModel: string;
  /** True once the owner has acknowledged that drafting sends shareable-note
   * text to their own Anthropic account. Gates the first draft. */
  aiDraftConsented: boolean;
  /** Answers received to the owner's knocks — newest first, capped. */
  receivedAnswers: ReceivedAnswer[];
  /** Knocks the owner has sent — newest first, capped. */
  sentKnocks: SentKnock[];
}

export const DEFAULT_DATA: VantellData = {
  displayName: '',
  apiBase: 'https://api.vantell.ai',
  handledEnvelopes: [],
  pendingEnvelopes: [],
  aiModel: 'claude-opus-5',
  aiDraftConsented: false,
  receivedAnswers: [],
  sentKnocks: [],
};
