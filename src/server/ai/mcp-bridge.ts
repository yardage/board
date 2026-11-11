import { createInterface } from 'node:readline'

/**
 * The agent's way to the board's tools: an MCP server on stdin and stdout, started by Claude Code or Codex for one
 * run, that only passes each call to the board app on 127.0.0.1 with that run's token. It decides
 * nothing: the app checks every call against the environment and its owner's policy (tools.ts).
 */

const PROTOCOL = '2025-06-18'

export async function runBridge(env: NodeJS.ProcessEnv = process.env, input = process.stdin, output = process.stdout): Promise<void> {
  const url = env.BOARD_TOOLS_URL ?? ''
  const run = env.BOARD_TOOLS_RUN ?? ''
  const token = env.BOARD_TOOLS_TOKEN ?? ''
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !/^[0-9a-f]{16,64}$/.test(run) || !token) throw new Error('This bridge is started by the board, for one run of an agent.')
  const ask = async (path: string, body?: unknown) => {
    const answer = await fetch(`${url}/api/tools/${run}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-board': '1', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const found = await answer.json().catch(() => ({}))
    if (!answer.ok) throw new Error(found?.error ?? `HTTP ${answer.status}`)
    return found
  }
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`)
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let request: any
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    const { id, method, params } = request ?? {}
    // A notification needs no answer.
    if (id === undefined || id === null) continue
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: { protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'board', version: '1' } } })
      } else if (method === 'tools/list') {
        const { tools } = await ask('')
        send({ jsonrpc: '2.0', id, result: { tools } })
      } else if (method === 'tools/call') {
        const result = await ask('/call', { name: params?.name, arguments: params?.arguments ?? {} })
        const image = result.image && typeof result.image.data === 'string' && typeof result.image.mimeType === 'string' ? [{ type: 'image', data: result.image.data, mimeType: result.image.mimeType }] : []
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(result.text ?? '') }, ...image], isError: result.isError === true } })
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} })
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } })
      }
    } catch (error) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: (error as Error).message } })
    }
  }
}
