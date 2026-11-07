export function CloudGlyph({ title }: { title: string }): JSX.Element {
  return (
    <svg className="remote-glyph" width={14} height={14} viewBox="0 0 16 16" aria-hidden={!title}>
      <title>{title}</title>
      <path
        d="M4.5 12.5h7a3 3 0 00.4-5.97A4 4 0 004.3 7.1 2.7 2.7 0 004.5 12.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}
