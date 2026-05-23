// Hi-fi icon library — minimal line icons, inline SVG.
//
// Stroke-based, 1.5px width at 16×16 by default. Inherits currentColor so
// callers can tint via CSS. Each icon is a pure function returning an SVG
// element. Inspired by Lucide / Phosphor but custom-drawn so they're free
// to ship and match our line weight.

function Icon({ children, size = 16, stroke = 1.5, style }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
    >{children}</svg>
  );
}

const Icons = {
  Plus:        (p) => <Icon {...p}><path d="M8 3v10M3 8h10" /></Icon>,
  Close:       (p) => <Icon {...p}><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></Icon>,
  ChevronL:    (p) => <Icon {...p}><path d="M10 3l-5 5 5 5" /></Icon>,
  ChevronR:    (p) => <Icon {...p}><path d="M6 3l5 5-5 5" /></Icon>,
  ChevronD:    (p) => <Icon {...p}><path d="M3 6l5 5 5-5" /></Icon>,
  Search:      (p) => <Icon {...p}><circle cx="7" cy="7" r="4" /><path d="M10 10l3 3" /></Icon>,
  Settings:    (p) => <Icon {...p}><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M3.5 12.5L5 11M11 5l1.5-1.5" /></Icon>,
  Terminal:    (p) => <Icon {...p}><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4 6l2 2-2 2M8 10h3.5" /></Icon>,
  Container:   (p) => <Icon {...p}><path d="M2 5l6-3 6 3v6l-6 3-6-3V5z" /><path d="M2 5l6 3 6-3M8 8v6" /></Icon>,
  Box:         (p) => <Icon {...p}><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /></Icon>,
  Copy:        (p) => <Icon {...p}><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></Icon>,
  Folder:      (p) => <Icon {...p}><path d="M1.5 4a1 1 0 0 1 1-1H6l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4z" /></Icon>,
  Key:         (p) => <Icon {...p}><circle cx="11" cy="6" r="2.5" /><path d="M9 8l-6 6M6 11l2 2" /></Icon>,
  Trash:       (p) => <Icon {...p}><path d="M2.5 4h11M5.5 4V2.5h5V4M4 4l.5 9a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9L12 4M6.5 7v4M9.5 7v4" /></Icon>,
  Refresh:     (p) => <Icon {...p}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" /></Icon>,
  Play:        (p) => <Icon {...p}><path d="M4 2.5l9 5.5-9 5.5v-11z" /></Icon>,
  Pause:       (p) => <Icon {...p}><path d="M5 2.5v11M11 2.5v11" /></Icon>,
  Stop:        (p) => <Icon {...p}><rect x="3" y="3" width="10" height="10" rx="1" /></Icon>,
  Alert:       (p) => <Icon {...p}><path d="M8 2l6.5 11.5h-13L8 2zM8 6.5v3.5M8 12v.5" /></Icon>,
  Check:       (p) => <Icon {...p}><path d="M3 8l3.5 3.5L13 5" /></Icon>,
  Info:        (p) => <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.8v.4" /></Icon>,
  More:        (p) => <Icon {...p}><circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" /></Icon>,
  Zap:         (p) => <Icon {...p}><path d="M9 1L2 9.5h5L7 15l7-8.5H9L9 1z" /></Icon>,
  Layers:      (p) => <Icon {...p}><path d="M8 1.5l6.5 3.5L8 8.5 1.5 5 8 1.5z M1.5 8L8 11.5 14.5 8 M1.5 11L8 14.5 14.5 11" /></Icon>,
  Filter:      (p) => <Icon {...p}><path d="M1.5 3h13l-5 6v5l-3-1.5V9l-5-6z" /></Icon>,
  Upload:      (p) => <Icon {...p}><path d="M3 11v2.5h10V11M8 2v8M4.5 5.5L8 2l3.5 3.5" /></Icon>,
  Download:    (p) => <Icon {...p}><path d="M3 11v2.5h10V11M8 2v8M4.5 6.5L8 10l3.5-3.5" /></Icon>,
  X:           (p) => <Icon {...p}><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></Icon>,
  CommandKey:  (p) => <Icon {...p}><path d="M5 5h6v6H5z M5 5a1.5 1.5 0 1 0-1.5 1.5H5 M5 11a1.5 1.5 0 1 1-1.5-1.5H5 M11 5a1.5 1.5 0 1 1 1.5 1.5H11 M11 11a1.5 1.5 0 1 0 1.5-1.5H11" /></Icon>,
  Spinner:     ({ size = 12 }) => (
    <span style={{
      display: 'inline-block',
      width: size, height: size,
      border: '1.5px solid currentColor',
      borderTopColor: 'transparent',
      borderRadius: '50%',
      animation: 'hifiSpin 0.85s linear infinite',
    }} />
  ),
  Menu:        (p) => <Icon {...p}><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></Icon>,
  Lock:        (p) => <Icon {...p}><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></Icon>,
  History:     (p) => <Icon {...p}><path d="M2 8a6 6 0 1 0 1.7-4.2M2 2v3h3M8 4.5V8l2.5 1.5" /></Icon>,
};

Object.assign(window, { Icon, Icons });
