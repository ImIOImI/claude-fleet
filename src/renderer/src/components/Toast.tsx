// Unified toast UI for both placements: the global bottom-center stack
// (ToastStack, rendered by App) and a single in-tab toast (ToastView, used by
// TerminalPane for the committee message). Visual model + variants are the pure
// `../toasts` types; this is the thin render layer. Auto-dismiss timing lives in
// the caller (App schedules ttl; sticky toasts rely on the ✕).

import type { Toast } from '../toasts';

function Glyph({ kind }: { kind: Toast['kind'] }): JSX.Element | null {
  if (kind === 'progress') return <span className="toast-spinner" aria-hidden="true" />;
  if (kind === 'ok') return <span className="toast-glyph" aria-hidden="true">✓</span>;
  if (kind === 'error') return <span className="toast-glyph" aria-hidden="true">✕</span>;
  return null; // info: the eyebrow carries it (matches the old committee toast)
}

export function ToastView({
  toast,
  onDismiss
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}): JSX.Element {
  const cls = [
    'toast',
    toast.kind !== 'progress' ? toast.kind : '',
    toast.placement === 'tab' ? 'toast--tab' : ''
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} role="status" aria-live="polite">
      <Glyph kind={toast.kind} />
      <span className="toast-body">
        {toast.eyebrow && <span className="toast-eyebrow">{toast.eyebrow}</span>}
        <span className="toast-text">{toast.message}</span>
      </span>
      {toast.action && (
        <button className="toast-action" onClick={toast.action.onClick}>
          {toast.action.label}
        </button>
      )}
      {toast.secondaryAction && (
        <button className="toast-action" onClick={toast.secondaryAction.onClick}>
          {toast.secondaryAction.label}
        </button>
      )}
      {toast.dismissible && (
        <button className="toast-dismiss" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
          ×
        </button>
      )}
    </div>
  );
}

/** The global bottom-center stack. Renders only `placement: 'global'` toasts. */
export function ToastStack({
  toasts,
  onDismiss
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}): JSX.Element | null {
  const globals = toasts.filter((t) => t.placement === 'global');
  if (globals.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {globals.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
