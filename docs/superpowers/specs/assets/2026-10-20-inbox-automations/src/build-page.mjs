// Assembles the Inbox & Automations UI mock page from the app's real
// server-rendered chrome (chrome*.json) + its real styles.css, plus new
// components styled only with the app's design tokens.
import fs from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
const c1 = JSON.parse(fs.readFileSync(here + 'chrome.json', 'utf8'));
const c2 = JSON.parse(fs.readFileSync(here + 'chrome2.json', 'utf8'));
const c3 = JSON.parse(fs.readFileSync(here + 'chrome3.json', 'utf8'));
let appCss = fs.readFileSync('/workspace/wt-inbox/src/renderer/src/styles.css', 'utf8');
appCss = appCss.replace(/^@import[^\n]*\n/m, '').replace(/@font-face\s*\{[^}]*\}/g, '');

// ---------- icons ----------
const I = {
  tray: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  bellOff: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>`,
  auto: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`,
  jump: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
  term: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 4 4-4 4"/><path d="M12 17h7"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>`,
  key: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 17 11"/></svg>`,
  warn: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M8 1.5L1 14h14L8 1.5z" stroke="currentColor" stroke-width="1.3"/><path d="M8 6v4M8 11.4v.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
};
const HUE = { 'claude-fleet': 250, 'ops-oncall': 145, 'webex-triage': 45, 'iac-review': 300, automations: 195 };
const wsDot = (n) => `<span class="src-dot" style="background:oklch(72% 0.14 ${HUE[n]})"></span>`;
const src = (kind, name, extra = '') =>
  kind === 'ws' ? `<span class="src">${wsDot(name)}${name}${extra}</span>`
  : kind === 'auto' ? `<span class="src src-auto">${I.auto}${name}${extra}</span>`
  : `<span class="src src-user">You${extra}</span>`;
const tags = (...t) => t.map((x) => `<span class="tag">${x}</span>`).join('');

// ---------- real chrome, lightly adapted ----------
const inboxVariants = {
  // A: compact chip in the workspace-chip language (dot + name + sub line)
  chip: (on, paused) => `<div class="ws-chip-group inbox-chip${on ? ' active' : ''}${paused ? ' paused' : ''}" style="--hue:var(--ink-1)"><button class="ws-chip" title="Inbox — 7 open, 1 urgent"><span class="dot inbox-dot urgent"></span>${paused ? `<span class="chip-bell-off">${I.bellOff}</span>` : ''}<span class="ws-chip-text"><span class="name">Inbox</span><span class="ws-chip-sub">${paused ? 'paused · until 15:30' : '7 open · 1 urgent'}</span></span></button><button class="ws-chip-menu-trigger" aria-label="Automations workspace actions" title="Automations workspace">⋮</button></div>`,
  // B: bare mono indicator, same shape as the Docker status
  text: (on) => `<button class="daemon-status inbox-text${on ? ' on' : ''}" title="Inbox — 7 open, 1 urgent"><span class="dot inbox-dot urgent"></span>Inbox<span class="inbox-n">7</span></button>`,
  // C: square settings-btn twin with a status dot, count in tooltip
  square: (on) => `<button class="settings-btn inbox-sq${on ? ' on' : ''}" title="Inbox — 7 open, 1 urgent" aria-label="Inbox, 7 open">${I.tray}<span class="dot inbox-dot urgent corner"></span></button>`,
  // D: settings-btn widened to carry the count
  wide: (on) => `<button class="settings-btn inbox-wide${on ? ' on' : ''}" title="Inbox — 7 open, 1 urgent" aria-label="Inbox, 7 open"><span class="dot inbox-dot urgent"></span>${I.tray}<span class="inbox-n">7</span></button>`,
};
let INBOX_VARIANT = 'chip';
const inboxBtn = (on, v = INBOX_VARIANT) => inboxVariants[v](on);
const tabs = (on, v) => (v === 'chip' || (!v && INBOX_VARIANT === 'chip'))
  ? (on ? c1.tabs.replace('ws-chip-group active ', 'ws-chip-group ') : c1.tabs).replace('<button class="btn add-workspace"', `${inboxBtn(on, 'chip')}<button class="btn add-workspace"`)
  : c1.tabs.replace('<div class="top-strip-actions">', `<div class="top-strip-actions">${inboxBtn(on, v)}`);

const sessionRows = [
  ['Inbox &amp; automations design', '2m', ['design'], '$4.12', true],
  ['Fix chip reorder dragover', '1d', ['bugfix'], '$2.40'],
  ['Release v0.13.17 notes', '2d', ['release'], '$0.38'],
  ['WSLENV bridge env fix', '3w', ['mcp', 'wsl'], '$6.91'],
].map(([t, ago, tg, usd, open]) => `<li class="session-row${open ? ' open' : ''}"><div class="session-row-main"><button class="session-row-title">${t}</button><div class="session-row-meta"><span class="session-row-time">${ago} ago</span><span class="session-row-tags">${tg.map((x) => `<button class="tag session-row-tag">${x}</button>`).join('')}</span><span class="session-row-cost">${usd}</span></div></div></li>`).join('');
const leftParts = c1.left.split('<section class="acc open">');
const collapsed = (name) => `<section class="acc"><button class="acc-header" aria-expanded="false"><span class="acc-chev" aria-hidden="true">▾</span><span>${name}</span></button></section>`;
leftParts[1] = leftParts[1].replace('All · 0', 'All · 12');
const left = leftParts[0] + '<section class="acc open">' +
  leftParts[1].replace('<div class="pane-body sessions-body"></div>', `<div class="pane-body sessions-body"><ul class="sessions-list"><li class="session-group-label" aria-hidden="true"><span class="session-group-dot"></span> Open · 1<span class="session-group-line"></span></li>${sessionRows.split('</li>')[0]}</li><li class="session-group-label recent" aria-hidden="true">Recent<span class="session-group-line"></span></li>${sessionRows.split('</li>').slice(1).join('</li>')}</ul></div>`) +
  collapsed('Library') + collapsed('Committee') + '</aside>';

function frame(main, overlay = '', opts = {}) {
  return `<div class="frame-wrap"><div class="frame-scale"><div class="app mock-app">${tabs(opts.inboxOn !== false)}<div class="app-body">${opts.left || left}<main class="main-pane" style="--hue:oklch(72% 0.14 250)"><div class="main-body">${main}</div></main>${opts.obs || c1.obs}</div>${c1.bottom}${overlay}</div></div></div>`;
}

// ---------- inbox shell ----------
const NOTIFY_CTL = `<button class="btn btn-sm ph-btn on ib-notify">${I.bell}Notifying<span class="dim">· Nights at 22:00</span> ▾</button>`;
const SESS = [['ask: failures this week', 'busy'], ['bulk retag log watchers', '']];
const ibTabs = (active, right = '') => `<div class="session-tab-strip ib-tabs" role="tablist">
  ${[['Todos', '7', ''], ['Automations', '4', ''], ['Activity', '1', 'wait']].map(([n, c, k]) => `<div role="tab" class="session-tab${n === active ? ' active' : ''}"><span class="session-tab-name">${n}</span><span class="ib-count ${k}">${c}</span></div>`).join('')}
  <span class="ib-tab-sep" aria-hidden="true"></span>
  ${SESS.map(([n, st]) => `<div role="tab" class="session-tab ib-sess${n === active ? ' active' : ''}"><span class="session-tab-dot live ${st}"></span><span class="session-tab-name">${n}</span><button class="session-tab-menu-trigger" aria-label="Actions for ${n}">⋮</button></div>`).join('')}
  <button class="session-tab-new ib-sess-new" title="New session in the automations workspace" aria-label="New session">+</button>
  <span class="ib-tabs-spacer"></span>${right}</div>`;

