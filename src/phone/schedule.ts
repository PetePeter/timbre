import type { InboundHandlingPolicy } from './inbound-call-policy.js';
export { INBOUND_HANDLING_ACTION_OPTIONS, isHandlingAction } from './inbound-call-policy.js';

export interface WeeklyScheduleSlot extends InboundHandlingPolicy {
  id: string;
  /** Sunday is 0 and Saturday is 6. */
  days: number[];
  start: string;
  end: string;
}

export interface PhoneSchedule {
  timeZone: string;
  slots: WeeklyScheduleSlot[];
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function defaultPhoneSchedule(): PhoneSchedule {
  return { timeZone: systemTimeZone(), slots: [] };
}

/** crypto.randomUUID is missing on insecure origins (plain-HTTP LAN), so build a v4 UUID from getRandomValues. */
export function createScheduleSlotId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localTime(date: Date, timeZone: string): { day: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const day = WEEKDAYS.indexOf(value('weekday') ?? '');
    const hour = Number(value('hour'));
    const minute = Number(value('minute'));
    if (day < 0 || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return { day, minute: hour * 60 + minute };
  } catch {
    return null;
  }
}

export function isClockTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function clockMinute(value: string): number | null {
  return isClockTime(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
}

/** Returns the active slot with the latest local start; earlier array order wins ties. */
export function resolveActiveScheduleSlot(schedule: PhoneSchedule, now: Date): WeeklyScheduleSlot | null {
  const local = localTime(now, schedule.timeZone);
  if (!local) return null;

  let active: WeeklyScheduleSlot | null = null;
  let latestStart = -Infinity;
  for (const slot of schedule.slots) {
    const start = clockMinute(slot.start);
    const end = clockMinute(slot.end);
    if (start === null || end === null || start === end || !Array.isArray(slot.days)) continue;

    let startDayOffset: number | null = null;
    if (start < end) {
      if (slot.days.includes(local.day) && local.minute >= start && local.minute < end) startDayOffset = 0;
    } else if (slot.days.includes(local.day) && local.minute >= start) {
      startDayOffset = 0;
    } else if (slot.days.includes((local.day + 6) % 7) && local.minute < end) {
      startDayOffset = -1;
    }
    if (startDayOffset === null) continue;

    const order = startDayOffset * 1440 + start;
    if (order > latestStart) {
      active = slot;
      latestStart = order;
    }
  }
  return active;
}

