// App-wide signed-out banner with the inline device flow (D173).
import { DeviceCodePanel } from './DeviceCodePanel';

export function SignedOutBanner({ text }: { text: string }) {
  return (
    <div className="daemon-banner signed-out-banner" role="status">
      <span className="dot" aria-hidden="true" />
      <span className="signed-out-text">{text}</span>
      <DeviceCodePanel />
    </div>
  );
}
