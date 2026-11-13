// The badge on a remote row: cloud glyph and workspace name in the workspace hue. Text nodes only.
import type { CSSProperties } from 'react';
import { colorFor } from '../App';

interface Props { name: string; hue: number | null; tier: string | null }

export function OriginBadge({ name, hue, tier }: Props) {
  const color = colorFor({ name, color: hue !== null ? { hue } : undefined });
  return (
    <span
      className="origin-badge"
      title={`From remote workspace ${name}${tier ? ` · your tier: ${tier}` : ''}`}
      style={{ '--hue': color } as CSSProperties}
    >
      <span aria-hidden="true">☁</span> {name}
    </span>
  );
}
