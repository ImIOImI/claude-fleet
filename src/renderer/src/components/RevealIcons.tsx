import { REVEAL_SECONDS } from './secretReveal';

export function IconEye() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function IconEyeOff() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

/** Countdown ring for a revealed secret: the arc shrinks as time runs out. */
export function RevealRing({ remainingS }: { remainingS: number }) {
  const c = 2 * Math.PI * 5;
  return (
    <svg className="env-reveal-ring" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
      <circle className="track" cx="7" cy="7" r="5" />
      <circle className="left" cx="7" cy="7" r="5" strokeDasharray={c} strokeDashoffset={c * (1 - remainingS / REVEAL_SECONDS)} />
    </svg>
  );
}
