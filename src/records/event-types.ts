export type RecordEventKind = 'call' | 'sms' | 'system';

export type CallOutcome = 'left_message' | 'confused' | 'thought_human' | 'spam' | 'handed_over' | 'early_hangup';
export type AgentCallOutcome = Exclude<CallOutcome, 'early_hangup'>;
export type CallOutcomeSource = 'agent' | 'heuristic';

export const EARLY_HANGUP_SECONDS = 10;

export const EVENT_TYPES = [
  'contact.matched',
  'call.started',
  'call.blocked',
  'call.answered',
  'call.ended',
  'call.outcome',
  'call.transferred',
  'call.agent_started',
  'call.agent_reported',
  'call.owner_takeover',
  'agent.tool_started',
  'agent.tool_finished',
  'conference.added',
  'sms.received',
  'sms.sent',
  'notify.sent',
  'notify.failed',
  'policy.evaluated',
  'notification.sent',
  'retention.purged',
] as const;

export type RecordEventType = typeof EVENT_TYPES[number];

/** The record kinds an app can be granted on their own. */
export type RecordKind = Extract<RecordEventKind, 'sms' | 'call'>;

export interface RecordEvent {
  eventId: string;
  interactionId: string;
  kind: RecordEventKind;
  type: RecordEventType;
  occurredAt: string;
  details: Record<string, unknown>;
  /** Browser test calls stay visible in records but do not affect production metrics. */
  test?: true;
}

export interface RecordDateRange {
  /** Inclusive UTC instant. */
  from?: string;
  /** Exclusive UTC instant. */
  to?: string;
}

export interface RecordQueryOptions extends RecordDateRange {
  limit?: number;
  cursor?: string;
  filter?: 'all' | 'calls' | 'sms' | 'conferences' | 'blocked';
}

export interface RecordSummary {
  id: string;
  kind: RecordEventKind;
  occurredAt: string;
  lastEventAt: string;
  contact?: string;
  from?: string;
  to?: string;
  direction?: 'inbound' | 'outbound';
  action: string;
  durationSeconds?: number;
  hasConference: boolean;
  blocked: boolean;
  events: RecordEvent[];
}

export interface RecordPage {
  items: RecordSummary[];
  nextCursor: string | null;
}
