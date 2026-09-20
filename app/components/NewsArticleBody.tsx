import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function NewsArticleBody({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children }) => (
          <h2 className="mt-12 text-3xl font-bold text-white">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mt-10 text-2xl font-bold text-white">{children}</h3>
        ),
        p: ({ children }) => (
          <p className="mt-6 leading-8 text-gray-300">{children}</p>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 underline decoration-blue-400/40 underline-offset-4 hover:text-blue-300"
          >
            {children}
          </a>
        ),
        ul: ({ children }) => (
          <ul className="mt-6 list-disc space-y-3 pl-6 text-gray-300">{children}</ul>
        ),
        li: ({ children }) => <li className="leading-8">{children}</li>,
        code: ({ children }) => (
          <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-blue-200">
            {children}
          </code>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
