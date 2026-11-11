import { createContext, type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'

/**
 * The part of the sidebar under the categories. Threads and knowledge fill it themselves; a page that has a list of its
 * own (what waits for an answer, the reports, the parts of the settings) draws it here instead, so that the page only holds
 * what is read. The list stays in the page's own component, which keeps the state it is made of.
 */
export const SideSlot = createContext<HTMLElement | null>(null)

export function SideList({ children }: { children: ReactNode }) {
  const slot = useContext(SideSlot)
  return slot ? createPortal(children, slot) : null
}
