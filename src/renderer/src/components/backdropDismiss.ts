// Decides when a backdrop press should dismiss a modal. A naive
// onClick={onClose} on the backdrop closes on any click whose common
// ancestor is the backdrop — including a text-selection drag that starts
// inside the panel and releases over the backdrop (the browser fires the
// click on the nearest common ancestor of mousedown and mouseup targets).
// Instead, require a left-button press that both starts AND ends on the
// backdrop element itself. Kept as a pure state machine so it's unit
// testable (vitest here has no DOM environment).

export interface BackdropDismiss {
  /** Call from the backdrop's mousedown. `onBackdrop` = event target is the backdrop itself. */
  mouseDown(onBackdrop: boolean, button: number): void;
  /** Call from the backdrop's mouseup. Returns true when the modal should close. */
  mouseUp(onBackdrop: boolean): boolean;
}

export function createBackdropDismiss(): BackdropDismiss {
  let armed = false;
  return {
    mouseDown(onBackdrop, button) {
      armed = onBackdrop && button === 0;
    },
    mouseUp(onBackdrop) {
      const close = armed && onBackdrop;
      armed = false;
      return close;
    }
  };
}
