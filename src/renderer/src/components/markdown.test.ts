// The markdown renderer behind <Markdown>, rendered to static HTML in Node (no DOM needed).
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownRender from './MarkdownRender';

const html = (text: string, inline = false) => renderToStaticMarkup(createElement(MarkdownRender, { text, inline }));

describe('Markdown (block)', () => {
  it('renders GFM tables, lists and code', () => {
    const out = html('| Requested change | Fix | Result |\n|---|---|---|\n| a | b | ✅ |\n\n- one\n- two\n\n`x`');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>✅</td>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<code>x</code>');
  });

  it('keeps single newlines as line breaks, so plain-text bodies look the same', () => {
    expect(html('line one\nline two')).toContain('line one<br/>');
  });

  it('turns bare and markdown http(s) links into browser links', () => {
    const out = html('PR: https://github.com/o/r/pull/7 and [review](https://github.com/o/r/pull/7#r-1)');
    expect(out).toContain('<a class="md-link" href="https://github.com/o/r/pull/7" target="_blank" rel="noopener noreferrer">');
    expect(out).toContain('>review</a>');
  });

  it('never links other schemes', () => {
    for (const t of ['[x](javascript:alert(1))', '[x](file:///etc/passwd)', '[x](webexteams://im?space=1)']) {
      expect(html(t)).not.toContain('href=');
    }
  });

  it('drops raw HTML', () => {
    const out = html('hi <script>alert(1)</script><b onclick="x()">bold</b>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
  });

  it('never loads images; shows their alt text', () => {
    const out = html('![tracker](https://evil.test/pixel.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('[tracker]');
  });
});

describe('Markdown (inline)', () => {
  it('keeps emphasis, code and links but flattens block structure', () => {
    const out = html('# Title\n\n**bold** `code` [l](https://x.test)\n\n| a |\n|---|\n| b |', true);
    expect(out).not.toMatch(/<h1|<table|<p>/);
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('href="https://x.test"');
    expect(out).toContain('Title');
  });
});
