// Hi-fi shared primitives: theme context, mock data, base components used
// across the hi-fi app + screens.

const HF = {};

// ── Theme ────────────────────────────────────────────────────────────────
HF.ThemeCtx = React.createContext({ mode: 'dark' });
HF.useMode = () => React.useContext(HF.ThemeCtx).mode;

// ── Mock data (richer than wireframe so hi-fi looks real) ───────────────

HF.containers = [
  {
    id: 'c1', accent: 'c1',
    name: 'docs-refactor',
    image: 'claude-fleet/runner:latest',
    subdir: 'apps/docs',
    workspace: '/Users/sam/code/sumer-monorepo',
    profile: 'work',
    status: 'busy',
    statusText: 'editing 3 files',
    cost: 0.42,
    tokens: { in: 4820, out: 1622, cacheRd: 32140 },
    cpus: '2.0',
    mem: '4096 MB',
    elapsed: '14m',
    terminals: [
      { id: 'c1-main',  name: 'main',  status: 'busy', desc: 'editing 3 files',     transcript: 'mdx',  context: { used:  78400, max: 200000 }, mirrored: true,  mirrorSize: 1843200, mirrorEvents: 412 },
      { id: 'c1-fixes', name: 'fixes', status: 'idle', desc: 'idle · 11m',           transcript: 'idle', context: { used:   4200, max: 200000 }, mirrored: false, mirrorSize: 0,       mirrorEvents: 0   },
    ],
  },
  {
    id: 'c2', accent: 'c2',
    name: 'api-tests',
    image: 'claude-fleet/runner:latest',
    subdir: 'services/api',
    workspace: '/Users/sam/code/sumer-monorepo',
    profile: 'work',
    status: 'needs-input',
    statusText: 'awaiting your reply',
    cost: 1.08,
    tokens: { in: 12346, out: 4128, cacheRd: 88402 },
    cpus: '2.0',
    mem: '4096 MB',
    elapsed: '24m',
    terminals: [
      { id: 'c2-main',    name: 'main',    status: 'needs-input', desc: 'awaiting your reply',  transcript: 'retry', context: { used: 168200, max: 200000 }, mirrored: false, mirrorSize: 0,       mirrorEvents: 0   },
      { id: 'c2-review',  name: 'review',  status: 'idle',        desc: 'idle · 8m',             transcript: 'idle',  context: { used:  12400, max: 200000 }, mirrored: true,  mirrorSize: 624400,  mirrorEvents: 148 },
      { id: 'c2-scratch', name: 'scratch', status: 'busy',        desc: 'running flake hunt',    transcript: 'flake', context: { used:  18800, max: 200000 }, mirrored: false, mirrorSize: 0,       mirrorEvents: 0   },
    ],
  },
  {
    id: 'c3', accent: 'c3',
    name: 'design-system',
    image: 'claude-fleet/runner:latest',
    subdir: 'packages/ui',
    workspace: '/Users/sam/code/sumer-monorepo',
    profile: 'personal',
    status: 'idle',
    statusText: 'idle · 2m',
    cost: 0.17,
    tokens: { in: 2104, out: 612, cacheRd: 14008 },
    cpus: '1.0',
    mem: '2048 MB',
    elapsed: '32m',
    terminals: [
      { id: 'c3-main', name: 'main', status: 'idle', desc: 'idle · 2m', transcript: 'tokens', context: { used: 2100, max: 200000 }, mirrored: false, mirrorSize: 0, mirrorEvents: 0 },
    ],
  },
];

HF.containerById = (id) => HF.containers.find((c) => c.id === id);

