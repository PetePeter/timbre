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
