// Host-supplied text: React text nodes only; an avatar loads only from GitHub's avatar host (D120).
import { githubAvatarUrl, ownerLabel, type SessionOwner } from '../../../preload/sessionOwner';

/** First letter or digit by code point, so never half a surrogate pair or a lone combining mark. */
export function ownerInitial(label: string): string {
  return label.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '?';
}

export function OwnerBadge({ owner }: { owner: SessionOwner }) {
  const avatar = githubAvatarUrl(owner.avatarUrl);
  const label = ownerLabel(owner);
  const handle = owner.kind === 'automation' ? null : `@${owner.login}`;
  return (
    <span className={`owner-badge owner-${owner.kind}`} title={handle && owner.name ? `${owner.name} ${handle}` : label}>
      {avatar ? (
        <img className="owner-avatar" src={avatar} alt="" width={14} height={14} referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        <span className="owner-avatar owner-initial" aria-hidden="true">
          {ownerInitial(label)}
        </span>
      )}
      {owner.kind === 'automation' ? <span className="owner-name">automation</span> : owner.name && <span className="owner-name">{owner.name}</span>}
      {handle && <span className="owner-login">{handle}</span>}
    </span>
  );
}
