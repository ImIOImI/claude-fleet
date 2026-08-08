// Shared modal backdrop. Every modal renders inside this instead of a raw
// <div className="modal-backdrop" onClick={onClose}> so that dismissal only
// happens when the press starts and ends on the backdrop — see
// backdropDismiss.ts for why onClick alone closes on text-selection drags.

import { useRef, type ReactNode } from 'react';
import { createBackdropDismiss } from './backdropDismiss';

interface Props {
  /** Omit (undefined) to disable backdrop dismissal, e.g. while busy. */
  onClose?: () => void;
  children: ReactNode;
}

export function ModalBackdrop({ onClose, children }: Props) {
  const dismiss = useRef(createBackdropDismiss());
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => dismiss.current.mouseDown(e.target === e.currentTarget, e.button)}
      onMouseUp={(e) => {
        if (dismiss.current.mouseUp(e.target === e.currentTarget)) onClose?.();
      }}
    >
      {children}
    </div>
  );
}
