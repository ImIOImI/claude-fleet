import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalPane } from '/workspace/wt-inbox/src/renderer/src/components/TerminalPane';
import { SettingsModal } from '/workspace/wt-inbox/src/renderer/src/components/SettingsModal';
const noop = () => {};
const out = {
  term: renderToStaticMarkup(<TerminalPane workspaceId="a" containerId="ca" mirrorDefault={'off' as any} cleanupDefault={'preserve' as any} paused={false} visible={true} summary={null} onResume={noop} />),
  settings: renderToStaticMarkup(<SettingsModal onClose={noop} onSaved={noop} />),
};
console.log(JSON.stringify(out));
