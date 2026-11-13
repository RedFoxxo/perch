// End-to-end check on a real Windows desktop (CI's windows-latest, or a colleague's PC):
// starts classic Notepad, drives it through perch's five tools, prints every answer and its time,
// and exits 1 at the first answer that is wrong. Run `npm run build` first.
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const server = join(import.meta.dirname, '..', 'build', 'index.js')
const client = new Client({ name: 'perch-e2e', version: '0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'inherit' }))

let failures = 0
async function tool(name, args = {}) {
  const started = performance.now()
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const images = r.content.filter((c) => c.type === 'image').length
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Math.round(performance.now() - started)} ms, ${text.length} chars${images ? `, ${images} image` : ''})${r.isError ? ' ERROR' : ''}\n${text}`)
  return { text, isError: Boolean(r.isError), images }
}
function check(ok, what) {
  console.log(`${ok ? 'ok' : 'FAIL'}: ${what}`)
  if (!ok) failures++
  return ok
}

const notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
notepad.unref()
try {
  const status = await tool('read_status')
  check(status.text.includes('✔ window list'), 'read_status lists windows')

  let id
  for (let i = 0; i < 20 && !id; i++) {
    const list = await tool('read_windows')
    id = /^(\d+) notepad /im.exec(list.text)?.[1]
    if (!id) await sleep(500)
  }
  if (!check(Boolean(id), 'read_windows shows Notepad')) throw new Error('no Notepad window')
  const window = Number(id)

  const tree = await tool('read_window', { window })
  const edit = /\[(e\d+) (?:edit|document)\b/.exec(tree.text)?.[1]
  if (!check(Boolean(edit), 'read_window shows the text field')) throw new Error('no text field')

  const typed = await tool('act_window', { window, steps: [{ type: 'perch was here' }], then: 'tree' })
  check(!typed.isError && typed.text.includes('perch was here'), 'background typing reaches the text field')

  const set = await tool('act_window', { window, steps: [{ set: edit, value: 'replaced' }], then: 'tree' })
  check(!set.isError && set.text.includes('= "replaced"'), 'set replaces the field value')

  const shot = await tool('read_screenshot', { window, max_edge: 800 })
  const size = /(\d+)×(\d+) px/.exec(shot.text)
  check(shot.images === 1 && size && Math.max(Number(size[1]), Number(size[2])) <= 800, 'window screenshot fits max_edge')

  const focused = await tool('act_window', {
    window,
    steps: [{ focus: true }, { key: 'ctrl+End', focused: true }, { type: ' and more', focused: true }],
    then: 'tree',
  })
  check(!focused.isError && focused.text.includes('replaced and more'), 'focused keys and typing land in the window')

  if (size) {
    const [w, h] = [Number(size[1]), Number(size[2])]
    const click = await tool('act_window', { window, steps: [{ focus: true }, { click: [Math.round(w / 2), Math.round(h / 2)] }], then: 'none' })
    check(!click.isError, 'a click at screenshot pixels is sent')
  }

  const screen = await tool('read_screenshot', { max_edge: 1024 })
  check(screen.images === 1, 'whole-screen screenshot')
} catch (error) {
  console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  failures++
} finally {
  spawnSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' })
  await client.close()
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
