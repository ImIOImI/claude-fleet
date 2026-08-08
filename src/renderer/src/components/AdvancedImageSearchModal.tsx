// Advanced image search modal — the magnifying-glass affordance next
// to the Image input in WorkspaceForm. Mirrors the Saved-workspaces
// Variant-B search shape: text input (matches ref + digest) + Tags
// dropdown filter (OR semantics) + active filter pills.
//
// Each row also surfaces which workspaces currently use the image —
// including stopped/deleted ones called out in warning color — so the
// user can spot when "pinning" a specific build will impact existing
// work.

import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceSummary } from '../App';
import { ModalBackdrop } from './ModalBackdrop';

export interface ImageEntry {
  ref: string;
  digest?: string;
  labels: Record<string, string>;
  firstUsedAt: number;
  lastUsedAt: number;
  useCount: number;
}

interface Props {
  open: boolean;
  library: ImageEntry[];
  workspaces: WorkspaceSummary[];
  /** Used to highlight the currently-selected image. */
  currentImage?: string;
  onPick: (ref: string) => void;
  onClose: () => void;
}

/** Parse the `:tag` suffix from an image ref. Defaults to "latest". */
export function parseTag(ref: string): string {
  // `:[tag]` at the end, with no `/` or `:` in the tag itself. Works
  // for both `image:tag` and `host/path/image:tag`; misses tag for
  // digest-pinned refs (`ref@sha256:…`), which fall back to 'latest'.
  const m = ref.match(/:([^/:]+)$/);
  return m ? m[1] : 'latest';
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function shortDigest(d: string | undefined): string {
  if (!d) return '';
  // Strip the algorithm prefix (sha256:…) and keep the first 12 hex chars.
  const colonIdx = d.indexOf(':');
  const hex = colonIdx >= 0 ? d.slice(colonIdx + 1) : d;
  return hex.slice(0, 12);
}

export function AdvancedImageSearchModal({
  open,
  library,
  workspaces,
  currentImage,
  onPick,
  onClose
}: Props) {
  const [searchText, setSearchText] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagsDropdownOpen, setTagsDropdownOpen] = useState(false);

  // Reset state each time the modal opens.
  useEffect(() => {
    if (open) {
      setSearchText('');
      setSelectedTags([]);
      setTagsDropdownOpen(false);
    }
  }, [open]);

  // Close the tags dropdown on outside-click / Escape.
  useEffect(() => {
    if (!tagsDropdownOpen) return;
    const close = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      setTagsDropdownOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, [tagsDropdownOpen]);

  // All tags in the library with usage counts. Sorted alphabetically;
  // `latest` is conventionally most common so it floats to the top by
  // count when shared.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const img of library) {
      const tag = parseTag(img.ref);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [library]);

  // Group workspaces by image ref so each row can show its consumers.
  const workspacesByImage = useMemo(() => {
    const m = new Map<string, WorkspaceSummary[]>();
    for (const w of workspaces) {
      if (!w.image) continue;
      const list = m.get(w.image) ?? [];
      list.push(w);
      m.set(w.image, list);
    }
    return m;
  }, [workspaces]);

  const filtered = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return library.filter((img) => {
      if (needle) {
        const hay = `${img.ref} ${img.digest ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (selectedTags.length > 0) {
        const tag = parseTag(img.ref);
        if (!selectedTags.includes(tag)) return false;
      }
      return true;
    });
  }, [library, searchText, selectedTags]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
    [filtered]
  );

  if (!open) return null;

  const toggleTag = (t: string): void =>
    setSelectedTags((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal modal-tabbed" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs" role="tablist">
          <div className="modal-tab active" aria-current="page">
            Image library
          </div>
          {library.length > 0 && (
            <span className="modal-tab-count" style={{ alignSelf: 'center' }}>
              {library.length}
            </span>
          )}
        </div>
        <div className="saved-tab" role="tabpanel">
          <div className="saved-search">
            <input
              type="text"
              aria-label="Search image library"
              placeholder="Search ref or digest…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <div className="labels-filter">
              <button
                type="button"
                className={`btn labels-button ${selectedTags.length ? 'active' : ''}`}
                aria-expanded={tagsDropdownOpen}
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  setTagsDropdownOpen((v) => !v);
                }}
                disabled={tagCounts.length === 0}
                title={tagCounts.length === 0 ? 'No tags yet' : 'Filter by tag'}
              >
                Tags
                {selectedTags.length > 0 && (
                  <span className="labels-count">{selectedTags.length}</span>
                )}
              </button>
              {tagsDropdownOpen && (
                <div
                  className="labels-dropdown"
                  role="menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  {tagCounts.map(([tag, count]) => (
                    <label key={tag} className="labels-dropdown-row">
                      <input
                        type="checkbox"
                        checked={selectedTags.includes(tag)}
                        onChange={() => toggleTag(tag)}
                      />
                      <span className="labels-dropdown-name">{tag}</span>
                      <span className="labels-dropdown-count">{count}</span>
                    </label>
                  ))}
                  {selectedTags.length > 0 && (
                    <div className="labels-dropdown-footer">
                      <button
                        type="button"
                        className="labels-dropdown-clear"
                        onClick={() => setSelectedTags([])}
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {(selectedTags.length > 0 || sorted.length !== library.length) && (
            <div className="saved-active-filters">
              {selectedTags.map((t) => (
                <span key={t} className="filter-pill">
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove tag filter ${t}`}
                    onClick={() => toggleTag(t)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <span className="saved-count">
                {sorted.length} of {library.length}
              </span>
            </div>
          )}

          {sorted.length === 0 ? (
            <div className="saved-empty">
              <p>
                {library.length === 0
                  ? 'No images recorded yet. The first workspace create populates the library.'
                  : 'No images match the current filter.'}
              </p>
            </div>
          ) : (
            <ul className="image-search-list">
              {sorted.map((img) => {
                const tag = parseTag(img.ref);
                const users = workspacesByImage.get(img.ref) ?? [];
                const isCurrent = img.ref === currentImage;
                return (
                  <li
                    key={img.ref}
                    className={`image-search-row ${isCurrent ? 'current' : ''}`}
                  >
                    <button
                      type="button"
                      className="image-search-row-button"
                      onClick={() => {
                        onPick(img.ref);
                        onClose();
                      }}
                      title={img.ref}
                    >
                      <div className="image-search-row-top">
                        <span className="image-search-ref">{img.ref}</span>
                        <span className="image-search-tag-chip">{tag}</span>
                      </div>
                      <div className="image-search-row-meta">
                        {img.digest && (
                          <span className="image-search-digest" title={img.digest}>
                            digest <code>{shortDigest(img.digest)}</code>
                          </span>
                        )}
                        <span className="image-search-when">
                          last used {relativeTime(img.lastUsedAt)}
                        </span>
                      </div>
                      {users.length > 0 && (
                        <div className="image-search-users">
                          used by{' '}
                          {users.map((w, i) => (
                            <span key={w.id}>
                              {i > 0 && ', '}
                              <span
                                className={`image-search-user ws-state ${w.state}`}
                                title={w.state}
                              >
                                {w.name}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}

export function IconSearch(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="5" cy="5" r="3.2" />
      <path d="M7.5 7.5 L10 10" strokeLinecap="round" />
    </svg>
  );
}
