import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceTabStrip } from '/workspace/wt-inbox/src/renderer/src/components/WorkspaceTabStrip';
import { LeftRail } from '/workspace/wt-inbox/src/renderer/src/components/LeftRail';
import { ObservabilityPane } from '/workspace/wt-inbox/src/renderer/src/components/ObservabilityPane';
import { BottomBar } from '/workspace/wt-inbox/src/renderer/src/components/BottomBar';
const now = Date.now();
const mk = (id, name, hue, state='running', extra={}) => ({ id, name, labels: [], color:{hue}, containerId: 'c'+id, state, workspaceRoot:'/w', workspaceSubdir:id, kind:'container', authMode:'oauth', env:{}, mirror:{default:false,cleanup:false}, ...extra });
const ws = [
  mk('a','claude-fleet',250),
  mk('b','ops-oncall',145),
  mk('c','webex-triage',45),
  mk('d','iac-review',300,'paused'),
];
const sum = (title, usd) => ({ sessionId:'s1', title, model:'claude-opus-5-5', startedAt: now-3600e3, lastActiveAt: now-120e3, eventCount: 412, inputTokens: 120000, outputTokens: 34000, cacheReadInputTokens: 900000, cacheCreationInputTokens: 50000, usd, lastTurnContextTokens: 86000, contextWindowTokens: 1000000, topTools:[{name:'Bash',count:41},{name:'Edit',count:18},{name:'Read',count:33}], recentToolCalls: [] });
const summaries = { a: sum('Inbox & automations design', 4.12), b: sum('Check prod error budget', 1.03), c: sum('Triage #ops-alerts', 0.61), d: null };
const noop = () => {};
const out = {
  tabs: renderToStaticMarkup(<WorkspaceTabStrip workspaces={ws} summaries={summaries} busyByWorkspace={{a:true}} selectedId="a" backendReady={true} mockMode={false} onSelect={noop} onNewWorkspace={noop} onOpenSettings={noop} onCloseWorkspace={noop} onEditWorkspace={noop} onCloneWorkspace={noop} onDeleteWorkspace={noop} onRefresh={noop} onReorderWorkspace={noop} waitingByWorkspace={{c:true}} />),
  left: renderToStaticMarkup(<LeftRail workspaces={ws} selectedWorkspaceId="a" selectedWorkspace={ws[0]} busySessionIds={new Set()} collapsed={false} onToggleCollapse={noop} onResume={noop} onChanged={noop} />),
  obs: renderToStaticMarkup(<ObservabilityPane workspaceName="claude-fleet" summary={summaries.a} workspace={ws[0]} sharedDir="/shared" workspaces={ws} summaries={summaries} terminals={[{id:'t1',name:'main',contextTokens:86000,windowTokens:1000000}]} activeTerminalId="t1" budget={null} budgetSpentTokens={0} collapsed={false} onToggleCollapse={noop} servingPorts={{}} onOpenPort={noop} onKillPort={noop} sessionNames={{}} onFocusSession={noop} />),
  bottom: renderToStaticMarkup(<BottomBar vaultAvailable={true} />),
};
console.log(JSON.stringify(out));