HF.sessions = [
  { id: 's-a', container: 'c2', title: 'Wire up retry budget for /v1/jobs',          when: '2m ago',    cost: 1.08, active: true,  msgs: 22, tools: 19 },
  { id: 's-b', container: 'c1', title: 'Refactor MDX loader to use streaming',        when: '14m ago',   cost: 0.42, active: false, msgs: 11, tools: 8  },
  { id: 's-c', container: 'c3', title: 'Token audit — collapse duplicate radii',      when: '1h ago',    cost: 0.17, active: false, msgs: 7,  tools: 4  },
  { id: 's-d', container: 'c1', title: 'Wrangle redirect rules for legacy /help/*',   when: '3h ago',    cost: 0.61, active: false, msgs: 18, tools: 12 },
  { id: 's-e', container: 'c2', title: 'Make fixture seed deterministic',             when: 'yesterday', cost: 0.34, active: false, msgs: 9,  tools: 6  },
  { id: 's-f', container: 'c3', title: 'Audit Button focus ring vs WCAG 2.5',         when: 'yesterday', cost: 0.22, active: false, msgs: 6,  tools: 3  },
  { id: 's-g', container: 'c1', title: 'Migrate remaining content from Notion export',when: '2d ago',    cost: 1.84, active: false, msgs: 41, tools: 27 },
  { id: 's-h', container: 'c2', title: 'Investigate flaky test in PaymentsSpec',      when: '3d ago',    cost: 0.96, active: false, msgs: 19, tools: 14 },
];

HF.profiles = [
  { name: 'work',     hint: 'sk-ant-•••8c2a', used: ['docs-refactor', 'api-tests'] },
  { name: 'personal', hint: 'sk-ant-•••0f17', used: ['design-system'] },
  { name: 'client-x', hint: 'sk-ant-•••a3b9', used: [] },
];

// Terminal transcripts — keyed by `transcript` field on each terminal in
// HF.containers. Different content per terminal so switching tabs (or
// switching containers) shows visibly different output.
HF.transcripts = {
  retry: [
    { kind: 'sys',    text: '╭─ claude-fleet · exec · claude --resume s-a ────────────────────────' },
    { kind: 'sys',    text: '│ workspace  /workspace/services/api' },
    { kind: 'sys',    text: '│ profile    work · model claude-sonnet-4.5' },
    { kind: 'sys',    text: '│ resumed    22 messages, 19 tool calls so far' },
    { kind: 'sys',    text: '╰──────────────────────────────────────────────────────────────────────' },
    { kind: 'blank' },
    { kind: 'user',   text: '> the retry test is still flaky on CI. can you take a look?' },
    { kind: 'blank' },
    { kind: 'agent',  text: 'I see two recent failures on PaymentsSpec#retries_budget. Reading the' },
    { kind: 'agent',  text: 'test file now to understand what it asserts.' },
    { kind: 'blank' },
    { kind: 'tool',   tool: 'Read',  text: 'services/api/test/payments_spec.rb' },
    { kind: 'tool',   tool: 'Read',  text: 'services/api/lib/payments/retry_budget.rb' },
    { kind: 'blank' },
    { kind: 'agent',  text: 'The budget is keyed off `Time.now` but the test stubs the clock' },
    { kind: 'agent',  text: 'after the budget is constructed. Moving the stub before new(…).' },
    { kind: 'blank' },
    { kind: 'tool',   tool: 'Edit',  text: 'services/api/test/payments_spec.rb', meta: '+4 −2' },
    { kind: 'tool',   tool: 'Bash',  text: 'bundle exec rspec test/payments_spec.rb', meta: '2.4s · 14 passed' },
    { kind: 'blank' },
    { kind: 'agent',  text: 'All 14 examples pass locally. Want me to push the fix?' },
    { kind: 'prompt' },
  ],
  mdx: [
    { kind: 'sys',    text: '╭─ claude-fleet · exec · claude --resume s-b ────────────────────────' },
    { kind: 'sys',    text: '│ workspace  /workspace/apps/docs' },
    { kind: 'sys',    text: '│ profile    work · model claude-sonnet-4.5' },
    { kind: 'sys',    text: '╰──────────────────────────────────────────────────────────────────────' },
    { kind: 'blank' },
    { kind: 'user',   text: '> refactor the MDX loader to stream chunks instead of buffering whole' },
    { kind: 'user',   text: '  files into memory. doc pages are getting too big.' },
    { kind: 'blank' },
    { kind: 'agent',  text: 'Reading the current implementation first to map the surface area.' },
    { kind: 'blank' },
    { kind: 'tool',   tool: 'Read',  text: 'apps/docs/src/mdx-loader.ts' },
    { kind: 'tool',   tool: 'Read',  text: 'apps/docs/src/mdx-renderer.tsx' },
    { kind: 'tool',   tool: 'Grep',  text: 'mdxLoader(', meta: '7 callsites' },
    { kind: 'blank' },
    { kind: 'agent',  text: 'I\'ll move the parser onto a Transform stream and update the renderer' },
    { kind: 'agent',  text: 'to consume chunks. The callsites all use async iteration so no API' },
    { kind: 'agent',  text: 'changes are needed downstream.' },
    { kind: 'blank' },
    { kind: 'tool',   tool: 'Edit',  text: 'apps/docs/src/mdx-loader.ts',     meta: '+24 −16' },
    { kind: 'tool',   tool: 'Edit',  text: 'apps/docs/src/mdx-renderer.tsx',  meta: '+6 −2'   },
    { kind: 'tool',   tool: 'Edit',  text: 'apps/docs/src/types.ts',           meta: '+3 −0'   },
    { kind: 'tool',   tool: 'Bash',  text: 'npm run dev', meta: 'starting…' },
    { kind: 'agent',  text: 'Dev server is up. Let me load the largest doc and confirm it streams.' },
  ],
  flake: [
    { kind: 'sys',    text: '╭─ claude-fleet · exec · claude (new) ────────────────────────────────' },
    { kind: 'sys',    text: '│ workspace  /workspace/services/api · scratch' },
    { kind: 'sys',    text: '╰──────────────────────────────────────────────────────────────────────' },
    { kind: 'blank' },
    { kind: 'user',   text: '> can you re-run PaymentsSpec 30x with random seeds to flush out' },
    { kind: 'user',   text: '  any remaining flake?' },
    { kind: 'blank' },
    { kind: 'agent',  text: 'On it. I\'ll loop rspec with --seed random and collect failures.' },
    { kind: 'blank' },
    { kind: 'tool',   tool: 'Bash',  text: 'for i in $(seq 30); do bundle exec rspec --seed random …', meta: '12/30 · 1 failure' },
    { kind: 'agent',  text: '12 of 30 runs complete. One failure so far on seed 0xa3b9. Capturing.' },
    { kind: 'prompt' },
  ],
  tokens: [
    { kind: 'sys',    text: '╭─ claude-fleet · exec · claude (new) ────────────────────────────────' },
    { kind: 'sys',    text: '│ workspace  /workspace/packages/ui' },
    { kind: 'sys',    text: '│ profile    personal · model claude-sonnet-4.5' },
    { kind: 'sys',    text: '╰──────────────────────────────────────────────────────────────────────' },
    { kind: 'blank' },
    { kind: 'sys',    text: '  No active task. Type your request and press Enter.' },
    { kind: 'blank' },
    { kind: 'prompt' },
  ],
  idle: [
    { kind: 'sys',    text: '╭─ claude-fleet · exec · claude (new) ────────────────────────────────' },
    { kind: 'sys',    text: '╰──────────────────────────────────────────────────────────────────────' },
    { kind: 'blank' },
    { kind: 'sys',    text: '  No active task. Type your request and press Enter.' },
    { kind: 'blank' },
    { kind: 'prompt' },
  ],
};

