// Source guards for the remote Inbox components: host text is rendered as text
// nodes only, and remote drafting never reaches a host channel (D127).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(`src/renderer/src/components/${f}`, 'utf8');
const REMOTE = ['RemoteAutomationDetail.tsx', 'RemoteDraftCard.tsx', 'RemoteProposalCard.tsx', 'RemoteTodoDetail.tsx'];

describe('remote components', () => {
  it.each(REMOTE)('%s renders no Markdown and no raw HTML', (f) => {
    const s = src(f);
    expect(s).not.toMatch(/<Markdown\b|dangerouslySetInnerHTML|innerHTML/);
  });

  it('RunModal renders a remote parameter description as text', () => {
    expect(src('RunModal.tsx')).toMatch(/\{runWith \? p\.description : <Markdown/);
  });

  it('Copy as host config copies exactly the text the card shows', () => {
    const s = src('RemoteDraftCard.tsx');
    expect(s).toMatch(/const text = configEntryYaml\(d\.definition, d\.origin\);/);
    expect(s).toMatch(/clipboard\.write\(text\)/);
    expect(s).toMatch(/>\{text\}<\/pre>/);
  });

  it('remote drafting and Ask Claude to change go to the local drafting channel only', () => {
    const detail = src('RemoteAutomationDetail.tsx');
    const view = src('AutomationsView.tsx');
    for (const s of [detail, view]) expect(s).not.toMatch(/remoteAutomations\.(draft|askChange)/);
    expect(detail).toMatch(/window\.api\.automations\.draftRemote\(a\.origin, t, a\.id\)/);
    expect(view).toMatch(/window\.api\.automations\.draftRemote\(draftRemote\.id, t, null\)/);
  });

  it('Run now goes through useRemoteAction with a payload fingerprint', () => {
    expect(src('RemoteAutomationDetail.tsx')).toMatch(/act\.run\(runKey, stableFingerprint\(\{ id: a\.id, args: values \}\), \(rid\) => window\.api\.remoteAutomations\.run\(a\.origin, a\.id, values, rid\)\)/);
  });

  it('a host draft card copies exactly the YAML it shows and has no Approve', () => {
    const s = src('RemoteProposalCard.tsx');
    expect(s).toMatch(/const text = configEntryYaml\(it\.after, p\.origin\);/);
    expect(s).toMatch(/clipboard\.write\(text\)/);
    expect(s).toMatch(/>\{text\}<\/pre>/);
    expect(s).not.toMatch(/\.approve\(|>Approve</);
  });

  it('remote todo and proposal actions bind their request id to the payload', () => {
    expect(src('RemoteProposalCard.tsx')).toMatch(/act\.run\(key, stableFingerprint\(\{ id: p\.id, note: n \}\), \(rid\) => window\.api\.remoteProposals\.reject\(p\.origin, p\.id, n, rid\)\)/);
    expect(src('RemoteTodoDetail.tsx')).toMatch(/act\.run\(key\(what\), stableFingerprint\(\{ id: todo\.id, patch \}\), \(rid\) => window\.api\.remoteInbox\.update\(origin, todo\.id, patch, rid\)\)/);
    const inbox = src('InboxView.tsx');
    expect(inbox).toMatch(/todoAct\.run\(k, stableFingerprint\(\{ id: t\.id, status: next \}\), \(rid\) => window\.api\.remoteInbox\.update\(t\.origin, t\.id, \{ status: next \}, rid\)\)/);
    expect(inbox).toMatch(/todoAct\.run\(addKey, stableFingerprint\(input\), \(rid\) => window\.api\.remoteInbox\.create\(addTarget\.id, input, rid\)\)/);
  });

  it('the remote 🔔 maps like a remote notice: the workspace, the host key, no tags (D132)', () => {
    const inbox = src('InboxView.tsx');
    expect(inbox).toMatch(/source: \{ kind: 'workspace' as const, id: t\.origin \}, dedupeKey: t\.dedupeKey, tags: \[\]/);
    expect(inbox).toMatch(/item=\{\{ source: \{ kind: 'workspace', id: t\.origin \}, dedupeKey: t\.dedupeKey, tags: \[\], priority: t\.priority \}\}/);
  });

  it('the tray, taskbar and dock read local counts only (D137)', () => {
    const presence = readFileSync('src/main/inbox/presence.ts', 'utf8');
    expect(presence).not.toMatch(/remote|federat/i);
    expect(src('../App.tsx')).toMatch(/withRemoteCounts\(localCounts, remoteCounts\)/);
  });
});

describe('signed-out UI (D173)', () => {
  const read = (p: string) => readFileSync(`src/renderer/src/${p}`, 'utf8');

  it('the banner and panel render text only and sign in through identity:* only', () => {
    for (const f of ['components/SignedOutBanner.tsx', 'components/DeviceCodePanel.tsx', 'signInFlowInstance.ts']) {
      const s = read(f);
      expect(s).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect(s).not.toMatch(/\btoken\b/i);
    }
    expect(read('signInFlowInstance.ts').match(/window\.api\.[a-zA-Z]+/g)).toEqual(['window.api.identity', 'window.api.identity', 'window.api.identity']);
  });

  it('App subscribes before the snapshot, shows the banner from the pure helper and resets the flow when signed back in', () => {
    const app = read('App.tsx');
    expect(app.indexOf('window.api.remote.onAuth(')).toBeGreaterThan(-1);
    expect(app.indexOf('window.api.remote.onAuth(')).toBeLessThan(app.indexOf('window.api.remote.authState()'));
    expect(app).toMatch(/signedOutBanner\(remoteAuth, /);
    expect(app).toMatch(/if \(!remoteAuth\.signedOut\) signInFlow\.reset\(\)/);
    expect(app).toMatch(/<SignedOutBanner text=\{signedOutText\} \/>/);
  });

  it('the chip takes the block for remote workspaces only', () => {
    const s = read('components/WorkspaceTabStrip.tsx');
    expect(s).toMatch(/remoteChip\(w, drains\[w\.id\], w\.kind === 'remote' \? blockFor\(remoteAuth, w\.id\) : null\)/);
    expect(s).toMatch(/rc\?\.phase === 'signed-out' \? 'signed-out'/);
    expect(s).toMatch(/rc\?\.phase === 'no-access' \? 'no-access'/);
  });

  it('styles every class the banner, panel and chip phases use', () => {
    const css = read('styles.css');
    for (const c of ['.signed-out-banner', '.device-flow.inline', '.device-countdown', '.device-flow-error', '.device-flow-start', '.ws-chip-group.signed-out', '.ws-chip-group.no-access', '.session-ended-card.remote.wait']) {
      expect(css).toContain(c);
    }
  });
});
