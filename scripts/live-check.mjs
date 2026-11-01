// Live check: drives a headless Claude Code session with nightshift loaded,
// sends one prompt, keeps the session open, and prints what happened.
// node scripts/live-check.mjs <workdir> <seconds> "<first prompt>" [model] [delaySeconds]
// The first prompt is sent after delaySeconds (default 8) so plugin commands are registered.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [workdir, seconds = '240', prompt, model = 'haiku', delay = '8'] = process.argv.slice(2)
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn('claude', ['-p', '--plugin-dir', pluginDir, '--model', model,
  '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
  { cwd: workdir, shell: true, stdio: ['pipe', 'pipe', 'inherit'] })

const lines = []
let buffer = ''
const show = m => {
  if (m.type === 'assistant') for (const c of m.message.content) {
    if (c.type === 'text') console.log('ASSISTANT:', c.text.slice(0, 400).replace(/\n/g, ' '))
    if (c.type === 'tool_use') console.log('TOOL:', c.name, JSON.stringify(c.input).slice(0, 160))
  }
  if (m.type === 'user') {
    const c = m.message.content
    for (const x of typeof c === 'string' ? [{ type: 'text', text: c }] : c) {
      if (x.type === 'text') console.log('USER:', x.text.slice(0, 400).replace(/\n/g, ' '))
      if (x.type === 'tool_result') console.log('RESULT:', String(typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).slice(0, 200).replace(/\n/g, ' '))
    }
  }
  if (m.type === 'system' && m.subtype === 'ui_status') console.log('STATUS:', m.text)
  if (m.type === 'result') console.log('TURN END:', m.subtype)
}
child.stdout.on('data', d => {
  buffer += d
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
    lines.push(line)
    try { show(JSON.parse(line)) } catch {}
  }
})
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
setTimeout(() => { child.stdin.end(); setTimeout(() => child.kill(), 15000) }, Number(seconds) * 1000)
child.on('exit', code => {
  writeFileSync(join(workdir, 'live-check.jsonl'), lines.join('\n'))
  console.log('exit', code)
})
