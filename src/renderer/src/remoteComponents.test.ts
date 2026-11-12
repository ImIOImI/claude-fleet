// Source guards for the remote Inbox components: host text is rendered as text
// nodes only, and remote drafting never reaches a host channel (D127).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(`src/renderer/src/components/${f}`, 'utf8');
const REMOTE = ['RemoteAutomationDetail.tsx', 'RemoteDraftCard.tsx'];

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
});
