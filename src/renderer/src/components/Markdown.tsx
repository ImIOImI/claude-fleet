// <Markdown text inline? className?>: markdown for text fields (see MarkdownRender.tsx for the rules and why).
// The renderer and its remark/micromark dependencies (~370 KB) load in a separate chunk on first use, so they
// don't weigh on startup; until then the text shows as plain text in the same wrapper.
import { lazy, Suspense } from 'react';

const MarkdownRender = lazy(() => import('./MarkdownRender'));

export function Markdown(props: { text: string; inline?: boolean; className?: string }) {
  const cls = props.inline ? `md md-inline${props.className ? ` ${props.className}` : ''}` : `md${props.className ? ` ${props.className}` : ''}`;
  const plain = props.inline
    ? <span className={cls}>{props.text}</span>
    : <div className={cls} style={{ whiteSpace: 'pre-wrap' }}>{props.text}</div>;
  return <Suspense fallback={plain}><MarkdownRender {...props} /></Suspense>;
}
