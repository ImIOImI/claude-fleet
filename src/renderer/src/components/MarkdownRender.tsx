// Markdown for text fields written by automations, workspaces, loadout authors and registries (todo bodies,
// loadout instructions/descriptions, proposal rationales, descriptions). Most of that text is untrusted, so:
// raw HTML is dropped (skipHtml), only http(s) links survive (urlTransform) and open in the browser through
// the main window's setWindowOpenHandler, and images are never loaded (there is no CSP, so a remote image
// would be a tracking beacon); their alt text is shown instead. react-markdown builds React elements, so
// nothing reaches innerHTML.
//
// `block` (default) renders full GFM (tables, lists, code, autolinked URLs) with single newlines kept as line
// breaks, so existing plain-text bodies look the same. `inline` is for one-line fields in cards and lists:
// only emphasis, code, links and line breaks; anything else is flattened to its text.
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

const webOnly = (url: string): string => {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : '';
  } catch {
    return '';
  }
};

const components: Components = {
  a: ({ href, children }) =>
    href ? <a className="md-link" href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => (alt ? <span className="md-img-alt">[{alt}]</span> : null)
};

const INLINE_ELEMENTS = ['p', 'strong', 'em', 'del', 'code', 'a', 'br'];
const inlineComponents: Components = { ...components, p: ({ children }) => <>{children}</> };

export default function MarkdownRender({ text, inline = false, className }: { text: string; inline?: boolean; className?: string }) {
  const md = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      skipHtml
      urlTransform={webOnly}
      components={inline ? inlineComponents : components}
      {...(inline ? { allowedElements: INLINE_ELEMENTS, unwrapDisallowed: true } : {})}
    >
      {text}
    </ReactMarkdown>
  );
  return inline
    ? <span className={className ? `md md-inline ${className}` : 'md md-inline'}>{md}</span>
    : <div className={className ? `md ${className}` : 'md'}>{md}</div>;
}
