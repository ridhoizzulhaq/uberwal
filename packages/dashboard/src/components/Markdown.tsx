"use client";

/**
 * Markdown — renders model/assistant output as formatted content instead of
 * raw markdown text.
 *
 * The Reader Agent often replies with markdown (tables, bold, lists, headings).
 * Rendering it verbatim showed raw `|`, `**`, and `#` characters; this
 * component parses it with `react-markdown` + GFM (for tables/strikethrough)
 * and styles each element to the minimalist warm-monochrome theme via a
 * `components` override map — no Tailwind typography plugin needed.
 *
 * Safety: `react-markdown` does NOT render raw HTML by default, so model output
 * cannot inject markup. Links are forced to `rel="noopener noreferrer"`.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const COMPONENTS: Components = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-ink underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="flex list-disc flex-col gap-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="flex list-decimal flex-col gap-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="font-serif text-base font-semibold tracking-tight text-ink">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-serif text-base font-semibold tracking-tight text-ink">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-serif text-sm font-semibold tracking-tight text-ink">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted">{children}</blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[12px] text-ink">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md border border-border bg-canvas p-3 font-mono text-[12px] text-ink">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-canvas px-2 py-1 font-semibold text-ink">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1 align-top text-ink">{children}</td>
  ),
  hr: () => <hr className="border-border" />,
};

export interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