// Back-compat: keep the old export for places still reading it.
HF.terminalLines = HF.transcripts.retry;

// Container accent helpers (use CSS variables so we get theme adaptation)
HF.accent = (id, key = 'fg') => {
  // 'fg' → solid color, 'soft' → light tinted background, 'tint' → even softer
  const map = { fg: '', soft: '-soft', tint: '-tint' };
  return `var(--${id}${map[key]})`;
};

// ── Status indicators ────────────────────────────────────────────────────

HF.StatusDot = ({ status, size = 8, animated = true }) => {
  const tone =
    status === 'needs-input' ? 'var(--danger)' :
    status === 'busy'        ? 'var(--warn)'   :
    status === 'running'     ? 'var(--ok)'     :
    status === 'errored'     ? 'var(--danger)' :
    status === 'stopped'     ? 'var(--ink-3)'  :
    /* idle */                 'var(--ink-2)';
  const pulse = animated && (status === 'needs-input' || status === 'busy');
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: size, height: size }}>
      {pulse && (
        <span style={{
          position: 'absolute', inset: -2, borderRadius: '50%',
          background: tone, opacity: 0.45,
          animation: 'hifiPulse 1.8s cubic-bezier(0.16, 1, 0.3, 1) infinite',
        }} />
      )}
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: status === 'stopped' ? 'transparent' : tone,
        border: status === 'stopped' ? `1.5px solid ${tone}` : 'none',
      }} />
    </span>
  );
};

