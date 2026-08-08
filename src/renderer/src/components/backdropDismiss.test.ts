import { describe, it, expect } from 'vitest';
import { createBackdropDismiss } from './backdropDismiss';

describe('createBackdropDismiss', () => {
  it('closes on a plain left-click that starts and ends on the backdrop', () => {
    const d = createBackdropDismiss();
    d.mouseDown(true, 0);
    expect(d.mouseUp(true)).toBe(true);
  });

  it('does not close when the press started inside the panel (text-selection drag out)', () => {
    const d = createBackdropDismiss();
    d.mouseDown(false, 0);
    expect(d.mouseUp(true)).toBe(false);
  });

  it('does not close when the press started on the backdrop but released over the panel', () => {
    const d = createBackdropDismiss();
    d.mouseDown(true, 0);
    expect(d.mouseUp(false)).toBe(false);
  });

  it('does not close on non-left buttons', () => {
    const d = createBackdropDismiss();
    d.mouseDown(true, 2);
    expect(d.mouseUp(true)).toBe(false);
  });

  it('disarms after each release — a stray mouseup without a new press never closes', () => {
    const d = createBackdropDismiss();
    d.mouseDown(true, 0);
    expect(d.mouseUp(true)).toBe(true);
    expect(d.mouseUp(true)).toBe(false);
  });

  it('disarms even when the release did not close (drag released over panel, then stray up)', () => {
    const d = createBackdropDismiss();
    d.mouseDown(true, 0);
    expect(d.mouseUp(false)).toBe(false);
    expect(d.mouseUp(true)).toBe(false);
  });

  it('recovers after a release outside the window (no mouseup seen): next full click closes', () => {
    const d = createBackdropDismiss();
    d.mouseDown(true, 0);
    // release happened off-window — no mouseUp delivered
    d.mouseDown(true, 0);
    expect(d.mouseUp(true)).toBe(true);
  });
});
