interface Props {
  vaultAvailable: boolean | null;
}

export function BottomBar({ vaultAvailable }: Props) {
  return (
    <div className="bottom-bar">
      <span><span className="key">Ctrl+C</span> copy / SIGINT</span>
      <span><span className="key">Ctrl+V</span> paste</span>
      <span><span className="key">Ctrl+Shift+C/V</span> explicit copy / paste</span>
      <span className="spacer" />
      {vaultAvailable === false && (
        <span style={{ color: 'var(--warn)' }}>
          OS keychain unavailable · env-var fallback active
        </span>
      )}
    </div>
  );
}
