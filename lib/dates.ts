// Date helpers — week starts on Monday (ISO).
//
// Display helpers (weekdayShort / monthDay / weekRangeLabel) accept
// optional label-array overrides so the calling screen can pass
// translated names from i18next without us pulling react-i18next into
// the lib layer. Pure helpers stay pure — translation lives at the
// call site.

export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ... 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Default English labels — used when no override is supplied. */
const WEEKDAY_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_SHORT = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

/** Indexed by Date.getDay() — Sunday is 0. */
export function weekdayShort(date: Date, labels?: readonly string[]): string {
  return (labels ?? WEEKDAY_SHORT)[date.getDay()];
}

/** Indexed by Date.getMonth() — January is 0. */
export function monthDay(date: Date, monthLabels?: readonly string[]): string {
  return `${(monthLabels ?? MONTH_SHORT)[date.getMonth()]} ${date.getDate()}`;
}

export function weekRangeLabel(
  weekStart: Date,
  monthLabels?: readonly string[],
  separator: string = '—',
): string {
  const end = addDays(weekStart, 6);
  return `${monthDay(weekStart, monthLabels)} ${separator} ${monthDay(end, monthLabels)}`;
}

export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}
