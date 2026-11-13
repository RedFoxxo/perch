// End-to-end check on a real Windows desktop (CI's windows-latest, or a colleague's PC). It compiles
// a small WinForms test app with the C# compiler built into Windows, drives it and classic Notepad
// through perch's five tools, prints every answer and its time, and exits 1 if any check fails.
// Run `npm run build` first.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// A window with a click counter, a check box and a big button filling the rest; `fg <file>` writes
// the foreground window's handle to the file (a GUI program has no console to print to).
const APP = `
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
class PerchTest {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [STAThread] static void Main(string[] args) {
    if (args.Length > 1 && args[0] == "fg") { System.IO.File.WriteAllText(args[1], GetForegroundWindow().ToInt64().ToString()); return; }
    var form = new Form { Text = "perch test", Width = 500, Height = 400 };
    var count = 0;
    var status = new Label { Text = "clicks 0", Dock = DockStyle.Top, Height = 30 };
    var remember = new CheckBox { Text = "Remember", Dock = DockStyle.Top };
    var big = new Button { Text = "Big", Dock = DockStyle.Fill };
    big.Click += (s, e) => { count++; status.Text = "clicks " + count; };
    remember.CheckedChanged += (s, e) => { status.Text = remember.Checked ? "remembered" : "forgotten"; };
    form.Controls.Add(big);
    form.Controls.Add(remember);
    form.Controls.Add(status);
    Application.Run(form);
  }
}`

const dir = mkdtempSync(join(tmpdir(), 'perch-e2e-'))
const app = join(dir, 'perchtest.exe')
writeFileSync(join(dir, 'perchtest.cs'), APP)
const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const built = spawnSync(csc, ['/nologo', '/target:winexe', `/out:${app}`, join(dir, 'perchtest.cs')], { encoding: 'utf8' })
if (built.status !== 0) {
  console.log(`FAIL: could not compile the test app with ${csc}:\n${built.stdout}${built.stderr}`)
  process.exit(1)
}
const foreground = () => {
  const file = join(dir, 'fg.txt')
  spawnSync(app, ['fg', file])
  return readFileSync(file, 'utf8').trim()
}

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
async function findWindow(app) {
  for (let i = 0; i < 20; i++) {
    const list = await tool('read_windows')
    const id = new RegExp(`^(\\d+) ${app} `, 'im').exec(list.text)?.[1]
    if (id) return Number(id)
    await sleep(500)
  }
  throw new Error(`no ${app} window`)
}
const ref = (tree, pattern) => new RegExp(`\\[(e\\d+) ${pattern}`).exec(tree)?.[1]

spawn(app, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
try {
  const status = await tool('read_status')
  check(status.text.includes('✔ window list'), 'read_status lists windows')

  // --- The test app, behind Notepad: background steps must leave Notepad in front. ---
  const testApp = await findWindow('perchtest')
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
  const notepad = await findWindow('notepad')
  await sleep(1000)
  const front = foreground()
  check(front === String(notepad), `Notepad is in front before the background steps (foreground ${front})`)

  const tree = await tool('read_window', { window: testApp })
  const big = ref(tree.text, 'button "Big"')
  const remember = ref(tree.text, 'check box "Remember"')
  if (!check(Boolean(big && remember), 'read_window shows the button and the check box')) throw new Error('test app tree')
  // Each background step starts with Notepad in front and a fresh read of the test app. Classic
  // controls may bring their window forward under UI Automation; perch must say so exactly then.
  const background = async (label, step, effect) => {
    await tool('act_window', { window: notepad, steps: [{ focus: true }], then: 'none' })
    await tool('read_window', { window: testApp })
    const before = foreground()
    const r = await tool('act_window', { window: testApp, steps: [step], then: 'tree' })
    const moved = foreground() !== before
    const reported = r.text.includes('the app came to the front')
    check(!r.isError && r.text.includes(effect), `${label} ran (${effect})`)
    check(moved === reported, `${label}: ${moved ? 'brought the window forward' : 'left the foreground window alone'}, and perch ${reported ? 'said' : 'said nothing'}`)
  }
  await background('an e-ref click on a button (Invoke)', { click: big }, '"clicks 1"')
  await background('an e-ref click on a check box (Toggle)', { click: remember }, '"remembered"')
  await background('an action step', { action: remember, name: 'Toggle' }, '"forgotten"')

  // --- Pointer input: a click in the middle of the screenshot hits the big button. ---
  const shot = await tool('read_screenshot', { window: testApp, max_edge: 400 })
  const size = /(\d+)×(\d+) px/.exec(shot.text)
  check(shot.images === 1 && size && Math.max(Number(size[1]), Number(size[2])) <= 400, 'window screenshot fits max_edge')
  if (size) {
    const middle = [Math.round(Number(size[1]) / 2), Math.round(Number(size[2]) * 0.6)]
    const pointer = await tool('act_window', { window: testApp, steps: [{ focus: true }, { click: middle }], then: 'tree' })
    check(!pointer.isError && pointer.text.includes('"clicks 2"'), 'a click at screenshot pixels lands on the button')
    check(foreground() === String(testApp), 'the focus step brought the test app to the front')
  }

  // --- Notepad: background and focused typing, set. ---
  const pad = await tool('read_window', { window: notepad })
  const edit = ref(pad.text, '(?:edit|document)\\b')
  if (!check(Boolean(edit), 'read_window shows Notepad\'s text field')) throw new Error('no text field')
  const bg = await tool('act_window', { window: notepad, steps: [{ type: 'perch was here' }], then: 'tree' })
  check(!bg.isError && bg.text.includes('perch was here'), 'background typing reaches the text field')
  check(foreground() === String(testApp), 'background typing left the foreground window alone')
  const beforeSet = foreground()
  const set = await tool('act_window', { window: notepad, steps: [{ set: edit, value: 'replaced' }], then: 'tree' })
  check(!set.isError && set.text.includes('= "replaced"'), 'set replaces the field value')
  const setMoved = foreground() !== beforeSet
  const setReported = set.text.includes('the app came to the front')
  check(setMoved === setReported, `set: ${setMoved ? 'brought the window forward' : 'left the foreground window alone'}, and perch ${setReported ? 'said' : 'said nothing'}`)
  const focused = await tool('act_window', {
    window: notepad,
    steps: [{ focus: true }, { key: 'ctrl+End', focused: true }, { type: ' and more', focused: true }],
    then: 'tree',
  })
  check(!focused.isError && focused.text.includes('replaced and more'), 'focused keys and typing land in the window')

  const screen = await tool('read_screenshot', { max_edge: 1024 })
  check(screen.images === 1, 'whole-screen screenshot')
} catch (error) {
  console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  failures++
} finally {
  spawnSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' })
  spawnSync('taskkill', ['/IM', 'perchtest.exe', '/F'], { stdio: 'ignore' })
  await client.close()
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
