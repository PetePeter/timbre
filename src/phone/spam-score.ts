import type { RecordEvent } from '../records/event-types.js';
import { normalizeNumber } from './phone-config.js';

const SPAM_HISTORY_WINDOW_MS = 90 * 24 * 60 * 60_000;
const SPAM_HISTORY_MAX_NUMBERS = 20_000;
const SPAM_HISTORY_MAX_EVENTS_PER_NUMBER = 50;

export interface SpamHistoryEvent {
  type: string;
  interactionId: string;
  occurredAt: string;
  details: Record<string, unknown>;
  test?: true;
}

/** Extension point for a future local signal source. No provider is registered by default. */
export interface SpamScoreSource {
  score(number: string, history: readonly SpamHistoryEvent[]): number;
}

export interface SpamScoreAssessment {
  score: number;
  recentShortCalls: number;
  spamVerdicts: number;
  autoBlock: boolean;
}

export interface SpamHistoryIndex {
  countryCode: string;
  byNumber: Map<string, RecordEvent[]>;
  numberByInteraction: Map<string, string>;
}

const HISTORY_WINDOW_MS = 90 * 24 * 60 * 60_000;
const SHORT_CALL_WINDOW_MS = 24 * 60 * 60_000;

function indexedCaller(event: RecordEvent): string | null {
  if ((event.type !== 'call.started' && event.type !== 'call.blocked')
    || event.details.direction !== 'inbound' || typeof event.details.from !== 'string') return null;
  return event.details.from;
}

function pruneSpamHistory(index: SpamHistoryIndex, number: string, now: number): RecordEvent[] {
  const events = index.byNumber.get(number) ?? [];
  const cutoff = now - SPAM_HISTORY_WINDOW_MS;
  const recent = events.filter((event) => {
    const at = Date.parse(event.occurredAt);
    return Number.isFinite(at) && at >= cutoff && at <= now;
  }).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  const kept = recent.slice(-SPAM_HISTORY_MAX_EVENTS_PER_NUMBER);
  const retainedInteractions = new Set(kept
    .filter((event) => indexedCaller(event) !== null)
    .map((event) => event.interactionId));
  for (const event of events) {
    if (indexedCaller(event) !== null && !retainedInteractions.has(event.interactionId)
      && index.numberByInteraction.get(event.interactionId) === number) {
      index.numberByInteraction.delete(event.interactionId);
    }
  }
  index.byNumber.delete(number);
  if (kept.length) index.byNumber.set(number, kept);
  return kept;
}

function addSpamEvent(index: SpamHistoryIndex, number: string, event: RecordEvent, now: number): void {
  let events = index.byNumber.get(number);
  if (!events) {
    if (index.byNumber.size >= SPAM_HISTORY_MAX_NUMBERS) {
      const oldest = index.byNumber.keys().next().value as string | undefined;
      const evicted = oldest ? index.byNumber.get(oldest) : undefined;
      if (oldest) index.byNumber.delete(oldest);
      for (const prior of evicted ?? []) {
        if (indexedCaller(prior) !== null && index.numberByInteraction.get(prior.interactionId) === oldest) {
          index.numberByInteraction.delete(prior.interactionId);
        }
      }
    }
    events = [];
    index.byNumber.set(number, events);
  }
  events.push(event);
  pruneSpamHistory(index, number, now);
}

/** Add one recent event to the caller index; outcomes follow their inbound call's interaction. */
export function appendSpamHistoryEvent(index: SpamHistoryIndex, event: RecordEvent, now = Date.now()): void {
  if (event.test) return;
  const at = Date.parse(event.occurredAt);
  if (!Number.isFinite(at) || at < now - SPAM_HISTORY_WINDOW_MS || at > now) return;

  const rawNumber = indexedCaller(event);
  if (rawNumber !== null) {
    const number = normalizeNumber(rawNumber, index.countryCode);
    if (!number) return;
    index.numberByInteraction.set(event.interactionId, number);
    addSpamEvent(index, number, event, now);
    return;
  }

  if (event.type === 'call.outcome') {
    const number = index.numberByInteraction.get(event.interactionId);
    if (number) addSpamEvent(index, number, event, now);
  }
}

/** Build the phone's recent caller index once from its persisted event history. */
export function createSpamHistoryIndex(countryCode: string, events: readonly RecordEvent[], now = Date.now()): SpamHistoryIndex {
  const index: SpamHistoryIndex = { countryCode, byNumber: new Map(), numberByInteraction: new Map() };
  for (const event of events) appendSpamHistoryEvent(index, event, now);
  return index;
}

/** Return and prune only one caller's events; persisted caller formatting is canonicalized for scoring. */
export function readSpamHistoryByNumber(index: SpamHistoryIndex, rawNumber: string, now = Date.now()): readonly RecordEvent[] {
  const number = normalizeNumber(rawNumber, index.countryCode);
  if (!number) return [];
  return pruneSpamHistory(index, number, now).map((event) => {
    const caller = indexedCaller(event);
    return caller !== null && caller !== number
      ? { ...event, details: { ...event.details, from: number } }
      : event;
  });
}

function isHistoryEvent(value: unknown): value is SpamHistoryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<SpamHistoryEvent>;
  return typeof event.type === 'string' && typeof event.interactionId === 'string'
    && typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt))
    && !!event.details && typeof event.details === 'object' && !Array.isArray(event.details);
}

/** Scores only history already scoped to this phone. The Hub supplies a per-number, 90-day slice. */
export function calculateSpamScore(number: string, history: readonly unknown[], now = new Date()): SpamScoreAssessment {
  const nowMs = now.getTime();
  const historyCutoff = nowMs - HISTORY_WINDOW_MS;
  const shortCallCutoff = nowMs - SHORT_CALL_WINDOW_MS;
  const events = history.filter(isHistoryEvent).filter((event) => {
    if (event.test) return false;
    const at = Date.parse(event.occurredAt);
    return at >= historyCutoff && at <= nowMs;
  });
  const inboundInteractions = new Set(events.filter((event) => event.type === 'call.started'
    && event.details.direction === 'inbound' && event.details.from === number).map((event) => event.interactionId));
  const priorBlock = events.some((event) => event.type === 'call.blocked'
    && event.details.direction === 'inbound' && event.details.from === number);
  const outcomes = events.filter((event) => event.type === 'call.outcome' && inboundInteractions.has(event.interactionId));
  const recentShortCalls = outcomes.filter((event) => event.details.outcome === 'early_hangup'
    && Date.parse(event.occurredAt) >= shortCallCutoff).length;
  const spamVerdicts = outcomes.filter((event) => event.details.outcome === 'spam' && event.details.source === 'agent').length;

  const score = Math.min(100,
    (recentShortCalls >= 3 ? 30 : 0)
    + (priorBlock ? 20 : 0)
    + Math.min(spamVerdicts, 2) * 30,
  );
  return { score, recentShortCalls, spamVerdicts, autoBlock: spamVerdicts >= 2 };
}
