import { renderToStaticMarkup } from 'react-dom/server';
import { EditWorkspaceModal } from '/workspace/wt-inbox/src/renderer/src/components/EditWorkspaceModal';
const noop = () => {};
const w = { id:'c', name:'webex-triage', labels:[], color:{hue:45}, containerId:'cc', state:'running', workspaceRoot:'/w', workspaceSubdir:'c', kind:'container', authMode:'oauth', env:{}, mirror:{default:'off',cleanup:'preserve'}, image:'ghcr.io/imioimi/claude-fleet/runner:latest' };
console.log(JSON.stringify({ edit: renderToStaticMarkup(<EditWorkspaceModal workspace={w as any} workspaces={[w as any]} vaultAvailable={true} onClose={noop} onSave={noop as any} onClone={noop as any} onDeleted={noop} onOpenSettings={noop} />) }));
