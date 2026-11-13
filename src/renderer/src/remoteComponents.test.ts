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
