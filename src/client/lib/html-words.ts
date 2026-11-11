/**
 * A body written on GitHub often holds HTML: a bot's release notes in `<details>`, a template's `<!-- comments -->`, a
 * `<table>`. Nothing written anywhere is drawn as HTML here, so each piece of it becomes its words: comments go, tags
 * go, the text between them stays, and a block keeps its line breaks. Pure, so that it can be tested.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
/** Tags after which a line ends, so that a block's rows don't run into one line. */
const BREAKS = /<\/?(?:p|div|br|li|tr|table|thead|tbody|details|summary|h[1-6]|blockquote|pre|ul|ol)\b[^>]*>/gi

export function wordsOfHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(BREAKS, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16) || 32)
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)) || 32)
      return ENTITIES[name.toLowerCase()] ?? whole
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

interface Node {
  type: string
  value?: string
  children?: Node[]
}

/**
 * A remark plugin: every `html` node becomes its words. One inside a paragraph becomes text; one standing as a block
 * becomes a paragraph per run of lines, or nothing when it held no words.
 */
export function htmlAsWords() {
  const walk = (node: Node): void => {
    if (!node.children) return
    node.children = node.children.flatMap((child): Node[] => {
      if (child.type !== 'html') {
        walk(child)
        return [child]
      }
      const words = wordsOfHtml(child.value ?? '')
      if (node.type === 'root' || node.type === 'blockquote' || node.type === 'listItem') {
        return words
          .split(/\n{2,}/)
          .map((block) => block.trim())
          .filter(Boolean)
          .map((block) => ({ type: 'paragraph', children: [{ type: 'text', value: block }] }))
      }
      return words.trim() ? [{ type: 'text', value: words.replace(/\s*\n\s*/g, ' ') }] : []
    })
  }
  return (tree: Node) => walk(tree)
}
