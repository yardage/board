import { createContext, useEffect, useState } from 'react'
import type { TreeNode } from '../../lib/types.ts'
import { localize } from '../../../shared/i18n/i18n.ts'
import { toDoc } from '../../app/routes.ts'

/** The knowledge's folders and documents, for the sidebar and for the composer's document picker. */
export const TreeContext = createContext<TreeNode[]>([])

export function Tree({ nodes, current, depth = 0 }: { nodes: TreeNode[]; current: string; depth?: number }) {
  return (
    <ul className="tree">
      {nodes.map((node) =>
        node.children ? (
          <Folder key={node.name} node={node} current={current} depth={depth} />
        ) : (
          <li key={node.path}>
            <a href={toDoc(node.path)} className={node.path === current ? 'active' : ''} style={{ paddingLeft: 12 + depth * 14 }}>
              <svg viewBox="0 0 12 14" width="10" height="12" aria-hidden>
                <path d="M1.5 1h6L11 4.5V13H1.5z" fill="none" stroke="currentColor" />
              </svg>
              {localize(node.name.replace(/\.md$/, ''))}
            </a>
          </li>
        ),
      )}
    </ul>
  )
}

const holds = (node: TreeNode, path: string): boolean =>
  node.path === path || (node.children ?? []).some((child) => holds(child, path))

function Folder({ node, current, depth }: { node: TreeNode; current: string; depth: number }) {
  const contains = holds(node, current)
  const [open, setOpen] = useState(depth === 0 || contains)
  useEffect(() => {
    if (contains) setOpen(true)
  }, [contains])
  return (
    <li>
      <button type="button" className={`folder ${depth === 0 ? 'top' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className={open ? 'open' : ''} viewBox="0 0 10 10" width="9" height="9" aria-hidden>
          <path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        {localize(node.name)}
      </button>
      {open && <Tree nodes={node.children ?? []} current={current} depth={depth + 1} />}
    </li>
  )
}
