export type DateRangePreset = 'today' | 'yesterday' | '7-days' | '30-days';
export interface LocalDateRange { fromDate: string; toDate: string }

export function presetRange(preset: DateRangePreset, referenceDate = new Date()): LocalDateRange {
  const to = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const dayCount = preset === 'today' || preset === 'yesterday' ? 1 : preset === '7-days' ? 7 : 30;
  if (preset === 'yesterday') to.setDate(to.getDate() - 1);
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  from.setDate(from.getDate() - dayCount + 1);
  return { fromDate: formatLocalDate(from), toDate: formatLocalDate(to) };
}

function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

export interface UtcDateRange { from: string; to: string }

/** Convert inclusive local calendar dates into UTC instants with an exclusive end. */
export function localDateRangeToUtc(fromDate: string, toDate: string): UtcDateRange {
  const from = parseLocalDate(fromDate);
  const to = parseLocalDate(toDate);
  if (from.getTime() > to.getTime()) throw new Error('start date must be on or before end date');
  const exclusiveEnd = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return { from: from.toISOString(), to: exclusiveEnd.toISOString() };
}

function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('date must use YYYY-MM-DD');
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) {
    throw new Error('invalid date');
  }
  return date;
}
