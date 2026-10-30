import type { RecordDateRange, RecordEvent, CallOutcome } from './event-types.js';
import { EARLY_HANGUP_SECONDS } from './event-types.js';

export type CallOutcomeCategory = CallOutcome | 'unreported';

export interface CallOutcomeSummary {
  outcome: CallOutcomeCategory;
  count: number;
  share: number;
  averageDurationSeconds: number | null;
}

export interface CallAnalytics {
  totalCalls: number;
  averageDurationSeconds: number | null;
  outcomes: CallOutcomeSummary[];
  handovers: { attempts: number; successes: number; rate: number | null };
}

const OUTCOME_ORDER: readonly CallOutcomeCategory[] = [
  'left_message', 'confused', 'thought_human', 'spam', 'handed_over', 'early_hangup', 'unreported',
];
const CALL_OUTCOMES: ReadonlySet<string> = new Set(OUTCOME_ORDER.filter((outcome) => outcome !== 'unreported'));

interface CallHistory {
  start?: RecordEvent;
  end?: RecordEvent;
  events: RecordEvent[];
}

interface OutcomeBucket { count: number; durations: number[] }

export function aggregateCallAnalytics(events: readonly RecordEvent[], range: RecordDateRange = {}): CallAnalytics {
  const from = parseBound(range.from, 'from');
  const to = parseBound(range.to, 'to');
  if (from !== undefined && to !== undefined && from >= to) throw new Error('from must be earlier than to');

  const calls = new Map<string, CallHistory>();
  for (const event of events) {
    if (event.kind !== 'call' || event.test) continue;
    let call = calls.get(event.interactionId);
    if (!call) {
      call = { events: [] };
      calls.set(event.interactionId, call);
    }
    call.events.push(event);
    if (event.type === 'call.started' && (!call.start || event.occurredAt < call.start.occurredAt)) call.start = event;
    if (event.type === 'call.ended' && (!call.end || event.occurredAt > call.end.occurredAt)) call.end = event;
  }

  const inRange = [...calls.values()].filter(({ start }) => {
    if (!start) return false;
    const at = Date.parse(start.occurredAt);
    return (from === undefined || at >= from) && (to === undefined || at < to);
  });
  const durations: number[] = [];
  const byOutcome = new Map<CallOutcomeCategory, OutcomeBucket>();
  let attempts = 0;
  let successes = 0;

  for (const call of inRange) {
    const duration = durationOf(call.end);
    if (duration !== null) durations.push(duration);
    const ordered = call.events.slice().sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const transfers = ordered.filter((event) => event.type === 'call.transferred');
    const conferences = ordered.filter((event) => event.type === 'conference.added');
    if (transfers.length) {
      attempts++;
      if (conferences.some((event) => Date.parse(event.occurredAt) > Date.parse(transfers[0].occurredAt))) successes++;
    }
    const outcome = reportedOutcome(ordered, duration)
      ?? (duration !== null && duration < EARLY_HANGUP_SECONDS ? 'early_hangup' : undefined)
      ?? (transfers.length ? 'handed_over' : 'unreported');
    const bucket = byOutcome.get(outcome) ?? { count: 0, durations: [] };
    bucket.count++;
    if (duration !== null) bucket.durations.push(duration);
    byOutcome.set(outcome, bucket);
  }

  const totalCalls = inRange.length;
  const outcomes = OUTCOME_ORDER.map((outcome) => {
    const bucket = byOutcome.get(outcome) ?? { count: 0, durations: [] };
    return {
      outcome,
      count: bucket.count,
      share: totalCalls ? bucket.count / totalCalls : 0,
      averageDurationSeconds: bucket.durations.length ? mean(bucket.durations) : null,
    };
  });
  return {
    totalCalls,
    averageDurationSeconds: durations.length ? mean(durations) : null,
    outcomes,
    handovers: { attempts, successes, rate: attempts ? successes / attempts : null },
  };
}

function reportedOutcome(events: readonly RecordEvent[], duration: number | null): CallOutcome | undefined {
  for (const event of events) {
    if (event.type !== 'call.outcome') continue;
    const outcome = event.details.outcome;
    if (typeof outcome !== 'string' || !CALL_OUTCOMES.has(outcome)) continue;
    if (outcome === 'early_hangup' && (duration === null || duration >= EARLY_HANGUP_SECONDS)) continue;
    return outcome as CallOutcome;
  }
  return undefined;
}

function durationOf(event?: RecordEvent): number | null {
  const milliseconds = event?.details.durationMilliseconds;
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds / 1000;
  const value = event?.details.durationSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseBound(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || !value.endsWith('Z')) throw new Error(`invalid UTC ${name} bound`);
  return at;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
