/**
 * The tabs at the top of a list in the sidebar: threads, polls, what waits for an answer. Each is a word and, when
 * there is one, a count beside it; the one shown is underlined. One look wherever a list is filtered.
 */
export interface SideTab<T extends string> {
  id: T
  label: string
  /** Left out when there is nothing to count. */
  count?: number
}

export function SideTabs<T extends string>({ tabs, value, onPick, label }: { tabs: SideTab<T>[]; value: T; onPick: (id: T) => void; label: string }) {
  return (
    <div className="side-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" aria-selected={value === tab.id} className={value === tab.id ? 'on' : ''} onClick={() => onPick(tab.id)}>
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && <small>{tab.count}</small>}
        </button>
      ))}
    </div>
  )
}