// Small colored square representing a container (used in sessions list, etc.)
HF.ContainerBadge = ({ id, size = 12 }) => (
  <span style={{
    display: 'inline-block', width: size, height: size,
    background: HF.accent(id, 'soft'),
    border: `1.5px solid ${HF.accent(id, 'fg')}`,
    borderRadius: 3,
    flexShrink: 0,
  }} />
);

// TerminalPips — a horizontal row of small status dots, one per terminal
// attached to a container. Each pip is colored by that terminal's status,
// so a glance at the chip tells you "this container has 3 terminals; the
// first wants my input." The active terminal (if specified) renders with
// a subtle ring to distinguish it from background sessions.
HF.TerminalPips = ({ terminals, activeId, size = 7, gap = 5, animated = true }) => {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap }}
      title={terminals.map((t) => `${t.name} · ${t.status}`).join('\n')}
    >
      {terminals.map((t) => (
        <span key={t.id} style={{
          position: 'relative',
          display: 'inline-flex', width: size, height: size,
          padding: t.id === activeId ? 1 : 0,
          borderRadius: '50%',
          boxShadow: t.id === activeId
            ? 'inset 0 0 0 1.5px color-mix(in oklch, currentColor 0%, var(--ink) 65%)'
            : 'none',
        }}>
          <HF.StatusDot status={t.status} size={size - (t.id === activeId ? 2 : 0)} animated={animated} />
        </span>
      ))}
    </span>
  );
};

// ── Buttons ──────────────────────────────────────────────────────────────

HF.Btn = ({ children, kind = 'ghost', size = 'md', icon, iconRight, onClick, style, ...rest }) => {
  const styles = {
    primary: {
      background: 'var(--ink)', color: 'var(--bg)',
      border: '1px solid var(--ink)',
    },
    secondary: {
      background: 'var(--bg-2)', color: 'var(--ink)',
      border: '1px solid var(--rule)',
    },
    ghost: {
      background: 'transparent', color: 'var(--ink-1)',
      border: '1px solid var(--rule)',
    },
    quiet: {
      background: 'transparent', color: 'var(--ink-1)',
      border: '1px solid transparent',
    },
    danger: {
      background: 'transparent', color: 'var(--danger)',
      border: '1px solid color-mix(in oklch, var(--danger), transparent 60%)',
    },
  }[kind];
  const sz = {
    sm: { padding: '4px 8px',  fontSize: 11, gap: 5, height: 24 },
    md: { padding: '6px 12px', fontSize: 12, gap: 6, height: 30 },
    lg: { padding: '8px 16px', fontSize: 13, gap: 8, height: 36 },
  }[size];
  return (
    <button onClick={onClick} style={{
      ...styles, ...sz,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: 6, cursor: 'pointer',
      fontWeight: 500,
      letterSpacing: -0.005,
      transition: 'background 120ms ease, border-color 120ms ease',
      fontFamily: 'inherit',
      ...style,
    }} {...rest}>
      {icon}
      {children && <span>{children}</span>}
      {iconRight}
    </button>
  );
};

// Subtle card surface
HF.Card = ({ children, padding = 14, style, ...rest }) => (
  <div style={{
    background: 'var(--bg-card)',
    border: '1px solid var(--rule)',
    borderRadius: 8,
    padding,
    ...style,
  }} {...rest}>{children}</div>
);

// Inline mono "kbd"-style pill
HF.Kbd = ({ children }) => (
  <span className="mono" style={{
    background: 'var(--bg-2)', border: '1px solid var(--rule)',
    borderRadius: 3, padding: '1px 5px', fontSize: 10,
    letterSpacing: 0.02, textTransform: 'none', color: 'var(--ink-1)',
  }}>{children}</span>
);

// Human-readable bytes — 1.8 MB, 624 KB, etc. Single-decimal for the
// short forms; whole numbers under 10 KB to avoid clutter.
HF.fmtBytes = (n) => {
  if (n === 0 || n == null) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const dp = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 1;
  return `${v.toFixed(dp)} ${units[i]}`;
};

Object.assign(window, { HF });
