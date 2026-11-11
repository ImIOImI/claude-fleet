// Pure: the host, main and the renderer import it. Owner text is host-supplied, so every reader re-validates.

export type OwnerKind = 'user' | 'machine' | 'automation' | 'publisher';

export interface SessionOwner {
  kind: OwnerKind;
  /** 'github', or 'fleet-host' for automation runs. */
  provider: string;
  /** The provider's account id as decimal text; the hosted workspace id for automation runs. */
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface OwnerCostRow {
  /** null: sessions with no recorded owner. */
  owner: SessionOwner | null;
  sessions: number;
  usd: number;
}

/** The signed-in identity, for Mine. */
export interface Me { provider: string; id: number }

export const MAX_OWNER_COST_ROWS = 100;
export const MAX_OWNER_NAME = 64;
export const AUTOMATION_PROVIDER = 'fleet-host';
export const AUTOMATION_LOGIN = 'automation';

/** No leading hyphen, so a login is never read as an option. */
export const OWNER_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
export const BOT_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]$/;
const ACCOUNT_ID_RE = /^[1-9][0-9]{0,19}$/;
const WORKSPACE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// An exact match, not URL parsing: no userinfo, port, other path or extra query can pass.
const AVATAR_RE = /^https:\/\/avatars\.githubusercontent\.com\/u\/[1-9][0-9]{0,19}(?:\?v=[0-9]{1,4})?$/;
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
// Default_Ignorable also covers the Hangul fillers, which are letters that render as nothing.
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const VISIBLE_RE = /[\p{L}\p{N}]/u;
const KINDS: ReadonlySet<string> = new Set(['user', 'machine', 'automation', 'publisher']);

export function githubAvatarUrl(raw: unknown): string | null {
  return typeof raw === 'string' && AVATAR_RE.test(raw) ? raw : null;
}

export function ownerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').replace(INVISIBLE_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/gu, ' ').trim();
  const capped = Array.from(s).slice(0, MAX_OWNER_NAME).join('').trim();
  return VISIBLE_RE.test(capped) ? capped : null;
}

export function parseSessionOwner(v: unknown): SessionOwner | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;
  if (typeof o.provider !== 'string' || typeof o.id !== 'string' || typeof o.login !== 'string') return null;
  const kind = o.kind as OwnerKind;
  if (kind === 'automation') {
    if (o.provider !== AUTOMATION_PROVIDER || !WORKSPACE_ID_RE.test(o.id) || o.login !== AUTOMATION_LOGIN) return null;
    return { kind, provider: AUTOMATION_PROVIDER, id: o.id, login: AUTOMATION_LOGIN, name: null, avatarUrl: null };
  }
  if (o.provider !== 'github' || !ACCOUNT_ID_RE.test(o.id)) return null;
  const loginOk = OWNER_LOGIN_RE.test(o.login) || (kind === 'machine' && BOT_LOGIN_RE.test(o.login));
  if (!loginOk) return null;
  return { kind, provider: 'github', id: o.id, login: o.login, name: ownerName(o.name), avatarUrl: githubAvatarUrl(o.avatarUrl) };
}

export function isMine(owner: SessionOwner | null | undefined, me: Me | null): boolean {
  return !!owner && !!me && owner.kind === 'user' && owner.provider === me.provider && owner.id === String(me.id);
}

export function ownerLabel(o: SessionOwner): string {
  if (o.kind === 'automation') return 'automation';
  return o.name ?? `@${o.login}`;
}
