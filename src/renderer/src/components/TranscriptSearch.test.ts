// Static render in Node (no DOM): what a host's search reply can and can't put on screen.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TranscriptHits, TranscriptSearch } from './TranscriptSearch';
import type { FederatedSearchResult, SearchHitItem } from '../../../preload/federation';

const hit = (over: Partial<SearchHitItem> = {}): SearchHitItem => ({
  origin: 'local', sessionId: 's1', workspaceId: 'W', workspaceName: 'mine', kind: 'turn', ts: null, text: 'hello', score: 0.8312, ...over,
});
const hits = (result: FederatedSearchResult) => renderToStaticMarkup(createElement(TranscriptHits, { result, onPick: () => undefined }));

describe('TranscriptHits', () => {
  it('renders host text as text, never markup', () => {
    const out = hits({ hits: [hit({ origin: 'R1', workspaceName: '<b>bot</b>', text: '<img src=x onerror="alert(1)">\nline 2' })], unavailable: [] });
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;\nline 2');
    expect(out).toContain('&lt;b&gt;bot&lt;/b&gt;');
  });

  it('marks remote hits with the cloud glyph, local ones without, and shows the score to two places', () => {
    const out = hits({ hits: [hit(), hit({ origin: 'R1', sessionId: 's2', workspaceName: 'review-bot' })], unavailable: [] });
    expect(out.match(/remote-glyph/g)).toHaveLength(1);
    expect(out).toContain('Remote · review-bot');
    expect(out).toContain('(0.83)');
    expect(out.match(/class="hit-text"/g)).toHaveLength(2);
  });

  it('says which sources were left out and why', () => {
    const out = hits({ hits: [], unavailable: [{ origin: 'R1', name: 'review-bot', reason: 'disabled' }] });
    expect(out).toContain('1 source unavailable: review-bot (search off)');
    expect(out).not.toContain('transcript-hits');
  });
});

describe('TranscriptSearch', () => {
  it('names who receives the query, and is inert with no target', () => {
    const on = renderToStaticMarkup(createElement(TranscriptSearch, { target: { scope: 'all', label: 'Searching this desktop + review-bot' }, onPick: () => undefined }));
    expect(on).toContain('Searching this desktop + review-bot');
    expect(on).toContain('aria-label="Search transcripts"');
    expect(on).toContain('placeholder="Search transcript content…"');
    const off = renderToStaticMarkup(createElement(TranscriptSearch, { target: null, onPick: () => undefined }));
    expect(off).toContain('Select a workspace to search its transcripts');
    expect(off).toMatch(/<input[^>]*disabled/);
  });
});
