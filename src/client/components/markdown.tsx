import { isValidElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { dateLocale } from '../../shared/i18n/i18n.ts'
import { MermaidBlock } from '../features/reports/report-page.tsx'
import { toDoc } from '../app/routes.ts'
import { htmlAsWords } from '../lib/html-words.ts'

const readableHref = (href: string) => {
  try {
    return decodeURI(href)
  } catch {
    return href
  }
}

export const when = (iso: string) => {
  const date = new Date(iso)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
}

/** Resolves a link inside a document against that document's folder. */
function resolveLink(from: string, href: string): string {
  const parts = from.split('/').slice(0, -1)
  for (const part of href.split('#')[0].split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part) parts.push(part)
  }
  return parts.join('/')
}

/** The anchor GitHub gives a heading, so a document's table of contents works here too. */
function anchorOf(children: ReactNode): string {
  const text = (node: ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    if (isValidElement(node)) return text((node.props as { children?: ReactNode }).children)
    return ''
  }
  return text(children)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

function Heading({ level, children }: { level: 1 | 2 | 3 | 4; children?: ReactNode }) {
  const Tag = `h${level}` as const
  return <Tag id={anchorOf(children)}>{children}</Tag>
}

/**
 * `fromGithub`: a body written on GitHub, where HTML is common (a bot's release notes, a template's comments). Each
 * piece of it reads as its words, rather than its tags shown as text. Nothing written anywhere is ever drawn as HTML.
 */
export function Markdown({ text, from, fromGithub }: { text: string; from?: string; fromGithub?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={fromGithub ? [remarkGfm, htmlAsWords] : [remarkGfm]}
      urlTransform={(url) => (/^(https?:|mailto:|doc:|#|\.|[\w-])/.test(url) && !/^(javascript|data|vbscript):/i.test(url) ? url : '')}
      components={{
        // Only the board's own images load: an address written in a message could carry its text away.
        img({ src = '', alt = '' }) {
          return typeof src === 'string' && src.startsWith('/api/threads/') ? <img src={src} alt={alt} /> : <span>{alt}</span>
        },
        h1: ({ children }) => <Heading level={1}>{children}</Heading>,
        h2: ({ children }) => <Heading level={2}>{children}</Heading>,
        h3: ({ children }) => <Heading level={3}>{children}</Heading>,
        h4: ({ children }) => <Heading level={4}>{children}</Heading>,
        a({ href = '', children }) {
          // An agent may link a file attached to the thread: that one downloads.
          const attached = href.match(/^doc:threads\/([^/]+)\/attachments\/([^/]+)$/)
          if (attached)
            return (
              <a href={`/api/threads/${attached[1]}/attachments/${attached[2]}`} download>
                {children}
              </a>
            )
          // Markdown has encoded this address already, and toDoc does it itself.
          if (href.startsWith('doc:')) return <a href={toDoc(readableHref(href.slice(4)))}>{children}</a>
          if (/^(https?:|mailto:)/.test(href))
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          // The address holds the route, so a link inside a page scrolls instead of changing it.
          if (href.startsWith('#'))
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault()
                  document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView()
                }}
              >
                {children}
              </a>
            )
          if (from && /\.(md|html)(#.*)?$/.test(href)) return <a href={toDoc(resolveLink(from, href))}>{children}</a>
          return <span>{children}</span>
        },
        // The charts of the coordinator's old reports. Everything else stays code.
        code({ className, children }) {
          return className === 'language-mermaid' ? <MermaidBlock source={String(children)} /> : <code className={className}>{children}</code>
        },
        pre({ children }) {
          // The element here is the one above, which draws its own block.
          return isValidElement(children) && (children.props as { className?: string }).className === 'language-mermaid' ? <>{children}</> : <pre>{children}</pre>
        },
        table({ children }) {
          return (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          )
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
