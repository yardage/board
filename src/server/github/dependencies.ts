import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * What a ticket holds up, from the "## Depends on" lists in the copy of GitHub. Only numbers come out of those texts:
 * what people wrote there is information, and nothing in it is shown or followed.
 */

const SECTION = /^## Depends on\s*$/im
const NUMBER = /#(\d{1,7})\b/g
const FILE = /^(\d{1,7})\.md$/

/** The numbers listed under "## Depends on", up to the next heading. */
export function dependsOn(text: string): number[] {
  const start = SECTION.exec(text)
  if (!start) return []
  const rest = text.slice(start.index + start[0].length)
  const end = /^#{1,6}\s/m.exec(rest)
  return [...new Set([...(end ? rest.slice(0, end.index) : rest).matchAll(NUMBER)].map((match) => Number(match[1])))]
}

/** For each number, the open tickets waiting for it, in order. Only tickets still open have a file in the copy. */
export async function dependents(folder: string): Promise<Map<number, number[]>> {
  const found = new Map<number, number[]>()
  const names = await readdir(folder).catch(() => [] as string[])
  const numbered = names.flatMap((name) => {
    const number = FILE.exec(name)?.[1]
    return number ? [{ name, number: Number(number) }] : []
  })
  numbered.sort((a, b) => a.number - b.number)
  for (const { name, number } of numbered) {
    const text = await readFile(join(folder, name), 'utf8').catch(() => '')
    for (const needed of dependsOn(text)) {
      if (needed !== number) found.set(needed, [...(found.get(needed) ?? []), number])
    }
  }
  return found
}
