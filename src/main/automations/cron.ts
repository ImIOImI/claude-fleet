// Minimal 5-field cron (#407 Phase 3): minute hour day-of-month month day-of-week,
// with `*`, lists, ranges and steps, evaluated in an IANA time zone (default:
// host local). DOM and DOW both restricted → either matches (Vixie semantics).
// Pure; next-fire walks minutes but skips whole days/hours that can't match.

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

export class CronError extends Error {}

const FIELDS: Array<[name: string, min: number, max: number]> = [
  ['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 0, 7]
];

function parseField(raw: string, [name, min, max]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`invalid ${name} "${part}"`);
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) throw new CronError(`invalid ${name} step "${part}"`);
    let lo: number, hi: number;
    if (m[1] === '*') {
      if (m[2]) throw new CronError(`invalid ${name} "${part}"`);
      lo = min; hi = max;
    } else {
      lo = Number(m[1]);
      hi = m[2] !== undefined ? Number(m[2]) : m[3] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`${name} out of range in "${part}" (${min}–${max})`);
    for (let v = lo; v <= hi; v += step) out.add(name === 'day of week' && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { minute, hour, dom, month, dow, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number; dow: number }
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function wallClock(ms: number, tz: string | undefined): Wall {
  if (!tz) {
    const d = new Date(ms);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), dow: d.getDay() };
  }
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short'
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), dow: WEEKDAYS[p.weekday] };
}

function dayMatches(s: CronSpec, w: Wall): boolean {
  if (!s.month.has(w.mo)) return false;
  const domOk = s.dom.has(w.d), dowOk = s.dow.has(w.dow);
  if (s.domStar && s.dowStar) return true;
  if (s.domStar) return dowOk;
  if (s.dowStar) return domOk;
  return domOk || dowOk;
}

const MIN = 60_000;

/** The first minute strictly after `after` that matches, or null within ~2 years. */
export function nextFire(spec: CronSpec, after: number, tz?: string): number | null {
  let t = Math.floor(after / MIN) * MIN + MIN;
  const limit = after + 732 * 86_400_000;
  while (t <= limit) {
    const w = wallClock(t, tz);
    if (!dayMatches(spec, w)) {
      t += ((23 - w.h) * 60 + (60 - w.mi)) * MIN; // jump to next wall-clock midnight
      continue;
    }
    if (!spec.hour.has(w.h)) {
      t += (60 - w.mi) * MIN; // next hour
      continue;
    }
    if (spec.minute.has(w.mi)) return t;
    t += MIN;
  }
  return null;
}

/** Plain-language summary for lists ("every 30 min · 08–18 · Mon–Fri"). Falls back to the expression. */
export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [mi, h, dom, mo, dow] = p;
  const parts: string[] = [];
  if (/^\*\/\d+$/.test(mi) && h === '*') parts.push(`every ${mi.slice(2)} min`);
  else if (/^\*\/\d+$/.test(mi)) parts.push(`every ${mi.slice(2)} min`);
  else if (/^\d+$/.test(mi) && /^\d+(,\d+)*$/.test(h)) parts.push(`daily ${h.split(',').map((x) => `${x.padStart(2, '0')}:${mi.padStart(2, '0')}`).join(', ')}`);
  else return expr;
  if (/^\d+-\d+$/.test(h) && !parts[0].startsWith('daily')) parts.push(h.split('-').map((x) => x.padStart(2, '0')).join('–'));
  else if (h !== '*' && !parts[0].startsWith('daily')) return expr;
  if (dom !== '*' || mo !== '*') return expr;
  if (dow === '1-5') parts.push('weekdays');
  else if (dow === '0,6' || dow === '6,0') parts.push('weekends');
  else if (dow !== '*') return expr;
  return parts.join(' · ');
}
