// Transcript search (remote-workspaces d2): one query, embedded once in main,
// sent as a vector to the hosts in scope only (D67). Results live in this
// component's state only; remote text renders as React text nodes.

import { useEffect, useRef, useState } from 'react';
import { LOCAL_ORIGIN, type FederatedSearchResult, type SearchHitItem } from '../../../preload/federation';
import { relativeTime, searchUnavailableText } from '../sessionsView';
import { CloudGlyph } from './CloudGlyph';

interface Props {
  /** null: nothing to search (no workspace selected). */
  target: { scope: 'all' | string; label: string } | null;
  onPick: (hit: SearchHitItem) => void;
}

export function TranscriptSearch({ target, onPick }: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FederatedSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const scope = target?.scope ?? null;

  useEffect(() => {
    seq.current++;
    setResult(null);
    setError(null);
    setRunning(false);
  }, [scope]);

  // Enter only, never per keystroke: each search embeds and fans out.
  const submit = async (): Promise<void> => {
    const q = query.trim();
    if (!q || !scope) return;
    const mine = ++seq.current;
    setRunning(true);
    setError(null);
    try {
      const r = await window.api.history.search(q, { scope });
      if (mine === seq.current) setResult(r);
    } catch (e) {
      if (mine === seq.current) {
        setResult(null);
        setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      }
    } finally {
      if (mine === seq.current) setRunning(false);
    }
  };

  return (
    <div className="transcript-search">
      <form
        className="transcript-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="search"
          className="sessions-search"
          placeholder="Search transcript content…"
          aria-label="Search transcripts"
          value={query}
          maxLength={2000}
          disabled={!target}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn-mini" disabled={!target || running || !query.trim()}>
          Search
        </button>
      </form>
      <div className="transcript-search-target subdued">{target ? target.label : 'Select a workspace to search its transcripts'}</div>
      {running && <div className="transcript-search-status subdued">Searching…</div>}
      {error && <div className="transcript-search-error">{error}</div>}
      {result && !running && result.hits.length === 0 && <div className="transcript-search-status subdued">No matches</div>}
      {result && <TranscriptHits result={result} onPick={onPick} />}
    </div>
  );
}

/** Hits and unavailable sources; host text only ever as text nodes. */
export function TranscriptHits({ result, onPick }: { result: FederatedSearchResult; onPick: (hit: SearchHitItem) => void }): JSX.Element {
  const unavailableNote = searchUnavailableText(result.unavailable);
  return (
    <>
      {result.hits.length > 0 && (
        <ul className="transcript-hits">
          {result.hits.map((hit, i) => (
            <li key={`${hit.origin}:${hit.sessionId}:${hit.ts ?? ''}:${i}`}>
              <button className="transcript-hit" title="Show this session" onClick={() => onPick(hit)}>
                <span className="transcript-hit-meta">
                  {hit.origin !== LOCAL_ORIGIN && <CloudGlyph title={`Remote · ${hit.workspaceName}`} />}
                  <span className="transcript-hit-ws">{hit.workspaceName}</span>
                  {hit.ts != null && <span className="session-row-time">{relativeTime(hit.ts)}</span>}
                  <span className="transcript-hit-score">({hit.score.toFixed(2)})</span>
                </span>
                <span className="hit-text">{hit.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {unavailableNote && <div className="sessions-unavailable subdued">{unavailableNote}</div>}
    </>
  );
}
