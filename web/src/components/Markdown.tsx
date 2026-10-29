import { memo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { openExternal } from '../lib/api';

function CodeBlock({ children, ...rest }: ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  let lang = '';
  const child = Array.isArray(children) ? children[0] : children;
  const cls = (child as { props?: { className?: string } })?.props?.className ?? '';
  const m = /language-([\w+#-]+)/.exec(cls);
  if (m) lang = m[1];
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'text'}</span>
        <button
          className="code-copy"
          onClick={async () => {
            await navigator.clipboard.writeText(ref.current?.innerText ?? '');
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  );
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!href || href.startsWith('#')) return;
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

const remark = [remarkGfm, remarkMath];
const rehype = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
  [rehypeHighlight, { detect: false }],
] as ComponentProps<typeof ReactMarkdown>['rehypePlugins'];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remark} rehypePlugins={rehype} components={{ pre: CodeBlock, a: Link }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
