export type RecordEventKind = 'call' | 'sms' | 'system';

export type RecordEventType =
  | 'contact.matched'
  | 'call.started'
  | 'call.blocked'
  | 'call.answered'
  | 'call.ended'
  | 'call.transferred'
  | 'call.agent_started'
  | 'conference.added'
  | 'sms.received'
  | 'sms.sent'
  | 'policy.evaluated'
  | 'notification.sent'
  | 'retention.purged';

export interface RecordEvent {
  eventId: string;
  interactionId: string;
  kind: RecordEventKind;
  type: RecordEventType;
  occurredAt: string;
  details: Record<string, unknown>;
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