// ---------- todos ----------
const todos = [
  { p: 'urgent', title: 'prod-api 5xx rate above 2% for 15m', src: src('auto', 'log-watch'), tg: tags('ops', 'prod'), seen: 14, recurred: true, ago: '4m', link: 'ops-oncall', sel: true },
  { p: 'high', title: 'Reply to Maya: is the iac-review PR ready for Thursday?', src: src('auto', 'webex-triage'), tg: tags('webex'), ago: '22m' },
  { p: 'high', title: 'Terraform plan shows drift in sumer-dev VPC', src: src('ws', 'iac-review'), tg: tags('iac', 'drift'), ago: '1h', link: 'iac-review' },
  { p: 'normal', title: 'Flaky e2e: tests/vault.spec.ts timed out twice today', src: src('ws', 'claude-fleet'), tg: tags('ci', 'flaky'), seen: 2, ago: '3h', link: 'claude-fleet' },
  { p: 'normal', title: 'Bump runner pin after the 2.1.281 PTY check', src: src('user'), tg: tags('release'), ago: '2d' },
  { p: 'normal', title: 'Drink water', src: src('auto', 'reminders'), tg: tags('health'), ago: '3h', muted: 'off for this reminder · today', id: 'water' },
  { p: 'low', title: 'Clean up stale drafts on the releases page', src: src('ws', 'claude-fleet'), tg: tags('release'), ago: '5d' },
];
const groups = [['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
function todoRow(t, extra = '') {
  return `<li class="todo-row p-${t.p}${t.sel ? ' sel' : ''}${t.fresh ? ' fresh' : ''}">
    <button class="todo-check" aria-label="Mark done"></button>
    <div class="todo-main">
      <div class="todo-title">${t.title}</div>
      <div class="todo-meta">${t.src}<span class="todo-time">${t.ago} ago</span>${t.seen ? `<span class="todo-seen">seen ${t.seen}×</span>` : ''}${t.recurred ? '<span class="todo-flag">recurred</span>' : ''}${t.tg}</div>
      ${t.muted ? `<div class="todo-muted">${I.bellOff}<span>${t.muted}</span></div>` : ''}
    </div>
    <div class="todo-actions">
      <button class="todo-act${t.muted ? ' quiet' : ''}${t.bellOpen ? ' open' : ''}" title="Notifications for things like this">${t.muted ? I.bellOff : I.bell}</button>
      ${t.link ? `<button class="todo-act" title="Go to ${t.link}">${I.jump}</button>` : ''}
    </div>${extra}
  </li>`;
}
function todoList(list, popoverFor) {
  return `<ul class="todo-list">${groups.map(([k, label]) => {
    const rows = list.filter((t) => t.p === k);
    if (!rows.length) return '';
    return `<li class="session-group-label todo-group g-${k}">${label} · ${rows.length}<span class="session-group-line"></span></li>` +
      rows.map((t) => todoRow(t, popoverFor && popoverFor === t.id ? bellPopover() : '')).join('');
  }).join('')}</ul>`;
}
const todoToolbar = `<div class="ib-toolbar">
  <div class="obs-scope-toggle ib-scope" role="tablist"><button class="obs-scope-btn active">Open · 7</button><button class="obs-scope-btn">Done</button><button class="obs-scope-btn">Dismissed</button><button class="obs-scope-btn">All</button></div>
  <input type="search" class="sessions-search ib-search" placeholder="Search todos…" />
  <div class="ib-filters"><button class="tag-dd">Source ▾</button><button class="tag-dd">Tags ▾</button><button class="tag-dd">Workspace ▾</button><span class="nofm">7 of 31</span></div>
</div>`;

const todoDetail = `<aside class="ib-detail">
  <div class="ib-detail-head">
    <div class="ib-detail-chips"><span class="prio prio-urgent">urgent</span><span class="state-chip">open · recurred</span></div>
    <h3 class="ib-detail-title">prod-api 5xx rate above 2% for 15m</h3>
    <div class="ib-detail-actions"><button class="btn btn-sm primary">✓ Done</button><button class="btn btn-sm">Dismiss</button><button class="btn btn-sm ib-bell-btn">${I.bell} Notifications</button><span class="ib-spacer"></span><select class="ib-select" aria-label="Priority"><option>Urgent</option></select></div>
  </div>
  <dl class="ib-kv">
    <dt>Source</dt><dd>${src('auto', 'log-watch')} <span class="mono dim">run #212 · via</span> ${src('ws', 'ops-oncall')}</dd>
    <dt>Key</dt><dd><code>5xx:prod-api</code></dd>
    <dt>Seen</dt><dd><span class="mono">14×</span> <span class="dim">· first Oct 18 21:04 · last 4m ago</span></dd>
    <dt>Linked</dt><dd><a class="ib-link">${wsDot('ops-oncall')}ops-oncall › Check prod error budget ${I.jump}</a></dd>
    <dt>Tags</dt><dd class="ib-tags">${tags('ops', 'prod')}<button class="ib-addtag">+ tag</button></dd>
  </dl>
  <div class="ib-body">
    <p>5xx share on <code>prod-api</code> was <strong>2.4%</strong> over the last 15 minutes (threshold 2%). Most errors are upstream timeouts from <code>stats-svc</code>.</p>
    <pre class="ib-pre">21:46:03 ERR  upstream timeout stats-svc /v2/players  1.94s
21:46:03 ERR  upstream timeout stats-svc /v2/players  2.01s
21:46:05 WARN pool exhausted (64/64) conn=stats-svc
21:46:09 ERR  503 GET /api/game/4411/live</pre>
  </div>
  <div class="ib-hist-title">History</div>
  <ol class="ib-hist">
    <li><span class="h-dot"></span><span class="h-what">Seen again by log-watch <span class="mono dim">run #212</span>: 2.4%, p95 1.9s</span><span class="h-when">4m</span></li>
    <li><span class="h-dot reopen"></span><span class="h-what"><strong>Reopened.</strong> Key recurred after you marked it done</span><span class="h-when">19m</span></li>
    <li><span class="h-dot"></span><span class="h-what">You marked it done</span><span class="h-when">1h</span></li>
    <li><span class="h-dot"></span><span class="h-what">ops-oncall added tag <span class="tag">prod</span></span><span class="h-when">1h</span></li>
    <li><span class="h-dot"></span><span class="h-what">Created by log-watch <span class="mono dim">run #188</span></span><span class="h-when">Oct 18</span></li>
  </ol>
</aside>`;

const todosMain = (list, popoverFor, detail = todoDetail) => `<div class="inbox-view">${ibTabs('Todos', `<div class="ph-ctl">${NOTIFY_CTL}<button class="btn btn-sm ib-new">+ Add todo</button></div>`)}
  <div class="ib-split"><section class="ib-listcol">${todoToolbar}${todoList(list, popoverFor)}</section>${detail}</div></div>`;

function bellPopover() {
  return `<div class="ws-chip-menu bell-pop up" role="dialog" aria-label="Notification settings">
    <div class="bp-title">Future notifications for</div>
    <div class="obs-scope-toggle bp-scope" role="tablist"><button class="obs-scope-btn active">This reminder</button><button class="obs-scope-btn">${I.auto} reminders</button><button class="obs-scope-btn">#health</button></div>
    <div class="bp-levels" role="radiogroup">
      ${[['All', 'every post makes a notification'], ['High and up', ''], ['Urgent only', ''], ['Off', 'still lands in the inbox']].map(([l, h], i) => `<label class="bp-level${i === 3 ? ' on' : ''}"><span class="bp-radio"></span><span>${l}</span>${h ? `<span class="bp-hint">${h}</span>` : ''}</label>`).join('')}
    </div>
    <div class="bp-sub">Or snooze</div>
    <div class="bp-snooze"><button class="btn-mini">1 hour</button><button class="btn-mini on">Rest of today</button><button class="btn-mini">1 week</button><button class="btn-mini">Pick date…</button></div>
    <div class="bp-foot"><span class="dim">Now: <strong>All</strong>, from your default</span><a class="ib-link">All rules</a></div>
  </div>`;
}

// ---------- automations ----------
const autos = [
  { n: 'webex-triage', trig: 'every 30m · weekdays 8–18', next: 'in 12m', last: ['ok', 'succeeded', '18m ago'], tg: tags('webex', 'ops'), on: true, sel: true },
  { n: 'log-watch', trig: 'every 15m', next: 'in 3m', last: ['ok', 'succeeded', '4m ago'], tg: tags('ops', 'prod'), on: true },
  { n: 'reminders', trig: 'daily 09:00, 15:00', next: '15:00', last: ['idle', 'nothing to do', '5h ago'], tg: tags('health'), on: true },
  { n: 'nightly-cost-report', trig: 'daily 02:00', next: 'disabled', last: ['bad', 'failed', '2d ago'], tg: tags('cost'), on: false },
];
const autoList = `<ul class="auto-list">${autos.map((a) => `<li class="auto-row${a.sel ? ' sel' : ''}${a.on ? '' : ' off'}">
  <span class="switch${a.on ? ' on' : ''}" role="switch" aria-checked="${a.on}"></span>
  <div class="auto-main"><div class="auto-name">${I.auto}${a.n}</div>
  <div class="auto-meta"><span class="mono">${a.trig}</span><span class="dim">· next ${a.next}</span></div>
  <div class="auto-meta"><span class="run-chip ${a.last[0]}">${a.last[1]}</span><span class="dim">${a.last[2]}</span>${a.tg}</div></div>
</li>`).join('')}</ul>`;

const runRow = (id, when, trig, st, stLabel, dur, out, cost, expanded = '') => `<li class="run-row${expanded ? ' open' : ''}"><span class="run-id mono">#${id}</span><span class="mono">${when}</span><span class="dim">${trig}</span><span class="run-chip ${st}">${stLabel}</span><span class="mono dim">${dur}</span><span class="run-out">${out}</span><span class="mono">${cost}</span>${expanded}</li>`;
const runExpanded = `<div class="run-steps">
  <div class="run-step"><span class="step-k">${I.term} fetch</span><span class="mono">exit 0 · 0.8s</span><pre class="ib-pre sm">12 new messages in #ops-alerts since 13:30
{"state":{"lastSeen":"Y2lz…Zk1"}}</pre></div>
  <div class="run-step"><span class="step-k">${I.chat} triage</span><span class="mono">1m 11s</span><span>fresh session in ${src('ws', 'webex-triage')} · <a class="ib-link">Triage #ops-alerts ${I.jump}</a> · posted 3 todos (1 reopened)</span></div>
</div>`;

const autoDetail = `<aside class="ib-detail auto-detail">
  <div class="ib-detail-head">
    <div class="ib-detail-chips"><span class="state-chip ok">enabled</span><span class="mono dim">v7 · approved by you Oct 12</span></div>
    <h3 class="ib-detail-title">webex-triage</h3>
    <p class="ib-desc">Pull new #ops-alerts messages and turn real asks into todos.</p>
    <div class="ask-bar">${I.chat}<input placeholder="Ask Claude to change webex-triage…" aria-label="Ask Claude to change this automation" /><span class="ask-who">drafts in ${src('ws', 'webex-triage')}</span></div>
    <div class="ib-detail-actions"><button class="btn btn-sm primary">${I.play} Run now…</button><button class="btn btn-sm">Edit ▾</button><button class="btn btn-sm ib-bell-btn">${I.bell}</button><span class="ib-spacer"></span><span class="ib-tags">${tags('webex', 'ops')}<button class="ib-addtag">+ tag</button></span></div>
  </div>
  <div class="ib-statline"><span><b class="mono">41</b> runs this week</span><span><b class="mono">29</b> nothing to do</span><span><b class="mono">1</b> failed</span><span><b class="mono">$3.84</b> 7-day cost</span></div>
  <div class="ib-sec">Triggers</div>
  <ul class="ib-lines">
    <li>${I.clock}<span class="mono">*/30 8-18 * * 1-5</span><span class="dim">America/New_York · next 14:30</span></li>
    <li>${I.play}<span>Manual</span><span class="dim">you, and ${src('ws', 'webex-triage')}</span></li>
    <li>${I.bolt}<span>When a session goes idle in</span>${src('ws', 'ops-oncall')}<span class="dim">debounce 2m</span></li>
  </ul>
  <div class="ib-sec">Steps</div>
  <ol class="ib-steps">
    <li><span class="step-k">${I.term} fetch</span><span>script <code>fetch-webex.sh</code></span><span class="dim">timeout 2m</span><span class="secret">${I.key}WEBEX_TOKEN</span></li>
    <li><span class="step-k">${I.chat} triage</span><span>prompt ${src('ws', 'webex-triage')}</span><span class="dim">fresh session · waits</span></li>
  </ol>
  <div class="ib-sec">Parameters</div>
  <ul class="ib-lines params"><li><code>channel</code><span class="dim">string · required</span></li><li><code>since</code><span class="dim">string · default 1h</span></li></ul>
  <div class="ib-sec">Runs</div>
  <ul class="run-list">
    ${runRow(241, '14:00', 'schedule', 'ok', 'succeeded', '1m 12s', '3 todos', '$0.09', runExpanded)}
    ${runRow(240, '13:30', 'schedule', 'idle', 'nothing to do', '0.6s', 'exit 10', '$0.00')}
    ${runRow(239, '13:00', 'schedule', 'bad', 'failed', '0.9s', 'fetch: 401 Unauthorized', '$0.00')}
    ${runRow(238, '12:41', 'manual', 'warn', 'interrupted', '—', 'app quit mid-run', '$0.02')}
  </ul>
</aside>`;

const autoMain = `<div class="inbox-view">${ibTabs('Automations', `<div class="ph-ctl">${NOTIFY_CTL}<button class="btn btn-sm primary ib-new">${I.chat} New automation</button></div>`)}
  <div class="ib-split"><section class="ib-listcol"><div class="ib-toolbar">
    <div class="obs-scope-toggle ib-scope three" role="tablist"><button class="obs-scope-btn active">All · 4</button><button class="obs-scope-btn">Enabled · 3</button><button class="obs-scope-btn">Failing · 1</button></div>
    <input type="search" class="sessions-search ib-search" placeholder="Search automations…" />
    <div class="ib-filters"><button class="tag-dd">Tags ▾</button><button class="tag-dd">Prompts ▾</button></div></div>${autoList}</section>${autoDetail}</div></div>`;

const runModal = `<div class="modal-backdrop"><div class="modal run-modal">
  <h2>${I.play} Run webex-triage</h2>
  <p class="form-hint">Runs version 7 now with these parameters. Nothing else is running, so it starts right away.</p>
  <div class="run-form">
    <div class="form-row"><label for="rf-channel">channel <span class="req">required</span></label><input id="rf-channel" value="ops-alerts" /><p class="form-hint">WebEx room to scan</p></div>
    <div class="form-row"><label for="rf-since">since</label><input id="rf-since" value="1h" /><p class="form-hint">Default 1h</p></div>
    <div class="form-row"><label for="rf-level">level</label><select id="rf-level"><option>warn</option></select></div>
    <label class="committee-reachable-row"><input type="checkbox" id="rf-dry" /><span>dry_run</span></label>
  </div>
  <div class="modal-footer"><button class="btn">Cancel</button><button class="btn primary">${I.play} Run now</button></div>
</div></div>`;

// ---------- activity ----------
const proposal = `<article class="proposal">
  <div class="pr-eyebrow"><span class="pr-kind">Proposal · new automation</span><span class="dim">from</span>${src('ws', 'claude-fleet')}<span class="dim">· 6m ago</span></div>
  <h3 class="pr-title">${I.auto}nightly-ci-flakes</h3>
  <blockquote class="pr-why">I've hit three flaky e2e timeouts this week. A nightly scan of CI runs would catch them before you do.</blockquote>
  <div class="pr-flags"><span class="pr-flags-label">Needs your approval because it</span><span class="flag">adds a script</span><span class="flag">${I.key}uses GH_TOKEN</span><span class="flag">prompts ${src('ws', 'claude-fleet')} (fresh)</span></div>
  <div class="pr-grid">
    <div><div class="pr-k">Runs</div><div>daily 06:00 · about 30 runs a month</div></div>
    <div><div class="pr-k">Posts</div><div>todos tagged <span class="tag">ci</span> <span class="tag">flaky</span></div></div>
  </div>
  <pre class="ib-pre diff"><span class="add">+ triggers:  [{ schedule: { cron: "0 6 * * *" } }]</span>
<span class="add">+ secrets:   [GH_TOKEN]</span>
<span class="add">+ steps:</span>
<span class="add">+   - id: scan     script: ci-flakes.sh   timeout: 3m</span>
<span class="add">+   - id: explain  prompt: claude-fleet   mode: fresh</span></pre>
  <details class="pr-script" open><summary>ci-flakes.sh <span class="dim">· 14 lines</span></summary><pre class="ib-pre sm">gh run list --workflow e2e.yml --created ">=$(date -d yesterday +%F)" \\
  --json databaseId,conclusion,name --limit 50 |
jq -c '.[] | select(.conclusion=="failure")' > /tmp/fails.jsonl
[ -s /tmp/fails.jsonl ] || exit 10   # nothing to do</pre></details>
  <div class="pr-actions"><button class="btn primary">Approve</button><button class="btn">Edit, then approve</button><button class="btn ask-btn">${I.chat} Ask Claude about this</button><span class="ib-spacer"></span><button class="btn danger">Reject…</button></div>
</article>
<article class="proposal auto-ok">
  <div class="pr-eyebrow"><span class="pr-kind ok">Auto-approved · edit</span><span class="dim">from</span>${src('ws', 'ops-oncall')}<span class="dim">· trusted · 2h ago</span></div>
  <div class="pr-line">${I.auto}<strong>log-watch</strong> schedule <span class="mono">*/10</span> → <span class="mono">*/15</span>, added tag <span class="tag">prod</span><span class="ib-spacer"></span><button class="btn btn-sm">Revert</button></div>
</article>`;
const notifLog = [
  ['ok', '14:00', 'URGENT · prod-api 5xx rate above 2% for 15m', src('auto', 'log-watch'), 'delivered'],
  ['held', '15:00', 'Drink water', src('auto', 'reminders'), 'held by rule: this reminder → Off, today'],
  ['ok', '13:02', 'webex-triage failed: fetch exited 1', src('auto', 'webex-triage'), 'delivered · run failure'],
  ['held', '06:40', 'Terraform plan shows drift in sumer-dev VPC', src('ws', 'iac-review'), 'held: downtime · Nights (22:00–07:00)'],
  ['held', 'Sun', 'Drink water', src('auto', 'reminders'), 'held by rule: this reminder → Off, today'],
];
const activityMain = `<div class="inbox-view">${ibTabs('Activity', `<div class="ph-ctl">${NOTIFY_CTL}</div>`)}
  <div class="ib-single"><div class="ib-toolbar row">
    <div class="obs-scope-toggle ib-scope four" role="tablist"><button class="obs-scope-btn active">Everything</button><button class="obs-scope-btn">Needs approval · 1</button><button class="obs-scope-btn">Notifications</button><button class="obs-scope-btn">Held back · 3</button></div></div>
  <div class="ib-scroll">
    <div class="session-group-label">Needs approval<span class="session-group-line"></span></div>
    ${proposal}
    <div class="session-group-label">Notifications<span class="session-group-line"></span></div>
    <ul class="notif-log">${notifLog.map(([k, t, title, s, why]) => `<li class="nl-row ${k}"><span class="nl-glyph">${k === 'ok' ? I.bell : I.bellOff}</span><span class="mono dim">${t}</span><span class="nl-title">${title}</span>${s}<span class="nl-why">${why}</span></li>`).join('')}</ul>
  </div></div></div>`;

// ---------- toast ----------
const freshList = todos.map((t) => (t.sel ? { ...t, fresh: true } : t));
const osToast = `<div class="os-toast" role="img" aria-label="Windows notification">
  <div class="os-toast-head"><span class="brand-tile os-tile">cf</span><span>claude-fleet</span><span class="os-x">✕</span></div>
  <div class="os-toast-title">Urgent · prod-api 5xx rate above 2% for 15m</div>
  <div class="os-toast-body">log-watch · seen 14× · reopened</div>
</div><div class="os-label">Drawn by Windows when the app isn't focused</div>`;
const inAppToast = `<div class="toast ib-toast"><span class="toast-glyph" style="color:var(--danger)">!</span><span class="toast-body"><span class="toast-eyebrow">urgent · log-watch</span><span class="toast-text">prod-api 5xx rate above 2% for 15m</span></span><button class="toast-action">Open</button><button class="toast-dismiss" aria-label="Dismiss">✕</button></div>`;


// ---------- desktop presence ----------
const TILE = 'oklch(14% 0.006 80)', EDGE = 'oklch(27% 0.008 80)', HULL = 'url(#sg-hull)', INK1 = 'oklch(78% 0.008 80)', INK3 = 'oklch(45% 0.008 80)', CUT = 'oklch(14% 0.006 80)', GREEN = 'oklch(70% 0.16 145)';
const glow = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r * 2.6}" fill="url(#sg-glow)"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${GREEN}"/>`;
const INK = 'oklch(94% 0.005 80)';
// Ship drawn pointing right (+x) around (32,32); rotated into a climb.
const strip = (x, y, w) => `<rect x="${x}" y="${y - 2.2}" width="${w}" height="4.4" rx="2.2" fill="url(#sg-glow-h)"/><rect x="${x}" y="${y - 0.8}" width="${w}" height="1.6" rx="0.8" fill="${GREEN}"/>`;
const SAUCER_PATH = 'M59 32C59 24.5 47 20.5 36 21.5C28 22.2 23 26 23 32C23 38 28 41.8 36 42.5C47 43.5 59 39.5 59 32Z';
const intrepid = (small) => small ? `<g transform="rotate(-34 32 32)">
    <path d="M4.5 18.5H22M4.5 45.5H22" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
    <path d="M7 18.5H19.5M7 45.5H19.5" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <path d="${SAUCER_PATH}" fill="${TILE}" stroke="${INK}" stroke-width="3.4"/>
    <circle cx="44" cy="32" r="2.6" fill="${INK}"/>
  </g>` : `<g transform="rotate(-34 32 32)">
    <path d="M19 29.5L13.5 19.5M19 34.5L13.5 44.5" stroke="${INK1}" stroke-width="1.6" stroke-linecap="round"/>
    <rect x="2.5" y="16" width="23" height="4.6" rx="2.3" fill="none" stroke="${INK}" stroke-width="1.5"/>
    <rect x="2.5" y="43.4" width="23" height="4.6" rx="2.3" fill="none" stroke="${INK}" stroke-width="1.5"/>
    ${strip(6, 18.3, 15)}${strip(6, 45.7, 15)}
    <path d="M24.5 28L13 30.2Q10 32 13 33.8L24.5 36" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M13.5 32H22" stroke="${INK1}" stroke-width="1" stroke-dasharray="1.2 1.6" opacity=".8"/>
    <path d="${SAUCER_PATH}" fill="${TILE}" stroke="${INK}" stroke-width="1.6"/>
    <path d="M56 32C56 26.5 46.5 23.7 37 24.4C30.5 24.9 26.4 27.8 26.4 32C26.4 36.2 30.5 39.1 37 39.6C46.5 40.3 56 37.5 56 32Z" fill="none" stroke="${INK1}" stroke-width=".9" stroke-dasharray="1.1 1.9" opacity=".85"/>
    <ellipse cx="43" cy="32" rx="8.5" ry="4.6" fill="none" stroke="${INK1}" stroke-width=".9" opacity=".7"/>
    <ellipse cx="45" cy="32" rx="3" ry="1.8" fill="none" stroke="${INK}" stroke-width="1.1"/>
    <path d="M27 32H33.5" stroke="${INK1}" stroke-width=".9" opacity=".6"/>
    <circle cx="25.4" cy="32" r="1.6" fill="${GREEN}"/>
  </g>`;
const odyssey = (small) => small ? `<g transform="rotate(-34 32 32)">
    <path d="M18 29L13 20M18 35L13 44M17 32H12" stroke="${INK1}" stroke-width="2.4" stroke-linecap="round"/>
    <rect x="2" y="16" width="21" height="4.6" rx="2.3" fill="none" stroke="${INK}" stroke-width="2.4"/><rect x="2" y="43.4" width="21" height="4.6" rx="2.3" fill="none" stroke="${INK}" stroke-width="2.4"/><rect x="0" y="29.7" width="14" height="4.6" rx="2.3" fill="none" stroke="${INK}" stroke-width="2.4"/>
    <rect x="5" y="17.5" width="14" height="1.6" rx=".8" fill="${GREEN}"/><rect x="5" y="44.9" width="14" height="1.6" rx=".8" fill="${GREEN}"/>
    <path d="${SAUCER_PATH}" fill="${TILE}" stroke="${INK}" stroke-width="2.8"/>
  </g>` : `<g transform="rotate(-34 32 32)">
    <path d="M19 29.5L13.5 20M19 34.5L13.5 44M18 32H13" stroke="${INK1}" stroke-width="1.5" stroke-linecap="round"/>
    <rect x="1.5" y="16.3" width="22" height="4.2" rx="2.1" fill="none" stroke="${INK}" stroke-width="1.4"/>
    <rect x="1.5" y="43.5" width="22" height="4.2" rx="2.1" fill="none" stroke="${INK}" stroke-width="1.4"/>
    <rect x="-1" y="29.9" width="15" height="4.2" rx="2.1" fill="none" stroke="${INK}" stroke-width="1.4"/>
    ${strip(5, 18.4, 14)}${strip(5, 45.6, 14)}${strip(1.5, 32, 9)}
    <path d="${SAUCER_PATH}" fill="${TILE}" stroke="${INK}" stroke-width="1.6"/>
    <path d="M56 32C56 26.5 46.5 23.7 37 24.4C30.5 24.9 26.4 27.8 26.4 32C26.4 36.2 30.5 39.1 37 39.6C46.5 40.3 56 37.5 56 32Z" fill="none" stroke="${INK1}" stroke-width=".9" stroke-dasharray="1.1 1.9" opacity=".85"/>
    <ellipse cx="43" cy="32" rx="8.5" ry="4.6" fill="none" stroke="${INK1}" stroke-width=".9" opacity=".7"/>
    <ellipse cx="45" cy="32" rx="3" ry="1.8" fill="none" stroke="${INK}" stroke-width="1.1"/>
    <circle cx="25.4" cy="32" r="1.6" fill="${GREEN}"/>
  </g>`;
const banked = (small) => small ? `
    <path d="M27 33C25 40 20 44 10 46" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M4 41L26 47" stroke="${INK}" stroke-width="5" stroke-linecap="round"/><path d="M6.5 41.8L23 46.3" stroke="${TILE}" stroke-width="2.2" stroke-linecap="round"/><path d="M8 42.3L21 45.8" stroke="${GREEN}" stroke-width="1.6" stroke-linecap="round"/>
    <ellipse cx="37" cy="25" rx="23" ry="9" transform="rotate(-10 37 25)" fill="${TILE}" stroke="${INK}" stroke-width="3"/>` : `
    <path d="M7 35L22 39" stroke="${INK1}" stroke-width="3.6" stroke-linecap="round" opacity=".45"/>
    <path d="M28 32C26.5 39.5 21 43.5 11 45.5" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M31 33C30 40 26 44.5 19 47" fill="none" stroke="${INK1}" stroke-width="1" opacity=".7"/>
    <path d="M3.5 40.6L26.5 46.9" stroke="${INK}" stroke-width="4.6" stroke-linecap="round"/><path d="M4.6 40.9L25.4 46.6" stroke="${TILE}" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M7 41.7L22 45.8" stroke="url(#sg-glow-h)" stroke-width="4" stroke-linecap="round"/><path d="M7 41.7L22 45.8" stroke="${GREEN}" stroke-width="1.4" stroke-linecap="round"/>
    <g transform="rotate(-10 37 25)">
      <ellipse cx="37" cy="25" rx="23" ry="9" fill="${TILE}" stroke="${INK}" stroke-width="1.6"/>
      <ellipse cx="37" cy="25.3" rx="19.2" ry="7.1" fill="none" stroke="${INK1}" stroke-width=".9" stroke-dasharray="1.1 1.9" opacity=".85"/>
      <ellipse cx="38" cy="24.6" rx="11" ry="3.9" fill="none" stroke="${INK1}" stroke-width=".9" opacity=".7"/>
      <ellipse cx="39" cy="24.2" rx="3.6" ry="1.3" fill="none" stroke="${INK}" stroke-width="1.1"/>
      <path d="M14.3 26.5C20 33 54 33 59.7 26.5" fill="none" stroke="${INK1}" stroke-width=".9" opacity=".55"/>
    </g>
    <circle cx="29.5" cy="35.2" r="1.7" fill="${GREEN}"/>`;
const CONCEPTS = {
  intrepid: { name: 'Teardrop', draw: intrepid },
  odyssey: { name: 'Three nacelles', draw: odyssey },
  banked: { name: 'Banked', draw: banked },
};
const svgDefs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <radialGradient id="sg-glow"><stop offset="0" stop-color="${GREEN}" stop-opacity=".75"/><stop offset=".45" stop-color="${GREEN}" stop-opacity=".22"/><stop offset="1" stop-color="${GREEN}" stop-opacity="0"/></radialGradient>
  <linearGradient id="sg-glow-h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${GREEN}" stop-opacity="0"/><stop offset=".5" stop-color="${GREEN}" stop-opacity=".35"/><stop offset="1" stop-color="${GREEN}" stop-opacity="0"/></linearGradient>
  <linearGradient id="sg-hull" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="oklch(98% 0.004 80)"/><stop offset="1" stop-color="oklch(84% 0.008 80)"/></linearGradient>
</defs></svg>`;
let ICON = 'intrepid';
const appIcon = (size, dot = '', opts = {}) => {
  const c = CONCEPTS[opts.concept || ICON];
  const d = Math.round(size * 0.36);
  return `<span class="dk-icon" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><rect x=".5" y=".5" width="63" height="63" rx="14" fill="${TILE}" stroke="${EDGE}"/><g transform="translate(32 32) scale(${size <= 24 ? 0.84 : 0.76}) translate(-32 -31)">${c.draw(size <= 24)}</g></svg>
    ${dot ? `<span class="dk-overlay ${dot}" style="width:${d}px;height:${d}px">${opts.count ? `<b style="font-size:${Math.round(d * 0.62)}px">${opts.count}</b>` : ''}</span>` : ''}
  </span>`;
};
const conceptNotes = {
  intrepid: 'An elongated teardrop saucer flowing into a slim hull, two long nacelles swept far back on angled pylons. Texture comes from a dashed window row, a plating ring and the bridge. Green is the only fill: nacelle strips and the deflector. Chosen. At 24px and below it reduces to the saucer and two lit nacelles.',
  odyssey: 'The same hull with a third nacelle on the centerline, after the triple-nacelle ship. More distinctive as a silhouette, busier at small sizes.',
  banked: 'The 3/4 banked view from your last reference: a flat saucer in perspective with its window row, the hull curving down and back to a lit nacelle. The most cinematic, the least legible small.',
};
const conceptGallery = `<div class="ic-grid">${Object.entries(CONCEPTS).map(([k, c]) => `<div class="ic-card${k === 'intrepid' ? ' pick' : ''}">
  <div class="ic-head"><b>${c.name}</b>${k === 'intrepid' ? '<span class="state-chip ok">chosen</span>' : ''}</div>
  <div class="ic-sizes">${[96, 48, 32, 24, 16].map((n) => `<div>${appIcon(n, '', { concept: k })}<span class="mono dim">${n}</span></div>`).join('')}</div>
  <div class="ic-ctx"><div class="tb mini"><span class="tb-app focused">${appIcon(24, 'urgent', { concept: k })}<span class="tb-pip"></span></span></div><div class="tray mini"><span class="tray-ic">${appIcon(16, 'urgent', { concept: k })}</span></div><div class="ic-light">${appIcon(24, '', { concept: k })}${appIcon(16, '', { concept: k })}</div></div>
  <p>${conceptNotes[k]}</p>
</div>`).join('')}</div>`;
const ghost = (g) => `<span class="tb-app"><span class="tb-ghost">${g}</span></span>`;
const taskbar = (state, label, note, opts = {}) => `<figure class="dk-case">
  <div class="tb">
    <span class="tb-app"><span class="tb-start"><i></i><i></i><i></i><i></i></span></span>
    ${ghost('◫')}${ghost('▤')}
    <span class="tb-app ${opts.focused ? 'focused' : 'running'}${opts.flash ? ' flash' : ''}">${appIcon(24, state, opts)}<span class="tb-pip"></span></span>
    ${ghost('✉')}
  </div>
  <figcaption><b>${label}</b><span>${note}</span></figcaption>
</figure>`;
const trayCase = (state, label, note) => `<figure class="dk-case">
  <div class="tray"><span class="tray-chev">⌃</span><span class="tray-ic">${appIcon(16, state)}</span><span class="tray-sys">⌁ ◔ ♪</span><span class="tray-clock">14:02<br/>10/19/2026</span></div>
  <figcaption><b>${label}</b><span>${note}</span></figcaption>
</figure>`;
const dockCase = (badge, label, note) => `<figure class="dk-case">
  <div class="dock"><span class="dock-ghost"></span><span class="dock-ghost"></span><span class="dock-app">${appIcon(48)}${badge ? `<span class="dock-badge">${badge}</span>` : ''}<span class="dock-dot"></span></span><span class="dock-ghost"></span></div>
  <figcaption><b>${label}</b><span>${note}</span></figcaption>
</figure>`;
const trayMenu = `<div class="tray-menu" role="menu">
  <div class="tm-head">${appIcon(16, 'urgent')}<span><b>Admiral</b><span class="dim">7 open · 1 urgent · 1 to approve</span></span></div>
  <button role="menuitem">Open Inbox</button>
  <button role="menuitem">Open Admiral</button>
  <div class="tm-div"></div>
  <button role="menuitem">Pause notifications for 1 hour</button>
  <button role="menuitem">Pause until tomorrow</button>
  <div class="tm-div"></div>
  <button role="menuitem" class="dim">3 automations scheduled · next in 3m</button>
  <div class="tm-div"></div>
  <button role="menuitem">Quit Admiral</button>
</div>`;
const desktopHtml = `<div class="dk">
  <div class="dk-block">
    <div class="dk-title">App icon: Teardrop (chosen)</div>
    <p class="dk-p">The app has no icon of its own today, so every platform shows Electron's default. Round three, from your references: outlines only, no white fill. Hull texture comes from plating rings and dashed window rows. The app's live green is the only fill, in the nacelle strips. At 24px and below each concept switches to a simplified drawing with heavier strokes and no texture, because hairlines disappear at that size. Each is shown at real sizes, in a dark taskbar and tray with the urgent dot, and on a light taskbar. The bottom-right corner stays clear for that dot. The states below use the recommended concept.</p>
    ${conceptGallery}
  </div>
  <div class="dk-block">
    <div class="dk-title">Windows taskbar</div>
    <p class="dk-p">Windows puts a small overlay in the icon's bottom-right corner (Electron <code>setOverlayIcon</code>). It follows the inbox chip's dot rule, so the taskbar and the chip always agree.</p>
    <div class="dk-row">
      ${taskbar('', 'Nothing needs you', 'Open todos alone add no overlay. The taskbar stays calm.')}
      ${taskbar('wait', 'One thing needs you', 'A dot when there is exactly one: here, webex-triage is waiting for input.')}
      ${taskbar('wait', 'Several, none urgent', 'A count from two up. Violet: 2 waiting workspaces + 1 approval.', { count: '3' })}
      ${taskbar('urgent', 'Several, one urgent', 'Red when anything urgent is in the count. A new urgent item also flashes the button.', { count: '4', flash: true })}
    </div>
    <div class="needs">
      <div class="needs-k">Counts as "needs you"</div>
      <span><span class="dot inbox-dot urgent"></span>urgent todos</span>
      <span><span class="dot inbox-dot wait"></span>proposals to approve</span>
      <span><span class="dot inbox-dot wait"></span>workspaces waiting for input</span>
      <span class="dim">Ordinary open todos never count.</span>
    </div>
    <div class="dk-split2">
      <div class="os-toast static" role="img" aria-label="Windows notification for a workspace waiting on input">
        <div class="os-toast-head">${appIcon(18)}<span>Admiral</span><span class="os-x">✕</span></div>
        <div class="os-toast-title">webex-triage needs your input</div>
        <div class="os-toast-body">Asked: "Post the 3 todos to #ops-alerts too?"</div>
      </div>
      <div class="dk-p">
        <b>Waiting-for-input notifications</b> reuse the signal that already turns a chip violet (the runner's <code>signal_input_wait</code> hook). The host makes the notification, so the workspace doesn't post anything. It fires only after about 20 seconds of waiting, and only when you aren't already looking at that workspace. It clears itself once the session moves on. Clicking opens that workspace's session tab, and the 🔔 rule for that workspace applies.
      </div>
    </div>
  </div>
  <div class="dk-block dk-split">
    <div>
      <div class="dk-title">System tray</div>
      <p class="dk-p">New with this feature: the tray icon is what keeps automations running after you close the window. It carries the same dot.</p>
      <div class="dk-row">${trayCase('', 'Quiet', 'Hover shows "Admiral: 7 open".')}${trayCase('urgent', 'Something needs you', 'Always a dot here; a number is unreadable at 16px. Hover shows "4 need you · 1 urgent".')}</div>
    </div>
    <div>
      <div class="dk-title">Tray menu (right-click)</div>
      ${trayMenu}
    </div>
  </div>
  <div class="dk-block">
    <div class="dk-title">macOS dock</div>
    <p class="dk-p">The Mac dock badge is always a red count. It uses the same "needs you" count as the taskbar (urgent todos, approvals, workspaces waiting for input), never all open todos, so a number always means something. Linux support for badges varies by desktop, so the tray dot is the reliable signal there.</p>
    <div class="dk-row">${dockCase('', 'Nothing pressing', 'No badge.')}${dockCase('4', 'Needs you', '1 urgent, 1 approval, 2 waiting workspaces. A new urgent also bounces the icon once.')}</div>
  </div>
</div>`;


// ---------- global snooze & downtime ----------
const chipStrip = (paused) => `<div class="strip-crop"><div class="strip-inner">${(() => { const t = c1.tabs.replace('<button class="btn add-workspace"', `${inboxVariants.chip(false, paused)}<button class="btn add-workspace"`); const parts = t.split('<div class="ws-chip-group'); return [parts[0], parts[1], ...parts.slice(4)].join('<div class="ws-chip-group'); })()}</div></div>`;
const pauseMenu = `<div class="ws-chip-menu pause-menu" role="menu">
  <button role="menuitem">${I.tray}Open Inbox</button>
  <div class="ws-chip-menu-divider"></div>
  <div class="pm-label">Pause notifications</div>
  <button role="menuitem">${I.bellOff}For 30 minutes</button>
  <button role="menuitem">${I.bellOff}For 1 hour</button>
  <button role="menuitem">${I.bellOff}Until 17:00 <span class="pm-hint">end of workday</span></button>
  <button role="menuitem">${I.bellOff}Until tomorrow 08:00</button>
  <button role="menuitem">${I.bellOff}Until I turn it back on</button>
  <div class="ws-chip-menu-divider"></div>
  <label class="pm-check"><input type="checkbox" checked /> Let urgent through</label>
  <div class="ws-chip-menu-divider"></div>
  <button role="menuitem">${I.clock}Downtime schedules…</button>
</div>`;
const notifyMenu = (paused) => `<div class="ws-chip-menu pause-menu hdr" role="menu">
  <div class="pm-state">${paused ? `${I.bellOff}<span><b>Paused</b><span class="dim">until 15:30 · 3 held, none urgent</span></span>` : `${I.bell}<span><b>Notifying</b><span class="dim">next downtime: Nights, 22:00–07:00</span></span>`}</div>
  <div class="ws-chip-menu-divider"></div>
  ${paused ? `<button role="menuitem">${I.bell}Resume now</button>
  <button role="menuitem">${I.clock}Extend by 30 minutes</button>
  <button role="menuitem">${I.clock}Extend until 17:00 <span class="pm-hint">end of workday</span></button>
  <button role="menuitem">${I.clock}Change end time…</button>` : `<div class="pm-label">Pause notifications</div>
  <button role="menuitem">${I.bellOff}For 30 minutes</button>
  <button role="menuitem">${I.bellOff}For 1 hour</button>
  <button role="menuitem">${I.bellOff}Until 17:00 <span class="pm-hint">end of workday</span></button>
  <button role="menuitem">${I.bellOff}Until tomorrow 08:00</button>
  <button role="menuitem">${I.bellOff}Until I turn it back on</button>`}
  <div class="ws-chip-menu-divider"></div>
  <label class="pm-check"><input type="checkbox" ${paused ? '' : 'checked '}/> Let urgent through</label>
  <div class="ws-chip-menu-divider"></div>
  <button role="menuitem">${I.clock}Downtime schedules…</button>
</div>`;
const pauseHeader = (paused) => `<div class="ph-wrap">${ibTabs('Todos', `<div class="ph-ctl"><button class="btn btn-sm ph-btn ${paused ? 'paused' : 'on'} open">${paused ? I.bellOff : I.bell}${paused ? 'Paused<span class="dim">· until 15:30</span>' : 'Notifying<span class="dim">· Nights at 22:00</span>'} ▾</button><button class="btn btn-sm ib-new">+ Add todo</button></div>`)}${notifyMenu(paused)}</div>`;
const pausedBanner = `<div class="paused-scene">${ibTabs('Todos', `<div class="ph-ctl"><button class="btn btn-sm ph-btn paused">${I.bellOff}Paused<span class="dim">· until 15:30</span> ▾</button><button class="btn btn-sm ib-new">+ Add todo</button></div>`)}
  <div class="restart-banner pause-banner" role="status">${I.bellOff}<span class="restart-banner-text"><strong>Notifications paused until 15:30.</strong> 3 held so far, none urgent. Urgent ones still come through.</span><button class="btn btn-sm">+30 min</button><button class="btn primary restart-banner-btn">Resume now</button></div></div>`;
const digestToast = `<div class="toast ib-toast"><span class="toast-glyph" style="color:var(--wait)">${I.bell}</span><span class="toast-body"><span class="toast-eyebrow">notifications resumed</span><span class="toast-text">6 held while paused: 1 needs input, 5 todos</span></span><button class="toast-action">Review</button><button class="toast-dismiss" aria-label="Dismiss">✕</button></div>`;
const digestOs = `<div class="os-toast static"><div class="os-toast-head">${appIcon(18)}<span>Admiral</span><span class="os-x">✕</span></div><div class="os-toast-title">Downtime over: 6 held overnight</div><div class="os-toast-body">1 needs input · 5 todos (none urgent). Click to review in Activity.</div></div>`;
const pauseHtml = `<div class="dk">
  <div class="dk-block">
    <div class="dk-title">Where to pause everything</div>
    <p class="dk-p">Two entry points that set the same global pause: the header control (with the menu from the earlier chip option) while you're in the inbox, and the tray when the window is closed. If a pause and a downtime disagree about urgent items, the most recent explicit action wins: a pause that holds urgent overrides a downtime that lets it through.</p>
    <div class="opt-grid">
      <div class="opt wide"><div class="opt-k">Inbox header control, with the menu <span class="state-chip ok">chosen</span></div><p class="dk-p">The header button always shows the current state. Clicking it opens a menu: quick durations with hints, the urgent bypass, and the schedules. While paused, the same menu switches to resume and extend.</p><div class="ph-pair"><div><span class="vs-label">notifying</span>${pauseHeader(false)}</div><div><span class="vs-label">paused</span>${pauseHeader(true)}</div></div></div>
      <div class="opt"><div class="opt-k">Tray menu <span class="state-chip ok">chosen</span></div><p class="dk-p">Already in the tray mock: works with the window closed, which is when automations run unattended.</p>${trayMenu}</div>
    </div>
  </div>
  <div class="dk-block">
    <div class="dk-title">While paused</div>
    <p class="dk-p">The Inbox chip swaps its sub-line for the pause and shows a bell-off glyph, and the header control turns amber. The inbox shows a banner with what has been held. The taskbar dot and count keep telling the truth. Only toasts, flashes and bounces stop.</p>
    <div class="opt-grid two">${chipStrip(true)}${pausedBanner}</div>
  </div>
  <div class="dk-block">
    <div class="dk-title">When a pause or downtime ends</div>
    <p class="dk-p">Held notifications are not replayed one by one. You get a single summary instead, and the held items stay marked "held" in Activity. Anything still relevant, like a workspace still waiting for input, stays in the count.</p>
    <div class="opt-grid two">${digestOs}<div class="toast-demo"><span class="dim">In-app, if the window is focused:</span>${digestToast}</div></div>
  </div>
</div>`;


// ---------- authoring ----------
const composer = `<div class="modal-backdrop"><div class="modal composer">
  <h2>${I.chat} New automation</h2>
  <p class="form-hint">Describe what it should do, when, and where results go. A workspace drafts it and sends it back for your review. Nothing runs until you approve.</p>
  <div class="cmp-box"><textarea id="cmp-text" aria-label="Describe the automation">Every 30 minutes on weekdays during work hours, check the #ops-alerts WebEx room for new messages. Make a todo for anything that's an actual ask of me, tagged webex. Notify me only if someone mentions an outage.</textarea></div>
  <div class="cmp-ideas"><span class="dim">Try:</span><button class="btn-mini">Watch prod logs for 5xx spikes</button><button class="btn-mini">Remind me to drink water twice a day</button><button class="btn-mini">Nightly CI flake report</button></div>
  <div class="cmp-row">
    <div class="form-row"><label for="cmp-ws">Drafted by</label><select id="cmp-ws"><option>webex-triage</option></select><p class="form-hint">Runs a fresh session there, with its tools and secrets. Your open session isn't touched.</p></div>
    <div class="form-row"><label for="cmp-sec">Secrets it may request</label><div class="cmp-secrets"><span class="secret">${I.key}WEBEX_TOKEN</span><span class="dim">from webex-triage's vault</span></div></div>
  </div>
  <div class="modal-footer"><button class="btn cmp-blank">Start from a blank form</button><span class="ib-spacer"></span><button class="btn">Cancel</button><button class="btn primary">${I.chat} Draft it</button></div>
</div></div>`;
const formView = `<div class="af">
  <div class="af-sec">Basics</div>
  <div class="af-grid"><div class="form-row"><label>Name</label><input value="webex-triage" /></div><div class="form-row"><label>Tags</label><div class="af-tags">${tags('webex', 'ops')}<button class="ib-addtag">+ tag</button></div></div></div>
  <div class="af-sec">When</div>
  <div class="af-line">${I.clock}<span>Every</span><span class="af-pill">30 min</span><span>on</span><span class="af-pill">weekdays</span><span>from</span><span class="af-pill">08:00</span><span>to</span><span class="af-pill">18:00</span><span class="dim mono">= */30 8-18 * * 1-5</span></div>
  <div class="af-line">${I.play}<span>Also runnable by hand</span></div>
  <div class="af-sec">Steps</div>
  <div class="af-step"><span class="step-k">${I.term} 1 · fetch</span><span>script</span><code>fetch-webex.sh</code><span class="secret">${I.key}WEBEX_TOKEN</span><a class="ib-link">view script</a></div>
  <div class="af-step"><span class="step-k">${I.chat} 2 · triage</span><span>prompt</span>${src('ws', 'webex-triage')}<span class="af-pill">fresh</span><a class="ib-link">view prompt</a></div>
</div>`;
const yamlView = `<pre class="ib-pre yaml">name: webex-triage
tags: [webex, ops]
triggers:
  - schedule: { cron: "*/30 8-18 * * 1-5", tz: America/New_York }
  - manual: {}
secrets: [WEBEX_TOKEN]
params:
  - { name: channel, type: string, default: ops-alerts }
steps:
  - id: fetch
    script: { run: fetch-webex.sh, timeout: 2m }
  - id: triage
    prompt:
      workspace: webex-triage
      mode: fresh
      message: |
        New messages since last check:
        {{steps.fetch.stdout}}
        Post a todo for each real ask of Troy (tag: webex,
        key per thread). notify=true only for outages.</pre>`;
const reviewCard = (view) => `<article class="proposal draft">
  <div class="pr-eyebrow"><span class="pr-kind">Draft · new automation</span><span class="dim">you asked</span>${src('ws', 'webex-triage')}<span class="dim">· drafted in 48s</span></div>
  <h3 class="pr-title">${I.auto}webex-triage</h3>
  <div class="pr-flags"><span class="pr-flags-label">Needs your approval because it</span><span class="flag">adds a script</span><span class="flag">${I.key}uses WEBEX_TOKEN</span></div>
  <div class="seg"><button class="${view === 'form' ? 'on' : ''}">Form</button><button class="${view === 'yaml' ? 'on' : ''}">YAML</button></div>
  ${view === 'form' ? formView : yamlView}
  <div class="ask-bar">${I.chat}<input placeholder="Ask for changes, e.g. &quot;skip messages from bots&quot;" aria-label="Ask for changes to this draft" /></div>
  <div class="pr-actions"><button class="btn primary">Approve</button><button class="btn">${I.play} Test run</button><button class="btn ask-btn">${I.chat} Ask Claude about this</button><span class="ib-spacer"></span><button class="btn danger">Discard</button></div>
</article>`;
const authoringHtml = `<div class="dk">
  <div class="dk-block"><div class="dk-title">The draft comes back for review</div>
    <p class="dk-p">The same card as a workspace's proposal, plus a Form / YAML switch and an "Ask for changes" box. Iterate in plain language until it's right. <b>Test run</b> runs the draft once against the real tools, without a schedule, and shows the step output and any todos it would post (posted to a scratch view, not your inbox). Approve turns it on.</p>
    <div class="opt-grid two top"><div><span class="vs-label">form view</span>${reviewCard('form')}</div><div><span class="vs-label">yaml view</span>${reviewCard('yaml')}</div></div>
  </div>
</div>`;


// ---------- automations in loadouts ----------
const folderSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const loRow = (name, trig, extra, opts = {}) => `<div class="mf exec lo-auto${opts.state ? ' ' + opts.state : ''}"><label class="lo-check"><input type="checkbox" ${opts.off ? '' : 'checked'} ${opts.disabled ? 'disabled' : ''}/></label><div class="lo-main"><div class="lo-name">${I.auto}<span class="path">${name}</span>${opts.badge || ''}</div><div class="lo-meta"><span class="mono">${trig}</span>${extra}</div></div>${opts.right || '<span class="badge-run">runs</span>'}</div>`;
const loReview = (mode) => `<div class="modal loadout-review lo-review">
  <div class="lr-head"><span class="eyebrow">Loadout · ${mode !== 'install' ? 'update' : 'review'}</span><button class="btn btn-sm lr-open-folder">${folderSvg}Open folder</button></div>
  <div class="lr-title-row"><h2>webex-ops<span class="lr-ver">${mode !== 'install' ? 'v1.2.0 → v1.3.0' : 'v1.2.0'}</span></h2><div class="tags"><span class="tag">webex</span><span class="tag">ops</span></div></div>
  <p class="lr-desc">Triage for the ops WebEx rooms: a skill for reading threads, plus automations that turn real asks into todos.</p>
  <div class="lr-meta"><span class="k">installs into</span> webex-triage<span class="k"> · </span>3 files<span class="k"> · </span>2 automations</div>
  ${mode !== 'install' ? '' : `<span class="lbl">Files written</span><div class="manifest"><div class="mf"><span class="path">skills/webex-thread-reader/SKILL.md</span><span class="badge-new">new</span></div><div class="mf"><span class="path">CLAUDE.md</span><span class="badge-new">+ block</span></div></div>`}
  <span class="lbl">Automations · ${mode !== 'install' ? 'changes in this version' : 'turn on with this install'}</span>
  <div class="manifest">
  ${mode !== 'install'
    ? loRow('webex-triage', '*/30 8-18 * * 1-5', `<span class="lo-diff">prompt wording · <span class="add">+ skip bot messages</span></span>`, { badge: '<span class="lo-badge mod">you edited this</span>', state: 'conflict', right: `<div class="lo-choice"><button class="btn-mini on">Keep mine</button><button class="btn-mini">Take update</button><button class="btn-mini">Diff</button></div>` }) +
      loRow('webex-digest', 'daily 17:30', `<span class="lo-diff"><span class="add">new in v1.3.0</span> · posts one end-of-day summary todo</span>`, { badge: '<span class="lo-badge new">new</span>', off: true, right: '<span class="lo-hint">tick to turn on</span>' })
    : loRow('webex-triage', '*/30 8-18 * * 1-5', `<span>prompts ${src('ws', 'webex-triage')} <span class="dim">(this workspace)</span></span><span class="secret">${I.key}WEBEX_TOKEN</span>`, { badge: '<span class="lo-badge">script</span>' }) +
      loRow('webex-mentions', 'on new message', `<span class="secret miss">${I.key}WEBEX_BOT_TOKEN · missing</span>`, { off: true, disabled: true, state: 'blocked', right: '<span class="lo-hint">add the secret to turn on</span>' })}
  </div>
  <p class="lr-hint">${mode !== 'install'
    ? 'Your edit to webex-triage is kept unless you take the update. New automations arrive off until you tick them. Script changes always show here first.'
    : 'Ticked automations turn on when you install, and this review counts as your approval. They run in webex-triage with its vault secrets. Untick any to install it off.'}</p>
  <div class="lr-foot"><button class="btn ask-btn${mode === 'discuss' ? ' on' : ''}">${I.chat} Ask Claude about this</button><span class="ib-spacer"></span><button class="btn">Cancel</button><button class="btn primary">${mode !== 'install' ? 'Update to v1.3.0' : 'Install into webex-triage'}</button></div>
</div>`;

const discussPanel = `<aside class="disc">
  <div class="disc-head"><span class="eyebrow">${I.chat} Reviewing with Claude</span><span class="disc-where">fresh session in ${src('ws', 'automations')}</span><a class="ib-link">Open as session ${I.jump}</a></div>
  <div class="disc-body">
    <div class="disc-ctx"><span class="dim">Shared with Claude as data to review:</span><span class="tag">your v1.2.0 + edits</span><span class="tag">incoming v1.3.0</span><span class="tag">2 diffs</span><span class="tag">fetch-webex.sh</span><span class="tag">secrets + targets</span></div>
    <div class="msg claude">
      <p><b>What changes.</b> webex-triage's prompt gains "skip bot messages." webex-digest is new: once a day at 17:30 it posts a single summary todo. No script changes.</p>
      <p><b>Your edits.</b> You changed the triage prompt to tag todos <span class="tag">ops</span> too. The update rewrites the same paragraph, so taking it would drop your tag line. Keeping yours means no bot filtering.</p>
      <p><b>Security.</b> Low risk. No new secrets or network hosts, and fetch-webex.sh is unchanged. webex-digest uses the existing WEBEX_TOKEN with read-only calls. One note: message text flows into the prompt, so a crafted WebEx message could try to steer the triage session. The new version wraps messages as quoted data, which helps.</p>
      <p><b>Noise.</b> webex-digest adds 1 prompt run and 1 todo a day.</p>
      <p><b>Suggestion.</b> Merge: take the update's bot filter and keep your tag line. I can send that as a proposal for you to approve.</p>
      <div class="msg-actions"><button class="btn btn-sm primary">Send merged version as a proposal</button></div>
    </div>
    <div class="msg you"><p>Would webex-digest ever notify me?</p></div>
    <div class="msg claude"><p>Not as written. It posts with priority <code>low</code> and no notify flag, so your default rule (High and up) keeps it silent.</p></div>
  </div>
  <div class="ask-bar disc-in">${I.chat}<input placeholder="Ask about these changes…" aria-label="Ask Claude about these changes" /></div>
  <p class="disc-foot">Advice only. Claude can suggest a version, but only you can take the update or approve.</p>
</aside>`;
const discussModal = `<div class="modal-backdrop"><div class="disc-wrap">${loReview('discuss')}${discussPanel}</div></div>`;
const loModal = `<div class="modal-backdrop">${loReview('install')}</div>`;
const loLayout = `<pre class="ib-pre yaml">loadouts/webex-ops/
  loadout.md                     <span class="dim"># title, version: 1.2.0, tags …</span>
  CLAUDE.md
  skills/webex-thread-reader/SKILL.md
  <span class="add">automations/</span>
    <span class="add">webex-triage/automation.yaml</span>   <span class="dim"># same format as the YAML view</span>
    <span class="add">webex-triage/fetch-webex.sh</span>
    <span class="add">webex-mentions/automation.yaml</span></pre>`;
const originLine = `<div class="origin">${I.auto}<b>webex-triage</b><span class="dim">from loadout</span><span class="tag">webex-ops v1.2.0</span><span class="dim">in</span>${src('ws', 'webex-triage')}<span class="lo-badge mod">edited</span><span class="ib-spacer"></span><button class="btn btn-sm update">Update ↑ v1.3.0</button></div>
<div class="ws-chip-menu edit-menu" role="menu"><button role="menuitem">Edit in form</button><button role="menuitem">Edit as YAML</button><div class="ws-chip-menu-divider"></div><button role="menuitem">${folderSvg}Save as loadout…</button><button role="menuitem">Add to loadout <span class="pm-hint">webex-ops</span></button></div>`;
const loHtml = `<div class="dk">
  <div class="dk-block dk-split"><div><div class="dk-title">Packaged like any other loadout</div>
    <p class="dk-p">An <code>automations/</code> folder joins <code>skills/</code>, <code>commands/</code> and the other convention folders. Each automation is the same YAML you see in the editor, plus its scripts. It publishes to GHCR with the existing <code>make publish</code> and syncs through the same sources. A prompt step written as <code>workspace: $self</code> binds to whichever workspace the loadout is installed into.</p></div>
    ${loLayout}</div>
  <div class="dk-block"><div class="dk-title">Updates arrive through the existing Update ↑</div>
    <p class="dk-p">A new loadout version shows its automation changes in the review. Same rule as loadout files: anything you edited locally is kept and flagged, never overwritten silently. You choose per automation.</p>
    <div class="lo-solo">${loReview('update')}</div></div>
  <div class="dk-block"><div class="dk-title">Provenance and export</div>
    <p class="dk-p">An installed automation shows where it came from, whether you've edited it, and whether an update is waiting. Edit ▾ can also go the other way: save an automation you built (or Claude drafted) as a new loadout, or add it to an existing one, ready to publish.</p>
    <div class="lo-prov">${originLine}</div></div>
</div>`;


// ---------- automations workspace sessions ----------
const termText = `<span class="t-dim">╭─────────────────────────────────────────────────────────────╮
│</span> <span class="t-ok">✻</span> Welcome to Claude Code   <span class="t-dim">/workspace (automations)                │
╰─────────────────────────────────────────────────────────────╯</span>

<span class="t-you">&gt; which automations failed this week, and why?</span>

<span class="t-ok">⏺</span> <span class="t-tool">fleet-state:list_runs</span>(status: "failed", since: "7d")
  <span class="t-dim">⎿  3 runs across 2 automations</span>

<span class="t-ok">⏺</span> Two automations failed this week:

  <b>webex-triage</b>  1 failure, Oct 19 13:00
    fetch exited 1: <span class="t-err">401 Unauthorized</span>. The WEBEX_TOKEN in webex-triage's
    vault expired. Runs since 13:30 succeed, so it was rotated.

  <b>nightly-cost-report</b>  2 failures, Oct 17 and 18, both 02:00
    The prompt step timed out at 10m waiting on iac-review, which was
    paused overnight. Options: set <span class="t-code">ensureRunning: true</span>, or move it
    to 07:00 after the Nights downtime.

  Want me to propose the ensureRunning fix for nightly-cost-report?

<span class="t-you">&gt; yes, and also tag every log watcher "ops" and set them to every 15 min</span>

<span class="t-ok">⏺</span> <span class="t-tool">fleet-state:propose_automation_change</span>(batch: 4 changes)
  <span class="t-dim">⎿  proposal #p-118 sent to Activity · 3 low-risk (auto-applied, trusted)
     · 1 needs you: nightly-cost-report adds ensureRunning</span>

<span class="t-prompt">&gt; </span><span class="t-cursor"> </span>`;
const autoRows = [['ask: failures this week', 'now', ['ops'], '$0.31', true], ['bulk retag log watchers', '4m', ['ops'], '$0.12', true], ['draft: webex-triage', '1d', ['draft'], '$0.44'], ['review: webex-ops v1.3.0', '2d', ['review'], '$0.09']].map(([t, ago, tg, usd, open]) => `<li class="session-row${open ? ' open' : ''}"><div class="session-row-main"><button class="session-row-title">${t}</button><div class="session-row-meta"><span class="session-row-time">${ago === 'now' ? 'now' : ago + ' ago'}</span><span class="session-row-tags">${tg.map((x) => `<button class="tag session-row-tag">${x}</button>`).join('')}</span><span class="session-row-cost">${usd}</span></div></div></li>`);
const autoLeft = leftParts[0] + '<section class="acc open">' + leftParts[1].replace('<div class="pane-body sessions-body"></div>', `<div class="pane-body sessions-body"><ul class="sessions-list"><li class="session-group-label" aria-hidden="true"><span class="session-group-dot"></span> Open · 2<span class="session-group-line"></span></li>${autoRows.slice(0, 2).join('')}<li class="session-group-label recent" aria-hidden="true">Recent<span class="session-group-line"></span></li>${autoRows.slice(2).join('')}</ul></div>`) + collapsed('Library') + collapsed('Committee') + '</aside>';
const autoObs = c1.obs.replace('Inbox &amp; automations design', 'ask: failures this week').replace('$4.12', '$0.31').replace('claude-opus-5-5</span>', 'claude-opus-5-5</span>').replace('title="claude-fleet">This workspace', 'title="Inbox (automations)">This workspace');
const sessMain = `<div class="inbox-view">${ibTabs('ask: failures this week', `<div class="ph-ctl">${NOTIFY_CTL}</div>`)}
  <div class="terminal-accent-band-row" aria-hidden="true"><div class="terminal-accent-band" style="--pct:100%"><div class="terminal-accent-band-fill"></div></div></div>
  <div class="ib-term"><pre>${termText}</pre></div></div>`;
const batchCard = `<article class="proposal batch">
  <div class="pr-eyebrow"><span class="pr-kind">Proposal · 4 changes</span><span class="dim">from</span><span class="src">${I.tray}automations session</span><span class="dim">· "bulk retag log watchers" · 1m ago</span></div>
  <h3 class="pr-title">Tag log watchers ops, run every 15 min, and fix nightly-cost-report</h3>
  <ul class="batch-list">
    <li class="auto-ok">${I.auto}<b>log-watch</b><span>schedule <span class="mono">*/10</span> → <span class="mono">*/15</span> · + <span class="tag">ops</span></span><span class="b-state ok">auto-applied</span><button class="btn-mini">Revert</button></li>
    <li class="auto-ok">${I.auto}<b>api-latency-watch</b><span>+ <span class="tag">ops</span></span><span class="b-state ok">auto-applied</span><button class="btn-mini">Revert</button></li>
    <li class="auto-ok">${I.auto}<b>queue-depth-watch</b><span>schedule <span class="mono">*/30</span> → <span class="mono">*/15</span> · + <span class="tag">ops</span></span><span class="b-state ok">auto-applied</span><button class="btn-mini">Revert</button></li>
    <li class="needs">${I.auto}<b>nightly-cost-report</b><span>prompt step: <span class="mono">ensureRunning: true</span> (may start iac-review at 02:00)</span><span class="b-state wait">needs you</span><span class="b-pick"><button class="btn-mini on">Accept</button><button class="btn-mini">Decline</button></span></li>
  </ul>
  <div class="pr-actions"><button class="btn primary">Apply accepted</button><button class="btn ask-btn">${I.chat} Ask Claude about this</button><span class="ib-spacer"></span><button class="btn danger">Decline all</button></div>
</article>`;
const chipMenu = `<div class="ws-chip-menu edit-menu" role="menu"><div class="pm-label">Automations workspace</div><button role="menuitem">${I.chat}New session</button><button role="menuitem">Edit workspace (env, secrets, image)…</button><button role="menuitem">Restart</button><button role="menuitem">Recreate with latest image</button></div>`;
const sessHtml = `<div class="dk">
  <div class="dk-block dk-split"><div><div class="dk-title">Bulk changes come back as one card</div>
    <p class="dk-p">A session in the automations workspace can read every automation, run and result, and propose changes to any of them, as one batch. Its trusted status auto-applies the low-risk items (each with Revert). Anything touching scripts, secrets, targets or start-up behavior waits for your accept, item by item.</p>${batchCard}</div>
    <div><div class="dk-title">Inbox chip ⋮</div><p class="dk-p">Managing the workspace behind the inbox. Pausing notifications stays in the header control.</p>${chipStrip(false)}${chipMenu}</div></div>
</div>`;

// ---------- settings ----------
const settings = c2.settings
  .replace('<div class="modal-tab active" aria-current="page" style="cursor:pointer">Settings</div>', '<div class="modal-tab" style="cursor:pointer">Settings</div>')
  .replace('Model Endpoints</div>', 'Model Endpoints</div><div class="modal-tab active" aria-current="page">Notifications</div>')
  .replace(/<div class="new-tab" role="tabpanel">[\s\S]*?(<div class="modal-footer">)/, (_m, foot) => `<div class="new-tab" role="tabpanel">
  <div class="settings-section"><div class="settings-section-header">Delivery</div>
    <div class="setting-row"><div class="setting-row-text"><label class="setting-title" for="sn-level">Notify me for</label><p class="setting-desc">Default for anything without a more specific rule.</p></div><select id="sn-level"><option>High and up</option></select></div>
    <div class="setting-row"><div class="setting-row-text"><label class="setting-title" for="sn-tray">Keep running in the background</label><p class="setting-desc">Closing the window keeps claude-fleet in the tray so automations keep firing. Quit from the tray icon.</p></div><input id="sn-tray" type="checkbox" checked /></div>
  </div>
  <div class="settings-section"><div class="settings-section-header">Downtime</div>
    <p class="setting-desc">Recurring times when notifications are held. Todos still arrive and the taskbar count stays accurate. When a downtime ends you get one summary.</p>
    <div class="week" aria-label="Downtime this week">
      <div class="week-hours"><span></span>${[0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}</span>`).join('')}</div>
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => {
        const we = i >= 5;
        const blocks = we ? [[0, 24, 'b-weekend']] : [[0, 7, 'b-night'], [22, 24, 'b-night'], [13, 15, 'b-focus']];
        return `<div class="week-row"><span class="week-day${i === 0 ? ' today' : ''}">${d}</span><div class="week-track">${blocks.map(([a, b, k]) => `<span class="wblk ${k}" style="left:${(a / 24) * 100}%;width:${((b - a) / 24) * 100}%"></span>`).join('')}${i === 0 ? '<span class="week-now" style="left:58.5%"></span>' : ''}</div></div>`;
      }).join('')}
    </div>
    <ul class="dt-list">
      <li><span class="switch on"></span><span class="wkey b-night"></span><b>Nights</b><span class="mono dim">every day · 22:00–07:00</span><span class="dt-thru">urgent waits</span><button class="btn-mini">Edit</button></li>
      <li><span class="switch on"></span><span class="wkey b-weekend"></span><b>Weekends</b><span class="mono dim">Sat–Sun · all day</span><span class="dt-thru on">urgent gets through</span><button class="btn-mini">Edit</button></li>
      <li><span class="switch on"></span><span class="wkey b-focus"></span><b>Focus block</b><span class="mono dim">Mon–Fri · 13:00–15:00</span><span class="dt-thru on">urgent + needs input get through</span><button class="btn-mini">Edit</button></li>
    </ul>
    <button class="btn btn-sm">+ Add downtime</button>
  </div>
  <div class="settings-section"><div class="settings-section-header">Rules</div>
    <p class="setting-desc">Made from the ${I.bell} on any todo or notification. The most specific rule wins: reminder, then source, then tag, then the default.</p>
    <table class="rules"><thead><tr><th>Applies to</th><th>Level</th><th>Snooze</th><th></th></tr></thead><tbody>
      <tr><td><span class="scope-k">reminder</span>Drink water <span class="dim">· ${I.auto}reminders</span></td><td>Off</td><td class="mono">until 23:59 today</td><td><button class="btn-mini">Remove</button></td></tr>
      <tr><td><span class="scope-k">source</span>${src('ws', 'webex-triage')}</td><td>Urgent only</td><td class="dim">—</td><td><button class="btn-mini">Remove</button></td></tr>
      <tr><td><span class="scope-k">source</span>${src('auto', 'nightly-cost-report')}</td><td>Off</td><td class="mono">until Oct 26</td><td><button class="btn-mini">Remove</button></td></tr>
      <tr><td><span class="scope-k">tag</span><span class="tag">flaky</span></td><td>All</td><td class="dim">—</td><td><button class="btn-mini">Remove</button></td></tr>
    </tbody></table>
  </div>
  <div class="settings-section"><div class="settings-section-header">Windows permission</div>
    <div class="setting-row"><div class="setting-row-text"><span class="setting-title"><span class="sn-ok"></span>Notifications are allowed for claude-fleet</span><p class="setting-desc">If they stop showing, check Windows Settings › System › Notifications.</p></div><button class="btn btn-sm">Send a test</button></div>
  </div>
</div>${foot}`);

// ---------- edit workspace ----------
const editModal = c3.edit.replace(/(<details class="form-disclosure"><summary>Committee access[\s\S]*?<\/details>)/, `$1<details class="form-disclosure" open><summary>Inbox &amp; automations <span class="form-hint">can post · trusted</span></summary>
  <label class="committee-reachable-row"><input type="checkbox" checked /><span>Can post todos and notifications</span></label>
  <div class="form-row ib-rate"><label for="ew-rate">Posts per hour</label><input id="ew-rate" value="60" /></div>
  <label class="committee-reachable-row"><input type="checkbox" checked /><span>Trusted for low-risk automation edits</span></label>
  <div class="committee-warning" role="note">${I.warn}<span>Its edits to name, tags, prompt wording and schedule (no faster than every 5 min) apply without asking. <strong>New scripts, secrets, or prompt targets still need you.</strong></span></div>
  <label class="committee-reachable-row"><input type="checkbox" /><span>Can read the whole inbox</span></label>
  <p class="form-hint">Off: it sees only todos it posted and ones linked to it.</p>
</details>`);

// ---------- page ----------
const variantDefs = [
  ['chip', 'A · Inbox chip (chosen)', 'A compact chip in the same language as the workspace chips: status dot, name, sub-line. It sits after the workspaces, before +. Selected, it gets the active chip treatment, so "the inbox is where you are" reads like any workspace. While the inbox is open, the workspace chip drops its active outline so only one place looks selected; the rails keep showing the last workspace.'],
  ['text', 'B · Status text', 'The same shape as the Docker indicator: mono label, state carried by the dot alone. The quietest option. The count rides along in mono.'],
  ['square', 'C · Gear twin', 'A square twin of the Settings gear with a tray glyph and a corner dot. The count moves to the tooltip. Consistent with the gear, but the count is hidden.'],
  ['wide', 'D · Gear, widened', 'The gear\'s border and size, widened to carry the dot and count. Visible count, still in the action-button family.'],
];
const compact = (html) => { const parts = html.split('<div class="ws-chip-group'); return [parts[0], parts[1], ...parts.slice(4)].join('<div class="ws-chip-group'); };
const stripCrop = (v, on) => `<div class="strip-crop"><div class="strip-inner">${compact(tabs(on, v)).replace('4 workspaces', '4 workspaces')}</div></div>`;
const variantsHtml = `<div class="variants">${variantDefs.map(([v, n, d]) => `<div class="variant"><div class="variant-head"><b>${n}</b><p>${d}</p></div><div class="variant-states"><div><span class="vs-label">closed</span>${stripCrop(v, false)}</div><div><span class="vs-label">inbox open</span>${stripCrop(v, true)}</div></div></div>`).join('')}
<div class="dot-key"><b>Dot color, shared by every variant</b><span><span class="dot inbox-dot urgent"></span>something urgent is open</span><span><span class="dot inbox-dot wait"></span>a proposal needs your approval</span><span><span class="dot inbox-dot"></span>open todos, nothing pressing</span><span class="dim">No dot pulse: in this app pulsing means "working".</span></div></div>`;
const screens = [
  {
    id: 'entry', name: 'Inbox entry point: variants',
    notes: [
      ['Why the first version was off', 'It used an unstyled button next to the real Settings gear, plus a red count bubble. The strip\'s own rule (#23) is that state rides on a dot, never on pill or bubble chrome, and labels are small mono text.'],
      ['What stays the same', 'Placement and behavior: clicking opens the inbox in the main pane. Only the control changes.'],
    ],
    extra: variantsHtml,
    html: '',
  },
  {
    id: 'todos', name: 'Inbox › Todos',
    notes: [
      ['Where it lives', 'A tray icon sits beside Settings in the top strip, with an open-count badge that turns red when anything is urgent. Clicking it swaps the main pane to the inbox. Both rails stay as you left them.'],
      ['Three tabs', 'They use the session-tab strip: Todos, Automations, Activity. The Activity count is violet, the app\'s "needs you" color, because it counts pending approvals.'],
      ['Rows', 'Grouped by priority, with a colored left edge (urgent red, high amber). The meta line shows source (⟳ automation, a colored dot for a workspace, or You), age, seen-count, a recurred flag and tags.'],
      ['Detail', 'Shows the immutable source and its run, the dedupe key, seen history, the linked session and editable tags. Below that is the poster\'s markdown body and a history timeline that explains why the todo reopened.'],
    ],
    html: frame(todosMain(todos)),
  },
  {
    id: 'bell', name: 'The 🔔 quick-change',
    notes: [
      ['One click from the noise', 'The bell on any row opens this popover, pre-filled with that item\'s scopes. Here: this reminder, its automation, or its tag.'],
      ['Level or snooze', 'Pick All, High and up, Urgent only or Off, or just snooze. Off only silences the notification. The todo still lands in the inbox.'],
      ['Visible afterwards', 'A muted row shows a bell-off line ("off for this reminder · today"), so it\'s always clear why something is quiet. "All rules" jumps to Settings.'],
    ],
    html: frame(todosMain(todos.map((t) => (t.id === 'water' ? { ...t, bellOpen: true, muted: '' } : { ...t, sel: false })), 'water', `<aside class="ib-detail ib-detail-empty"><p class="dim">Select a todo to see its details.</p></aside>`)),
  },
  {
    id: 'pause', name: 'Global snooze & downtime',
    notes: [
      ['Pause vs. downtime', 'Pause is one-off and immediate ("for 1 hour"). Downtime is a recurring schedule ("nights 22:00 to 07:00"). Both only hold notifications. Todos still arrive.'],
      ['Urgent bypass', 'Each pause and each downtime decides whether urgent items get through. Off by default for nights, on for focus blocks.'],
      ['One summary afterwards', 'When it ends you get one digest, never a burst of replayed toasts.'],
    ],
    extra: pauseHtml,
    html: '',
  },
  {
    id: 'automations', name: 'Inbox › Automations',
    notes: [
      ['List', 'An enable switch, trigger summary, next fire, last-run status (succeeded, nothing to do, failed, interrupted) and tags.'],
      ['Detail', 'A week at a glance (runs, how many did nothing, failures, cost), then triggers, steps, params and the secrets each step can see.'],
      ['Runs', 'Expand a run to see each step: script exit code, stdout tail and saved state, or the prompt\'s session link and what it posted. Exit 10 shows as "nothing to do", not as a failure.'],
    ],
    html: frame(autoMain),
  },
  {
    id: 'sessions', name: 'Sessions in the Inbox',
    notes: [
      ['The Inbox is the automations workspace', 'Its terminal sessions open as tabs after Todos, Automations and Activity, with + for a new one. Ask questions about automations, investigate failures, or make bulk changes right next to them.'],
      ['Rails follow', 'With the Inbox selected, the left rail lists the automations workspace\'s sessions and the Observability rail shows its cost and context, like any workspace.'],
      ['Fleet-wide reach, same approvals', 'Its role grants read access to every automation and run, and lets it propose changes to any of them. Changes still flow through proposals; it never approves on its own behalf.'],
    ],
    extra: sessHtml,
    html: frame(sessMain, '', { left: autoLeft, obs: autoObs }),
  },
  {
    id: 'authoring', name: 'Creating & editing with Claude',
    notes: [
      ['Describe it first', '"New automation" opens a composer. You describe the automation, and a workspace you pick drafts it in a fresh session. A blank form is the fallback.'],
      ['Review, iterate, approve', 'The draft returns as a proposal card with Form and YAML views. Ask for changes in plain language, test-run it, then approve.'],
      ['Editing later', 'Every automation has an "Ask Claude to change…" bar in its header. The change comes back as a diff to approve. "Edit" opens the same form/YAML editor for direct tweaks.'],
    ],
    extra: authoringHtml,
    html: frame(autoMain, composer),
  },
  {
    id: 'loadouts', name: 'Automations in loadouts',
    notes: [
      ['Install = approval', 'Installing a loadout lists its automations in the review you already see for files, scripts and hooks. Ticked ones turn on with the install. One with a missing secret installs off until you add it.'],
      ['Bound to the workspace', 'Prompt steps target $self, the workspace the loadout goes into, and use that workspace\'s vault. The same loadout in two workspaces gives two independent copies.'],
      ['Synced like loadouts', 'Remote sources, version stamps and Update ↑ all carry over unchanged. Uninstalling the loadout turns its automations off and removes them. Their run history stays.'],
    ],
    extra: loHtml,
    html: frame(autoMain, loModal),
  },
  {
    id: 'discuss', name: 'Ask Claude about a change',
    notes: [
      ['One button, every review', '"Ask Claude about this" sits on loadout installs and updates, workspace proposals, and drafts. It opens a review conversation beside the changes.'],
      ['Answers before you ask', 'Claude opens with what changes, how it interacts with your edits, how much noise it adds, a security read (secrets, hosts, commands, prompt-injection surface), and a recommendation. Then you can keep asking.'],
      ['Advice only', 'The incoming content is handed over as data under review. Claude can send a merged version back as a proposal, but taking the update or approving stays your click.'],
    ],
    html: frame(autoMain, discussModal),
  },
  {
    id: 'run', name: 'Run now with parameters',
    notes: [
      ['Generated form', 'Built from the automation\'s declared params, pre-filled with defaults. Required fields are marked.'],
      ['Validated up front', 'A bad value errors inline and no run is created. MCP callers get the same check through run_automation.'],
      ['Concurrency is stated', 'The form says whether a run is in progress and what "skip" or "queue" will do about it.'],
    ],
    html: frame(autoMain, runModal),
  },
  {
    id: 'activity', name: 'Inbox › Activity',
    notes: [
      ['Proposals', 'A workspace\'s proposal shows its rationale, why it needs you (script, secret, prompt target), how often it will run, the definition diff and the full script text. Approve, edit then approve, or reject with a note the workspace can read.'],
      ['Auto-approved edits', 'Low-risk edits from trusted workspaces still appear here, with a one-click Revert.'],
      ['Notification log', 'Every notification request, including the ones held back, with the rule or downtime that held it. Kept for 30 days; proposals and your decisions on them are kept for good.'],
    ],
    html: frame(activityMain),
  },
  {
    id: 'toast', name: 'When it reaches you',
    notes: [
      ['App in the background', 'A Windows notification. Clicking it focuses the app on that todo, which gets a brief highlight.'],
      ['App in focus', 'The app\'s own toast instead (below), with Open. No OS buttons in v1, because Electron toast actions behave differently on each platform.'],
    ],
    extra: `<div class="toast-demo"><span class="dim">In-app version, using the app's existing toast:</span>${inAppToast}</div>`,
    html: frame(todosMain(freshList), osToast),
  },
  {
    id: 'desktop', name: 'Taskbar, tray and dock',
    notes: [
      ['One signal everywhere', 'The inbox chip, taskbar, tray and dock all show the same "needs you" state: urgent todos, approvals, and workspaces waiting for input. One item is a dot, two or more a count. Red if anything is urgent, otherwise the same violet as a waiting chip.'],
      ['Interruptions stay rare', 'Only a new urgent item flashes the taskbar or bounces the dock. Everything else just changes the dot.'],
      ['Your rules apply', 'Snoozes and quiet hours from the bell also hold back the flash and bounce. The dot still shows the state.'],
    ],
    extra: desktopHtml,
    html: '',
  },
  {
    id: 'settings', name: 'Settings › Notifications',
    notes: [
      ['Delivery and downtime', 'Default level and keep-running-in-tray, then Downtime: a week view of when notifications are held, and the schedules behind it, each with its own urgent bypass.'],
      ['Rules', 'Everything you created from a 🔔, in one table, with snooze expiry and Remove. Precedence is spelled out.'],
      ['Permission', 'Shows whether Windows allows the app\'s notifications, with a test button.'],
    ],
    html: frame(todosMain(todos), settings),
  },
  {
    id: 'workspace', name: 'Edit workspace › Inbox & automations',
    notes: [
      ['Per-workspace switches', 'A new disclosure under Committee access: can post (with an hourly cap), trusted for low-risk edits, and can read the whole inbox.'],
      ['Trust is explained in place', 'The warning says exactly what applies without asking and what still needs you, reusing the committee consent note.'],
    ],
    html: frame(todosMain(todos), editModal),
  },
];

const pageCss = `
html, body { height: auto !important; overflow: auto !important; }
body { background: var(--bg-canvas); color: var(--ink); font-family: var(--font-sans); padding: 0 20px 64px; }
.doc { max-width: 1480px; margin: 0 auto; }
.doc-head { padding-block: 32px 18px; display: grid; gap: 10px; }
.doc-eyebrow { font-family: var(--font-mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-2); display: flex; gap: 8px; align-items: center; }
.doc-eyebrow .brand-tile { width: 22px; height: 22px; font-size: 10px; }
.doc-head h1 { margin: 0; font-size: 26px; font-weight: 650; letter-spacing: -.01em; text-wrap: balance; }
.doc-head p { margin: 0; max-width: 68ch; color: var(--ink-1); line-height: 1.55; font-size: 14px; }
.doc-nav { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 50; display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 0; background: var(--bg-canvas); border-bottom: 1px solid var(--rule); }
.doc-nav a { font-family: var(--font-mono); font-size: 11px; color: var(--ink-1); text-decoration: none; padding: 5px 9px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-1); }
.doc-nav a:hover, .doc-nav a:focus-visible { color: var(--ink); border-color: var(--rule-strong); outline: none; }
.doc-nav a span { color: var(--ink-3); margin-right: 5px; }
.screen { padding-top: 34px; scroll-margin-top: 56px; display: grid; gap: 14px; }
.screen h2 { margin: 0; font-size: 18px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; }
.screen h2 .n { font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); }
.notes { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px 22px; }
.note b { display: block; font-size: 12px; color: var(--ink); margin-bottom: 3px; }
.note p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-1); max-width: 62ch; }
.frame-wrap { overflow: hidden; border: 1px solid var(--rule-strong); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); background: var(--bg); }
.frame-scale { width: 1440px; height: 900px; transform-origin: 0 0; }
.mock-app { height: 900px !important; width: 1440px; position: relative; transform: translateZ(0); overflow: hidden; }
.mock-app .modal-tabbed { max-height: 820px; width: 720px; }
.mock-app .modal { max-height: 840px; overflow: auto; }
.toast-demo { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 12px; }
.toast-demo .toast { animation: none; }
.doc-foot { margin-top: 40px; color: var(--ink-3); font-size: 12px; font-family: var(--font-mono); }

/* ---------- new components (tokens only) ---------- */
.dim { color: var(--ink-2); }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
code { font-family: var(--font-mono); font-size: 11px; color: var(--ink-1); background: var(--bg-2); border: 1px solid var(--rule-soft); border-radius: 3px; padding: 0 4px; }
.inbox-btn { position: relative; overflow: visible; }
.inbox-btn.on { color: var(--ink); background: var(--bg-3); border-color: var(--rule-strong); }
.inbox-badge { position: absolute; top: -6px; right: -8px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 999px; display: grid; place-items: center; font: 600 10px/1 var(--font-mono); background: var(--bg-3); color: var(--ink); box-shadow: 0 0 0 2px var(--bg-1); }
.inbox-badge.urgent { background: var(--danger); color: oklch(98% 0.01 28); }
.inbox-view { position: absolute; inset: 0; display: flex; flex-direction: column; }
.ib-tabs .session-tab { padding: 0 14px; border-bottom: 2px solid transparent; }
.ib-tabs .session-tab.active { border-bottom-color: var(--ink-1); }
.ib-count { font-size: 10px; color: var(--ink-2); background: var(--bg-3); border-radius: 999px; padding: 1px 6px; }
.ib-count.wait { background: color-mix(in oklch, var(--wait), transparent 78%); color: var(--wait); }
.ib-tabs-spacer, .ib-spacer { flex: 1; }
.ib-new { align-self: center; margin-right: 10px; }
.ib-split { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 372px; }
.ib-listcol { min-height: 0; overflow: auto; border-right: 1px solid var(--rule); }
.ib-toolbar { display: grid; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--rule-soft); position: sticky; top: 0; background: var(--bg); z-index: 2; }
.ib-toolbar .obs-scope-toggle { margin: 0; }
.ib-scope { grid-template-columns: repeat(4, 1fr); }
.ib-scope.three { grid-template-columns: repeat(3, 1fr); }
.ib-filters { display: flex; gap: 6px; align-items: center; }
.ib-toolbar.row { display: flex; }
.ib-toolbar.row .ib-scope { flex: 0 1 560px; }
.todo-list, .auto-list, .run-list, .notif-log, .ib-lines, .ib-steps, .ib-hist { list-style: none; margin: 0; padding: 0; }
.todo-list { padding: 6px 8px 16px; display: grid; gap: 2px; }
.todo-group { padding-top: 10px; }
.todo-group.g-urgent { color: var(--danger); }
.todo-group.g-high { color: var(--warn); }
.todo-row { position: relative; display: flex; gap: 10px; align-items: flex-start; padding: 8px 8px 8px 10px; border: 1px solid transparent; border-left: 2px solid transparent; border-radius: 3px var(--r-md) var(--r-md) 3px; }
.todo-row:hover { background: var(--bg-card); border-color: var(--rule); }
.todo-row.p-urgent { border-left-color: var(--danger); }
.todo-row.p-high { border-left-color: var(--warn); }
.todo-row.p-normal { border-left-color: var(--rule-strong); }
.todo-row.sel { background: var(--bg-2); border-color: var(--rule-strong); }
.todo-row.p-urgent.sel { border-left-color: var(--danger); }
.todo-row.fresh { background: color-mix(in oklch, var(--danger), var(--bg) 88%); box-shadow: 0 0 0 1px color-mix(in oklch, var(--danger), transparent 55%); }
.todo-check { flex: none; width: 15px; height: 15px; margin-top: 1px; border-radius: 50%; border: 1.5px solid var(--ink-3); background: transparent; cursor: pointer; }
.todo-check:hover { border-color: var(--ok); }
.todo-main { flex: 1; min-width: 0; display: grid; gap: 5px; }
.todo-title { font-size: 13px; color: var(--ink); line-height: 1.35; }
.todo-meta { display: flex; flex-wrap: wrap; gap: 4px 9px; align-items: center; font-size: 11px; color: var(--ink-2); }
.todo-time { font-family: var(--font-mono); font-size: 10.5px; }
.todo-seen { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-1); }
.todo-flag { font-family: var(--font-mono); font-size: 10px; color: var(--warn); border: 1px solid color-mix(in oklch, var(--warn), transparent 60%); border-radius: var(--r-sm); padding: 1px 5px; }
.todo-muted { display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--ink-2); }
.todo-actions { display: flex; gap: 2px; flex: none; }
.todo-act { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--ink-3); cursor: pointer; }
.todo-row:hover .todo-act, .todo-row.sel .todo-act { color: var(--ink-1); }
.todo-act:hover, .todo-act.open { background: var(--bg-3); border-color: var(--rule); color: var(--ink); }
.todo-act.quiet { color: var(--ink-2); }
.src { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-1); font-size: 11px; white-space: nowrap; }
.src-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.src-auto svg { color: var(--info); }
.src-user { color: var(--ink-1); }
.ib-detail { min-height: 0; overflow: auto; padding: 16px 16px 24px; display: flex; flex-direction: column; gap: 14px; background: var(--bg-1); }
.ib-detail-empty { justify-content: center; align-items: center; }
.ib-detail-head { display: grid; gap: 8px; }
.ib-detail-chips { display: flex; gap: 8px; align-items: center; font-size: 11px; }
.prio { font: 600 10px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; padding: 4px 7px; border-radius: var(--r-sm); }
.prio-urgent { color: var(--danger); background: color-mix(in oklch, var(--danger), transparent 85%); border: 1px solid color-mix(in oklch, var(--danger), transparent 55%); }
.state-chip { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-1); border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 2px 6px; }
.state-chip.ok { color: var(--ok); border-color: var(--c2-soft); background: var(--c2-tint); }
.ib-detail-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.3; text-wrap: balance; }
.ib-desc { margin: 0; font-size: 12.5px; color: var(--ink-1); line-height: 1.45; }
.ib-detail-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ib-detail-actions .btn { display: inline-flex; gap: 5px; align-items: center; }
.ib-select { background: var(--bg); color: var(--ink-1); border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 4px 6px; font: inherit; font-size: 11px; }
.ib-kv { display: grid; grid-template-columns: 64px 1fr; gap: 8px 10px; margin: 0; font-size: 12px; padding: 12px 0; border-block: 1px solid var(--rule-soft); }
.ib-kv dt { color: var(--ink-3); font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; padding-top: 2px; }
.ib-kv dd { margin: 0; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; color: var(--ink-1); }
.ib-tags { display: inline-flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.ib-addtag { font: 10px var(--font-mono); color: var(--ink-2); background: transparent; border: 1px dashed var(--rule-strong); border-radius: var(--r-sm); padding: 2px 6px; cursor: pointer; }
.ib-link { color: var(--info); display: inline-flex; gap: 5px; align-items: center; cursor: pointer; font-size: 12px; }
.ib-body p { margin: 0 0 8px; font-size: 12.5px; line-height: 1.5; color: var(--ink-1); }
.ib-pre { margin: 0; padding: 9px 10px; background: var(--bg-canvas); border: 1px solid var(--rule-soft); border-radius: var(--r-md); font: 10.5px/1.55 var(--font-mono); color: var(--ink-1); overflow-x: auto; white-space: pre; }
.ib-pre.sm { padding: 6px 8px; font-size: 10px; }
.ib-pre.diff .add { color: var(--ok); }
.ib-hist-title, .ib-sec { font: 600 10px var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); }
.ib-hist { display: grid; gap: 0; position: relative; }
.ib-hist li { display: grid; grid-template-columns: 14px 1fr auto; gap: 8px; align-items: start; font-size: 12px; color: var(--ink-1); padding: 5px 0; position: relative; }
.ib-hist li::before { content: ''; position: absolute; left: 4px; top: 16px; bottom: -6px; width: 1px; background: var(--rule); }
.ib-hist li:last-child::before { display: none; }
.h-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--bg-3); border: 1px solid var(--rule-strong); margin-top: 3px; }
.h-dot.reopen { background: var(--warn); border-color: var(--warn); }
.h-when { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-3); }
.bell-pop { position: absolute; right: 6px; width: 300px; z-index: 20; padding: 12px; gap: 10px; }
.bell-pop.up { bottom: calc(100% - 30px); right: 40px; }
.bp-title { font-size: 12px; color: var(--ink); font-weight: 600; }
.bp-scope { margin: 0; grid-template-columns: repeat(3, 1fr); }
.bp-scope .obs-scope-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.bp-levels { display: grid; gap: 2px; }
.bp-level { display: flex; align-items: center; gap: 8px; padding: 6px 7px; border-radius: var(--r-sm); font-size: 12px; color: var(--ink-1); cursor: pointer; }
.bp-level:hover { background: var(--bg-hover); }
.bp-level.on { background: var(--bg-3); color: var(--ink); }
.bp-radio { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--ink-3); flex: none; }
.bp-level.on .bp-radio { border-color: var(--ok); box-shadow: inset 0 0 0 2.5px var(--bg-3), inset 0 0 0 6px var(--ok); }
.bp-hint { margin-left: auto; font-size: 10.5px; color: var(--ink-3); }
.bp-sub { font: 600 10px var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.bp-snooze { display: flex; flex-wrap: wrap; gap: 5px; }
.bp-snooze .btn-mini.on { border-color: var(--c2-soft); color: var(--ok); background: var(--c2-tint); }
.bp-foot { display: flex; justify-content: space-between; align-items: center; font-size: 11px; border-top: 1px solid var(--rule); padding-top: 9px; }
.auto-list { padding: 8px; display: grid; gap: 4px; }
.auto-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border: 1px solid transparent; border-radius: var(--r-md); }
.auto-row:hover { background: var(--bg-card); border-color: var(--rule); }
.auto-row.sel { background: var(--bg-2); border-color: var(--rule-strong); }
.auto-row.off .auto-name { color: var(--ink-2); }
.auto-main { display: grid; gap: 5px; min-width: 0; }
.auto-name { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--ink); font-weight: 500; }
.auto-name svg { color: var(--info); }
.auto-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-size: 11px; color: var(--ink-1); }
.switch { flex: none; width: 26px; height: 15px; border-radius: 999px; background: var(--bg-3); border: 1px solid var(--rule-strong); position: relative; margin-top: 2px; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; border-radius: 50%; background: var(--ink-2); }
.switch.on { background: var(--c2-tint); border-color: var(--c2-soft); }
.switch.on::after { left: 13px; background: var(--ok); }
.run-chip { font-family: var(--font-mono); font-size: 10px; padding: 1px 6px; border-radius: var(--r-sm); border: 1px solid var(--rule); color: var(--ink-1); white-space: nowrap; }
.run-chip.ok { color: var(--ok); border-color: var(--c2-soft); background: var(--c2-tint); }
.run-chip.idle { color: var(--ink-2); }
.run-chip.bad { color: var(--danger); border-color: color-mix(in oklch, var(--danger), transparent 55%); background: color-mix(in oklch, var(--danger), transparent 88%); }
.run-chip.warn { color: var(--warn); border-color: color-mix(in oklch, var(--warn), transparent 60%); }
.ib-statline { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 11.5px; color: var(--ink-2); padding: 10px 0; border-block: 1px solid var(--rule-soft); }
.ib-statline b { color: var(--ink); font-weight: 600; }
.ib-lines { display: grid; gap: 7px; }
.ib-lines li { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--ink-1); }
.ib-lines li > svg { color: var(--ink-2); }
.ib-steps { display: grid; gap: 6px; counter-reset: s; }
.ib-steps li { display: flex; flex-wrap: wrap; gap: 6px 9px; align-items: center; font-size: 12px; color: var(--ink-1); padding: 8px 10px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg); }
.step-k { display: inline-flex; gap: 5px; align-items: center; font-family: var(--font-mono); font-size: 11px; color: var(--ink); }
.secret { display: inline-flex; gap: 4px; align-items: center; font: 10px var(--font-mono); color: var(--warn); border: 1px solid color-mix(in oklch, var(--warn), transparent 65%); border-radius: var(--r-sm); padding: 1px 5px; }
.run-list { display: grid; border: 1px solid var(--rule); border-radius: var(--r-md); overflow: hidden; }
.run-row { display: grid; grid-template-columns: 34px 38px 58px auto 1fr 44px; gap: 6px; align-items: center; font-size: 11px; padding: 7px 9px; border-bottom: 1px solid var(--rule-soft); color: var(--ink-1); }
.run-row:last-child { border-bottom: none; }
.run-row .dim { font-size: 10.5px; }
.run-row > .mono:nth-of-type(3) { justify-self: end; }
.run-row > .run-chip { justify-self: start; }
.run-row .run-out { grid-column: 2 / -2; grid-row: 2; color: var(--ink-2); font-size: 10.5px; }
.run-row > .mono:last-of-type { grid-column: -2; grid-row: 1; justify-self: end; }
.run-row > .mono.dim { grid-column: 5; justify-self: end; }
.run-row.open { background: var(--bg-2); }
.run-id { color: var(--ink-3); }
.run-steps { grid-column: 1 / -1; display: grid; gap: 6px; margin-top: 6px; }
.run-step { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: center; font-size: 11px; color: var(--ink-1); }
.run-step .ib-pre, .run-step > span:last-child:not(.mono) { grid-column: 1 / -1; }
.run-modal { width: 440px; }
.run-modal h2 svg { color: var(--ok); }
.run-modal .form-hint { margin: 8px 0 14px; }
.run-form .form-row .form-hint { margin: 4px 0 0; }
.req { font: 10px var(--font-mono); color: var(--warn); margin-left: 6px; text-transform: none; letter-spacing: 0; }
.ib-single { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ib-scroll { flex: 1; min-height: 0; overflow: auto; padding: 8px 16px 24px; display: grid; gap: 10px; align-content: start; }
.proposal { border: 1px solid var(--rule-strong); border-left: 2px solid var(--wait); border-radius: 3px var(--r-lg) var(--r-lg) 3px; background: var(--bg-1); padding: 14px 16px; display: grid; gap: 10px; max-width: 760px; }
.proposal.auto-ok { border-left-color: var(--ok); padding: 10px 16px; gap: 6px; }
.pr-eyebrow { display: flex; gap: 6px; align-items: center; font-size: 11px; flex-wrap: wrap; }
.pr-kind { font: 600 10px var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--wait); }
.pr-kind.ok { color: var(--ok); }
.pr-title { margin: 0; font-size: 15px; font-weight: 600; display: flex; gap: 7px; align-items: center; }
.pr-title svg { color: var(--info); width: 14px; height: 14px; }
.pr-why { margin: 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--rule-strong); color: var(--ink-1); font-size: 12.5px; line-height: 1.5; max-width: 66ch; }
.pr-flags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; }
.pr-flags-label { color: var(--ink-2); margin-right: 2px; }
.flag { display: inline-flex; gap: 5px; align-items: center; font-size: 11px; color: var(--warn); border: 1px solid color-mix(in oklch, var(--warn), transparent 62%); background: color-mix(in oklch, var(--warn), transparent 92%); border-radius: var(--r-sm); padding: 2px 7px; }
.flag .src { color: var(--ink); }
.pr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px; color: var(--ink-1); }
.pr-k { font: 600 10px var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 3px; }
.pr-script summary { cursor: pointer; font: 11px var(--font-mono); color: var(--ink-1); margin-bottom: 6px; }
.pr-actions { display: flex; gap: 8px; }
.pr-line { display: flex; gap: 7px; align-items: center; font-size: 12px; color: var(--ink-1); flex-wrap: wrap; }
.pr-line > svg { color: var(--info); }
.notif-log { display: grid; border: 1px solid var(--rule); border-radius: var(--r-md); max-width: 760px; }
.nl-row { display: grid; grid-template-columns: 18px 40px minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--rule-soft); font-size: 12px; }
.nl-row:last-child { border-bottom: none; }
.nl-glyph { color: var(--ink-1); display: grid; }
.nl-row.held .nl-glyph { color: var(--ink-3); }
.nl-title { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nl-row.held .nl-title { color: var(--ink-1); }
.nl-why { grid-column: 3 / -1; font-size: 11px; color: var(--ink-2); }
.nl-row.held .nl-why { color: var(--ink-2); font-style: italic; }
.os-toast { position: absolute; right: 18px; bottom: 50px; width: 364px; z-index: 40; padding: 14px 16px 16px; border-radius: 8px; background: oklch(24% 0.005 260); border: 1px solid oklch(34% 0.005 260); box-shadow: 0 18px 50px rgb(0 0 0 / .6); font-family: 'Segoe UI Variable', 'Segoe UI', var(--font-sans); color: oklch(95% 0 0); display: grid; gap: 6px; }
.os-toast-head { display: flex; gap: 8px; align-items: center; font-size: 12px; color: oklch(80% 0 0); }
.os-tile { width: 18px; height: 18px; font-size: 8px; }
.os-x { margin-left: auto; color: oklch(70% 0 0); font-size: 11px; }
.os-toast-title { font-size: 14px; font-weight: 600; line-height: 1.3; }
.os-toast-body { font-size: 13px; color: oklch(82% 0 0); }
.os-label { position: absolute; right: 22px; bottom: 214px; z-index: 40; font: 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); background: var(--bg-canvas); border: 1px solid var(--rule); padding: 3px 7px; border-radius: var(--r-sm); }
.sn-qh { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sn-qh .committee-reachable-row { margin: 0; font-size: 12px; }
.sn-time { width: 64px; background: var(--bg-canvas); border: 1px solid var(--rule); border-radius: var(--r-sm); color: var(--ink); font: 12px var(--font-mono); padding: 5px 7px; }
table.rules { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
.rules th { text-align: left; font: 600 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); padding: 6px 8px; border-bottom: 1px solid var(--rule); }
.rules td { padding: 8px; border-bottom: 1px solid var(--rule-soft); color: var(--ink-1); }
.rules td:first-child { display: flex; gap: 7px; align-items: center; }
.rules td:last-child { text-align: right; }
.scope-k { font: 10px var(--font-mono); color: var(--ink-3); border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 1px 5px; min-width: 52px; text-align: center; }
.sn-ok { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); margin-right: 7px; }
.ib-rate { flex-direction: row; align-items: center; gap: 10px; margin: 0 0 6px 24px; }
.ib-rate label { margin: 0; }
.ib-rate input { width: 70px; }
.inbox-chip { min-width: 0; max-width: none; }
.inbox-chip .ws-chip { border: none; }
.inbox-chip.active { border-color: var(--ink-2); }
.dot.inbox-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; background: var(--ink-3); }
.dot.inbox-dot.urgent { background: var(--danger); }
.dot.inbox-dot.wait { background: var(--wait); }
.inbox-text { background: transparent; border: 1px solid transparent; border-radius: var(--r-md); padding: 6px 8px; cursor: pointer; }
.inbox-text:hover, .inbox-text.on { border-color: var(--rule); background: var(--bg-hover); color: var(--ink); }
.inbox-n { font-family: var(--font-mono); font-size: 10px; color: var(--ink); font-variant-numeric: tabular-nums; }
.inbox-sq { position: relative; }
.inbox-sq .corner { position: absolute; top: 4px; right: 4px; width: 6px; height: 6px; box-shadow: 0 0 0 2px var(--bg-1); }
.settings-btn.on { color: var(--ink); border-color: var(--rule-strong); background: var(--bg-3); }
.inbox-wide { width: auto; padding: 0 9px; gap: 6px; }
.variants { display: grid; gap: 18px; }
.variant { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; gap: 18px; align-items: start; padding: 16px; border: 1px solid var(--rule); border-radius: var(--r-lg); background: var(--bg-1); }
.variant-head b { display: block; font-size: 14px; margin-bottom: 6px; }
.variant-head p { margin: 0; font-size: 12.5px; color: var(--ink-1); line-height: 1.5; }
.variant-states { display: grid; gap: 10px; min-width: 0; }
.vs-label { display: block; font: 600 10px var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 4px; }
.strip-crop { overflow-x: auto; border: 1px solid var(--rule-strong); border-radius: var(--r-md); max-width: 100%; }
.strip-inner { min-width: 860px; }
.dot-key { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; font-size: 12px; color: var(--ink-1); padding: 4px 2px; }
.dot-key > span { display: inline-flex; gap: 7px; align-items: center; }
.dot-key b { width: 100%; font-size: 12px; }
.dk { display: grid; gap: 16px; }
.dk-block { padding: 16px; border: 1px solid var(--rule); border-radius: var(--r-lg); background: var(--bg-1); display: grid; gap: 12px; }
.dk-split { grid-template-columns: 1.4fr 1fr; align-items: start; }
.dk-split > div { display: grid; gap: 12px; }
.dk-title { font-size: 14px; font-weight: 600; }
.dk-p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-1); max-width: 72ch; }
.ic-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.ic-card { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg); align-content: start; }
.ic-card.pick { border-color: var(--c2-soft); }
.ic-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.ic-sizes { display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap; }
.ic-sizes > div { display: grid; gap: 5px; justify-items: center; font-size: 10px; }
.ic-ctx { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tb.mini, .tray.mini { height: 44px; padding: 0 10px; justify-content: center; }
.ic-light { height: 44px; display: flex; gap: 14px; align-items: center; padding: 0 14px; border-radius: var(--r-md); background: oklch(93% 0.005 260); border: 1px solid oklch(85% 0.005 260); }
.ic-card p { margin: 0; font-size: 12px; line-height: 1.5; color: var(--ink-1); }
.dk-sizes { display: flex; gap: 22px; align-items: flex-end; flex-wrap: wrap; }
.dk-sizes > div { display: grid; gap: 6px; justify-items: center; font-size: 10px; }
.dk-icon { position: relative; display: inline-block; flex: none; }
.dk-icon svg { display: block; }
.dk-overlay { position: absolute; right: -12%; bottom: -12%; border-radius: 50%; box-shadow: 0 0 0 2px oklch(20% 0.005 260); display: grid; place-items: center; }
.dk-overlay.urgent { background: var(--danger); }
.dk-overlay.wait { background: var(--wait); }
.dk-overlay b { color: #fff; font-family: 'Segoe UI', var(--font-sans); font-weight: 700; line-height: 1; }
.dk-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.dk-alt { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: flex-start; font-size: 12px; } .dk-alt .dk-case { width: min(100%, 320px); } .dk-alt > .dim { width: 100%; }
.dk-case { margin: 0; display: grid; gap: 8px; }
.dk-case figcaption { display: grid; gap: 2px; font-size: 12px; color: var(--ink-1); line-height: 1.4; }
.dk-case figcaption b { color: var(--ink); font-weight: 600; }
.tb { height: 48px; display: flex; justify-content: center; align-items: center; gap: 4px; background: oklch(20% 0.005 260); border: 1px solid oklch(28% 0.005 260); border-radius: var(--r-md); }
.tb-app { position: relative; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 5px; }
.tb-app.running, .tb-app.focused { background: oklch(26% 0.005 260); }
.tb-app.flash { background: oklch(52% 0.13 60); }
.tb-pip { position: absolute; bottom: 1px; left: 50%; width: 6px; height: 3px; margin-left: -3px; border-radius: 2px; background: oklch(70% 0.005 260); }
.tb-app.focused .tb-pip { width: 16px; margin-left: -8px; background: oklch(72% 0.12 240); }
.tb-app.flash .tb-pip { background: oklch(85% 0.12 70); }
.tb-ghost { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 5px; background: oklch(32% 0.005 260); color: oklch(72% 0.005 260); font-size: 13px; }
.tb-start { width: 20px; height: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
.tb-start i { background: oklch(72% 0.1 240); border-radius: 1px; }
.tray { height: 48px; display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 0 12px; background: oklch(20% 0.005 260); border: 1px solid oklch(28% 0.005 260); border-radius: var(--r-md); color: oklch(85% 0 0); font: 11px 'Segoe UI', var(--font-sans); }
.tray-ic { padding: 6px; border-radius: 4px; background: oklch(26% 0.005 260); }
.tray-ic .dk-overlay { right: -3px; bottom: -3px; }
.tray-chev { color: oklch(70% 0 0); }
.tray-sys { letter-spacing: 6px; color: oklch(80% 0 0); }
.tray-clock { text-align: right; line-height: 1.3; }
.tray-menu { width: 260px; padding: 4px; border-radius: 8px; background: oklch(22% 0.005 260); border: 1px solid oklch(32% 0.005 260); box-shadow: 0 12px 34px rgb(0 0 0 / .5); display: grid; font: 12.5px 'Segoe UI', var(--font-sans); }
.tray-menu button { text-align: left; background: transparent; border: none; color: oklch(92% 0 0); padding: 7px 10px; border-radius: 4px; font: inherit; cursor: pointer; }
.tray-menu button:hover, .tray-menu button:focus-visible { background: oklch(30% 0.005 260); outline: none; }
.tray-menu button.dim { color: oklch(68% 0 0); cursor: default; }
.tm-head { display: flex; gap: 10px; align-items: center; padding: 8px 10px; }
.tm-head > span:last-child { display: grid; gap: 1px; }
.tm-head .dim { font-size: 11px; color: oklch(70% 0 0); }
.tm-div { height: 1px; background: oklch(32% 0.005 260); margin: 4px 6px; }
.dock { height: 76px; display: flex; justify-content: center; align-items: center; gap: 10px; padding: 0 14px; background: color-mix(in oklch, oklch(30% 0.01 260), transparent 30%); border: 1px solid oklch(40% 0.01 260 / .6); border-radius: 18px; }
.dock-ghost { width: 48px; height: 48px; border-radius: 11px; background: oklch(40% 0.01 260); }
.dock-app { position: relative; }
.dock-badge { position: absolute; top: -6px; right: -8px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: oklch(62% 0.21 27); color: #fff; font: 600 12px/20px -apple-system, var(--font-sans); text-align: center; box-shadow: 0 1px 2px rgb(0 0 0 / .4); }
.dock-dot { position: absolute; bottom: -8px; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: oklch(85% 0 0); }
.needs { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; font-size: 12px; color: var(--ink-1); }
.needs > span { display: inline-flex; gap: 7px; align-items: center; }
.needs-k { font: 600 10px var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.dk-split2 { display: grid; grid-template-columns: 364px 1fr; gap: 18px; align-items: center; }
.dk-split2 .dk-p b { color: var(--ink); }
.os-toast.static { position: static; width: 100%; }
.inbox-chip .ws-chip-menu-trigger { border-left-color: var(--rule); }
.inbox-chip.paused .inbox-dot { opacity: .45; }
.chip-bell-off { color: var(--ink-2); display: inline-grid; margin-left: -4px; }
.opt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; align-items: start; }
.opt-grid.two > .strip-crop .strip-inner { zoom: .8; min-width: 860px; }
.dk-split .strip-crop .strip-inner { zoom: .6; min-width: 860px; }
.opt-grid.two { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); align-items: center; }
.opt { min-width: 0; overflow: hidden; display: grid; gap: 10px; align-content: start; padding: 12px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg); }
.opt-k { font-size: 13px; font-weight: 600; }
.opt .strip-crop { overflow: hidden; }
.opt .strip-inner { min-width: 0; zoom: .62; width: 161%; }
.pause-menu { position: static; width: 250px; animation: none; justify-self: end; margin-right: 34px; }
.pm-label { font: 600 10px var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); padding: 6px 10px 2px; }
.pm-hint { margin-left: auto; color: var(--ink-3); font-size: 11px; }
.pm-check { display: flex; gap: 8px; align-items: center; padding: 6px 10px; font-size: 12px; color: var(--ink-1); }
.pm-check input { margin: 0; accent-color: var(--ok); }
.ph-wrap, .paused-scene { position: relative; border: 1px solid var(--rule-strong); border-radius: var(--r-md); overflow: visible; background: var(--bg); }
.ph-wrap { padding-bottom: 330px; zoom: .8; overflow: hidden; }
.ph-wrap .pause-menu.hdr { position: absolute; top: 46px; right: 100px; margin: 0; width: 270px; }
.ph-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.opt.wide { grid-column: span 2; }
.ph-btn.open { border-color: var(--rule-strong); background: var(--bg-3); }
.pm-state { display: flex; gap: 9px; align-items: flex-start; padding: 8px 10px; font-size: 12px; }
.pm-state svg { color: var(--ink-1); margin-top: 2px; flex: none; }
.pm-state > span { display: grid; gap: 2px; }
.pm-state b { color: var(--ink); font-weight: 600; }
.pm-state .dim { font-size: 11px; }
@media (max-width: 900px) { .opt.wide { grid-column: auto; } }
.ph-wrap .session-tab-strip { overflow: hidden; }
.ph-wrap .session-tab-strip, .paused-scene .session-tab-strip { border-radius: var(--r-md) var(--r-md) 0 0; overflow: visible; }
.ph-ctl { display: flex; gap: 6px; align-items: center; margin-right: 8px; }
.ph-ctl .ib-new { margin-right: 0; }
.ph-btn { display: inline-flex; gap: 6px; align-items: center; }
.ph-btn.paused { color: var(--warn); border-color: color-mix(in oklch, var(--warn), transparent 60%); }
.ph-pop { position: absolute; top: 46px; right: 8px; width: 300px; padding: 12px; gap: 10px; animation: none; }
.pause-banner { background: color-mix(in oklch, var(--warn), transparent 90%); border-bottom: 1px solid color-mix(in oklch, var(--warn), transparent 70%); border-radius: 0 0 var(--r-md) var(--r-md); }
.pause-banner > svg { color: var(--warn); flex: none; }
.week { display: grid; gap: 4px; margin: 10px 0 12px; }
.week-hours { position: relative; height: 14px; margin-left: 40px; font: 10px var(--font-mono); color: var(--ink-3); }
.week-hours span { position: absolute; transform: translateX(-50%); }
.week-row { display: grid; grid-template-columns: 34px 1fr; gap: 6px; align-items: center; }
.week-day { font: 10.5px var(--font-mono); color: var(--ink-2); }
.week-day.today { color: var(--ink); }
.week-track { position: relative; height: 14px; border-radius: 3px; background: var(--bg); border: 1px solid var(--rule-soft); }
.wblk { position: absolute; top: 1px; bottom: 1px; border-radius: 2px; }
.b-night { background: color-mix(in oklch, var(--info), transparent 62%); }
.b-weekend { background: color-mix(in oklch, var(--ink-2), transparent 70%); }
.b-focus { background: color-mix(in oklch, var(--wait), transparent 55%); }
.week-now { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--ok); border-radius: 1px; }
.dt-list { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 6px; }
.dt-list li { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 12px; color: var(--ink-1); padding: 7px 0; border-bottom: 1px solid var(--rule-soft); }
.dt-list li b { color: var(--ink); font-weight: 500; }
.dt-list .btn-mini { margin-left: auto; }
.wkey { width: 10px; height: 10px; border-radius: 2px; }
.dt-thru { font: 10.5px var(--font-mono); color: var(--ink-2); border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 1px 6px; }
.dt-thru.on { color: var(--warn); border-color: color-mix(in oklch, var(--warn), transparent 62%); }
.ask-bar { display: flex; gap: 8px; align-items: center; padding: 7px 10px; background: var(--bg-canvas); border: 1px solid var(--rule-strong); border-radius: var(--r-md); color: var(--ink-2); }
.ask-bar:focus-within { border-color: var(--ok); }
.ask-bar input { flex: 1; min-width: 0; background: transparent; border: none; color: var(--ink); font: inherit; font-size: 12.5px; outline: none; }
.ask-who { display: inline-flex; gap: 5px; align-items: center; font-size: 11px; color: var(--ink-3); white-space: nowrap; }
.ib-new.primary { display: inline-flex; gap: 6px; align-items: center; }
.composer { width: 560px; }
.composer h2 svg { color: var(--ok); }
.composer > .form-hint { margin: 8px 0 12px; }
.cmp-box textarea { width: 100%; min-height: 108px; resize: vertical; background: var(--bg-canvas); border: 1px solid var(--rule-strong); border-radius: var(--r-md); color: var(--ink); font: inherit; font-size: 13px; line-height: 1.5; padding: 10px 12px; }
.cmp-box textarea:focus { outline: none; border-color: var(--ok); }
.cmp-ideas { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 10px 0 14px; font-size: 11px; }
.cmp-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.cmp-secrets { display: flex; gap: 8px; align-items: center; font-size: 11px; padding-top: 6px; }
.cmp-blank { color: var(--ink-2); }
.proposal.draft { border-left-color: var(--ok); max-width: none; }
.proposal.draft .pr-kind { color: var(--ok); }
.seg { display: inline-flex; padding: 2px; background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-md); justify-self: start; }
.seg button { padding: 4px 12px; font: inherit; font-size: 11px; color: var(--ink-2); background: transparent; border: 1px solid transparent; border-radius: var(--r-sm); cursor: pointer; }
.seg button.on { background: var(--bg-3); color: var(--ink); border-color: var(--rule-strong); }
.af { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--rule-soft); border-radius: var(--r-md); background: var(--bg); }
.af-sec { font: 600 10px var(--font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); margin-top: 4px; }
.af-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.af-grid .form-row { margin: 0; }
.af-tags { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; padding-top: 4px; }
.af-line, .af-step { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-size: 12px; color: var(--ink-1); }
.af-line > svg { color: var(--ink-2); }
.af-step { padding: 7px 9px; border: 1px solid var(--rule); border-radius: var(--r-md); }
.af-pill { font: 11px var(--font-mono); color: var(--ink); background: var(--bg-3); border: 1px solid var(--rule-strong); border-radius: var(--r-sm); padding: 2px 7px; }
.ib-pre.yaml { font-size: 11px; line-height: 1.6; }
.opt-grid.two.top { align-items: start; }
.lo-review { width: 540px; max-height: 820px; overflow: auto; }
.lo-auto { display: grid !important; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; }
.lo-check input { margin: 0; accent-color: var(--ok); }
.lo-main { display: grid; gap: 4px; min-width: 0; }
.lo-name { display: flex; gap: 6px; align-items: center; }
.lo-name svg { color: var(--info); flex: none; }
.lo-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-size: 11px; color: var(--ink-2); }
.lo-badge { font: 10px var(--font-mono); color: var(--ink-2); border: 1px solid var(--rule); border-radius: var(--r-sm); padding: 0 5px; }
.lo-badge.mod { color: var(--warn); border-color: color-mix(in oklch, var(--warn), transparent 60%); }
.lo-badge.new { color: var(--ok); border-color: var(--c2-soft); }
.lo-auto.blocked .lo-main { opacity: .7; }
.secret.miss { color: var(--danger); border-color: color-mix(in oklch, var(--danger), transparent 55%); }
.lo-hint { font-size: 11px; color: var(--ink-3); }
.lo-diff { font-size: 11px; color: var(--ink-1); }
.lo-diff .add, .ib-pre .add { color: var(--ok); }
.lo-choice { display: flex; gap: 4px; }
.lo-choice .btn-mini.on { border-color: var(--c2-soft); color: var(--ok); background: var(--c2-tint); }
.lo-solo { display: flex; justify-content: center; padding: 8px 0; }
.lo-solo .lo-review { box-shadow: var(--shadow-lg); max-height: none; }
.lo-prov { display: grid; gap: 10px; justify-items: end; }
.origin { width: 100%; display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-size: 12px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg); }
.origin > svg { color: var(--info); }
.edit-menu { position: static; width: 230px; animation: none; }
.ask-btn { display: inline-flex; gap: 6px; align-items: center; }
.ask-btn svg { color: var(--ok); }
.ask-btn.on { background: var(--bg-3); border-color: var(--rule-strong); color: var(--ink); }
.lr-foot { display: flex; gap: 8px; align-items: center; }
.disc-wrap { display: grid; grid-template-columns: 520px 440px; gap: 0; max-height: 840px; border-radius: var(--r-lg); box-shadow: 0 18px 60px rgba(0,0,0,.5); }
.disc-wrap .lo-review { width: auto; border-radius: var(--r-lg) 0 0 var(--r-lg); box-shadow: none; max-height: 840px; }
.disc { display: flex; flex-direction: column; min-height: 0; max-height: 840px; background: var(--bg-1); border: 1px solid var(--rule); border-left: none; border-radius: 0 var(--r-lg) var(--r-lg) 0; }
.disc-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 14px 16px 10px; border-bottom: 1px solid var(--rule); }
.disc-head .eyebrow { display: inline-flex; gap: 6px; align-items: center; }
.disc-head .eyebrow svg { color: var(--ok); }
.disc-where { display: inline-flex; gap: 5px; align-items: center; font-size: 11px; color: var(--ink-3); }
.disc-head .ib-link { margin-left: auto; font-size: 11px; }
.disc-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; display: grid; gap: 10px; align-content: start; }
.disc-ctx { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; }
.msg { font-size: 12.5px; line-height: 1.5; color: var(--ink-1); }
.msg p { margin: 0 0 7px; }
.msg p:last-child { margin-bottom: 0; }
.msg b { color: var(--ink); }
.msg.claude { padding-left: 10px; border-left: 2px solid var(--c2-soft); }
.msg.you { justify-self: end; max-width: 85%; padding: 7px 11px; background: var(--bg-3); border: 1px solid var(--rule); border-radius: var(--r-md); color: var(--ink); }
.msg-actions { margin-top: 8px; }
.disc-in { margin: 0 16px; }
.disc-foot { margin: 8px 16px 14px; font-size: 11px; color: var(--ink-3); }
.ib-tab-sep { width: 1px; margin: 9px 4px; background: var(--rule-strong); flex: none; }
.ib-sess { max-width: 150px; }
.ib-tabs .ph-btn.on .dim { display: none; }
.ib-sess .session-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ib-tabs .session-tab.ib-sess.active { border-bottom-color: var(--ok); }
.ib-sess-new { align-self: center; }
.ib-term { flex: 1; min-height: 0; overflow: auto; background: var(--bg-canvas); padding: 14px 18px; }
.ib-term pre { margin: 0; font: 12.5px/1.55 var(--font-mono); color: var(--ink-1); white-space: pre; }
.ib-term b { color: var(--ink); }
.t-dim { color: var(--ink-3); } .t-ok { color: var(--ok); } .t-err { color: var(--danger); } .t-you { color: var(--ink); } .t-tool { color: var(--info); }
.t-code { color: var(--warn); } .t-prompt { color: var(--ink-2); } .t-cursor { background: var(--ink-1); }
.batch-list { list-style: none; margin: 0; padding: 0; display: grid; border: 1px solid var(--rule); border-radius: var(--r-md); }
.batch-list li { display: flex; flex-wrap: wrap; gap: 6px 9px; align-items: center; font-size: 12px; color: var(--ink-1); padding: 8px 10px; border-bottom: 1px solid var(--rule-soft); }
.batch-list li:last-child { border-bottom: none; }
.batch-list li > svg { color: var(--info); }
.batch-list li b { color: var(--ink); font-weight: 500; }
.batch-list li.needs { background: color-mix(in oklch, var(--wait), transparent 92%); }
.b-state { margin-left: auto; font: 10px var(--font-mono); padding: 1px 6px; border-radius: var(--r-sm); border: 1px solid var(--rule); }
.b-state.ok { color: var(--ok); border-color: var(--c2-soft); }
.b-state.wait { color: var(--wait); border-color: color-mix(in oklch, var(--wait), transparent 55%); }
.b-pick { display: flex; gap: 4px; }
.b-pick .btn-mini.on { border-color: var(--c2-soft); color: var(--ok); background: var(--c2-tint); }
.proposal.batch { max-width: none; }
@media (max-width: 860px) { .dk-split2 { grid-template-columns: 1fr; } }
@media (max-width: 860px) { .dk-split { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .variant { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

const html = `<title>Fleet Inbox Mocks</title>
<style>${appCss}</style>
<style>${pageCss}</style>
${svgDefs}<div class="doc">
  <header class="doc-head">
    <div class="doc-eyebrow"><span class="brand-tile">cf</span>claude-fleet · design review · Oct 19 2026</div>
    <h1>Inbox &amp; automations, screen by screen</h1>
    <p>Hi-fi mocks built from the app's real chrome. The tab strip, rails, terminal tabs, Settings and Edit-workspace modals are server-rendered from the actual React components on <code>origin/main</code> and styled by the app's own <code>styles.css</code>. Everything new uses only the existing design tokens. All data is example data.</p>
  </header>
  <nav class="doc-nav" aria-label="Screens">${screens.map((s, i) => `<a href="#${s.id}"><span>${i + 1}</span>${s.name}</a>`).join('')}</nav>
  ${screens.map((s, i) => `<section class="screen" id="${s.id}"><h2><span class="n">${String(i + 1).padStart(2, '0')}</span>${s.name}</h2>
    <div class="notes">${s.notes.map(([b, p]) => `<div class="note"><b>${b}</b><p>${p}</p></div>`).join('')}</div>
    ${s.extra || ''}${s.html}</section>`).join('\n')}
  <p class="doc-foot">Frames render at 1440×900 and scale to fit. Interactions aren't wired.</p>
</div>
<script>
(function(){
  function fit(){ document.querySelectorAll('.frame-wrap').forEach(function(w){
    var s = Math.min(1, w.clientWidth / 1440); var f = w.firstElementChild;
    f.style.transform = 'scale(' + s + ')'; w.style.height = (900 * s) + 'px'; }); }
  window.addEventListener('resize', fit); fit();
})();
</script>`;
fs.writeFileSync(here + 'fleet-inbox-mocks.html', html);
console.log('wrote', html.length);
