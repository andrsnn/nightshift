import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_BUDGET, riskText, afterTurn, describeCall, guessEnding, parseReview, reviewPrompt, neverRule, parseArgs, parseExtraDeny } from '../hooks/judge'

const engine = (on: On, classifyAs: string) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'nightshift' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: 's1' }))
  on('model.classify', () => ({ value: classifyAs }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  // Core would put every call here to the person.
  on('tool.check', () => ({ decision: 'ask' }))
  on('agent.list', () => ({ value: [] }))
}

// `$.command.run` as the person's Enter would raise it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = ($: any, args: string): Promise<{ text: string }> =>
  $.command.run({
    command: 'nightshift',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

test('the never-list catches the dangerous ones and leaves normal work alone', () => {
  expect(neverRule('Bash: git push --force origin main')).toBeDefined()
  expect(neverRule('Bash: git push -f')).toBeDefined()
  expect(neverRule('Bash: git reset --hard HEAD~3')).toBeDefined()
  expect(neverRule('PowerShell: Restart-Computer')).toBeDefined()
  expect(neverRule('Bash: rm -rf /')).toBeDefined()
  expect(neverRule('Bash: rm -rf ~')).toBeDefined()
  expect(neverRule('Bash: npm publish')).toBeDefined()
  expect(neverRule('Bash: gh repo create foo --public --push')).toBeDefined()

  expect(neverRule('Bash: npm test')).toBeUndefined()
  expect(neverRule('Bash: git push -u origin feature/x')).toBeUndefined()
  expect(neverRule('Bash: rm -rf node_modules dist')).toBeUndefined()
  expect(neverRule('Bash: python scripts/build.py --yes')).toBeUndefined()
  expect(neverRule('Bash: gh repo create andrsnn/x --private --push')).toBeUndefined()
})

test('extra deny patterns come from the setting', () => {
  const extra = parseExtraDeny('runpod.*create;;\\bsdxl\\b\n(bad')
  expect(extra.length).toBe(2)
  expect(neverRule('Bash: runpodctl create pod', extra)).toBeDefined()
})

test('a call is described by its command when it has one', () => {
  expect(describeCall('Bash', { command: 'ls -la' })).toBe('Bash: ls -la')
  expect(describeCall('Write', { file_path: 'a.txt' })).toBe('Write: {"file_path":"a.txt"}')
})

test('the fallback spots a closing question', () => {
  expect(guessEnding('Done. Should I also update the docs?')).toBe('asks-a-question')
  expect(guessEnding('Let me know which option you prefer.')).toBe('asks-a-question')
  expect(guessEnding('All tests pass and the branch is pushed.')).toBe('finished')
  expect(guessEnding('Waiting on T5. The engine question is set aside for you in DECISIONS.md.')).toBe('asks-a-question')
  expect(guessEnding('Testing Qwen needs your OK.')).toBe('asks-a-question')
})

test('arguments: off, status, an interval and a goal', () => {
  expect(parseArgs('off')).toEqual({ kind: 'off' })
  expect(parseArgs(' STATUS ')).toEqual({ kind: 'status' })
  expect(parseArgs('')).toEqual({ kind: 'on', goal: '' })
  expect(parseArgs('10m ship the level editor')).toEqual({ kind: 'on', goal: 'ship the level editor', everyMinutes: 10 })
  expect(parseArgs('ship it')).toEqual({ kind: 'on', goal: 'ship it' })
})

// A permission prompt that would really wait for the owner, as the engine raises it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prompt = async ($: any, tool_name: string, tool_input: unknown): Promise<string | undefined> =>
  (await $.classic.PermissionRequest({ tool_name, tool_input }))?.decision?.behavior

test('while off, permission prompts are left to the owner', async ($, on) => {
  engine(on, 'safe')
  on('classic.PermissionRequest', () => ({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(await prompt($, 'Bash', { command: 'python run.py' })).toBeUndefined()
})

test('while on, safe prompts are approved, risky ones and questions refused', async ($, on) => {
  engine(on, 'safe')
  on('classic.PermissionRequest', () => ({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await run($, 'finish the parser')
  expect(ran.text).toContain('Nightshift on')

  expect(await prompt($, 'Bash', { command: 'python run.py' })).toBe('allow')
  expect(await prompt($, 'Bash', { command: 'git push --force' })).toBe('deny')
  expect((await $.tool.check({ tool: 'AskUserQuestion', input: { questions: [] } })).decision).toBe('deny')
  // Everything else at tool.check is left to the session's own rules and auto mode.
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'python run.py' } })).decision).toBe('ask')

  await run($, 'off')
  expect(await prompt($, 'Bash', { command: 'python run.py' })).toBeUndefined()
})

test('the classifier can refuse what the never-list misses', async ($, on) => {
  engine(on, 'risky')
  on('classic.PermissionRequest', () => ({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'tidy the inbox')

  expect(await prompt($, 'mcp__gmail__send', { to: 'x@y.z' })).toBe('deny')
  // A local file write never goes to the classifier.
  expect(await prompt($, 'Write', { file_path: 'a.py', content: 'import os' })).toBe('allow')
})

test('nightshift comes back on when the session restarts', async ($, on) => {
  engine(on, 'safe')
  on('classic.PermissionRequest', () => ({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'finish the parser')
  // A fresh session with the same id: the session's own state is gone, the store is not.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await run($, 'status')).text).toContain('Nightshift on')
})

test('after a turn: speak up only when blocked or off course', () => {
  const base = { toolCallsThisTurn: 0, nudgesInRow: 0, reviewRounds: 0, maxReviews: 5, isWorkRunning: false }
  // Blocked: a question, or a stop with nothing running.
  expect(afterTurn({ ...base, ending: 'asks-a-question' })).toEqual({ action: 'nudge', nudgesInRow: 1 })
  expect(afterTurn({ ...base, ending: 'stopped-early', nudgesInRow: 2 })).toEqual({ action: 'nudge', nudgesInRow: 3 })
  expect(afterTurn({ ...base, ending: 'asks-a-question', nudgesInRow: 3 })).toEqual({ action: 'hold', nudgesInRow: 3 })
  expect(afterTurn({ ...base, ending: 'asks-a-question', nudgesInRow: 3, toolCallsThisTurn: 4 })).toEqual({ action: 'nudge', nudgesInRow: 1 })
  expect(afterTurn({ ...base, ending: 'needs-a-human' })).toEqual({ action: 'nudge', nudgesInRow: 1 })
  expect(afterTurn({ ...base, ending: 'needs-a-human', nudgesInRow: 1 })).toEqual({ action: 'hold', nudgesInRow: 1 })
  // Waiting on agents that are still working is not being stuck: say nothing.
  const busy = { ...base, isWorkRunning: true }
  expect(afterTurn({ ...busy, ending: 'waiting-on-work' }).action).toBe('rest')
  expect(afterTurn({ ...busy, ending: 'stopped-early' }).action).toBe('rest')
  expect(afterTurn({ ...busy, ending: 'finished' }).action).toBe('rest')
  // ...but a question for the owner still gets answered.
  expect(afterTurn({ ...busy, ending: 'asks-a-question' }).action).toBe('nudge')
  // Says it is waiting, but nothing is running: that is a stall.
  expect(afterTurn({ ...base, ending: 'waiting-on-work' }).action).toBe('nudge')
  // "Done" with nothing running gets reviewed; when reviews run out it rests, never "done".
  expect(afterTurn({ ...base, ending: 'finished' })).toEqual({ action: 'review', nudgesInRow: 0 })
  expect(afterTurn({ ...base, ending: 'finished', reviewRounds: 5 })).toEqual({ action: 'rest', nudgesInRow: 0 })
})

test('a review reads its verdict and gaps', () => {
  expect(parseReview('VERDICT: PASS\nGAPS:\n- none')).toEqual({ isPass: true, gaps: '- none' })
  const failed = parseReview('VERDICT: FAIL\nGAPS:\n- the menu never got compared with the mock\n- copy unreadable')
  expect(failed.isPass).toBe(false)
  expect(failed.gaps).toContain('compared with the mock')
  // No verdict at all counts as a fail, so a garbled review never ends the night early.
  expect(parseReview('looks fine to me').isPass).toBe(false)
  expect(reviewPrompt('ship the menu', 'run the game')).toContain('ship the menu')
})

test('money: the budget reaches the reviewer and the risk check', () => {
  expect(DEFAULT_BUDGET).toContain('$0.60')
  expect(reviewPrompt('train a model', '')).toContain('free option')
  expect(riskText('Bash: runpodctl create pod --gpuType "H100"')).toContain('$0.60')
  expect(riskText('Bash: x', 'never spend anything')).toContain('never spend anything')
})
