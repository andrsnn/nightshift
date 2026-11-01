import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { afterTurn, describeCall, guessEnding, parseReview, reviewPrompt, neverRule, parseArgs, parseExtraDeny } from '../hooks/judge'

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
})

test('arguments: off, status, an interval and a goal', () => {
  expect(parseArgs('off')).toEqual({ kind: 'off' })
  expect(parseArgs(' STATUS ')).toEqual({ kind: 'status' })
  expect(parseArgs('')).toEqual({ kind: 'on', goal: '' })
  expect(parseArgs('10m ship the level editor')).toEqual({ kind: 'on', goal: 'ship the level editor', everyMinutes: 10 })
  expect(parseArgs('ship it')).toEqual({ kind: 'on', goal: 'ship it' })
})

test('while off, permission asks pass through untouched', async ($, on) => {
  engine(on, 'safe')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'python run.py' } })
  expect(verdict.decision).toBe('ask')
})

test('while on, safe asks are approved, risky ones and questions refused', async ($, on) => {
  engine(on, 'safe')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await run($, 'finish the parser')
  expect(ran.text).toContain('Nightshift on')

  expect((await $.tool.check({ tool: 'Bash', input: { command: 'python run.py' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push --force' } })).decision).toBe('deny')
  expect((await $.tool.check({ tool: 'AskUserQuestion', input: { questions: [] } })).decision).toBe('deny')

  await run($, 'off')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'python run.py' } })).decision).toBe('ask')
})

test('the classifier can refuse what the never-list misses', async ($, on) => {
  engine(on, 'risky')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'tidy the inbox')

  const verdict = await $.tool.check({ tool: 'mcp__gmail__send', input: { to: 'x@y.z' } })
  expect(verdict.decision).toBe('deny')
  // A local file write never goes to the classifier.
  expect((await $.tool.check({ tool: 'Write', input: { file_path: 'a.py', content: 'import os' } })).decision).toBe('allow')
})

test('after a turn: nudge questions, hold after three idle nudges, review done claims', () => {
  const base = { toolCallsThisTurn: 0, nudgesInRow: 0, reviewRounds: 0, maxReviews: 5 }
  expect(afterTurn({ ...base, ending: 'asks-a-question' })).toEqual({ action: 'nudge', nudgesInRow: 1 })
  expect(afterTurn({ ...base, ending: 'stopped-early', nudgesInRow: 2 })).toEqual({ action: 'nudge', nudgesInRow: 3 })
  expect(afterTurn({ ...base, ending: 'asks-a-question', nudgesInRow: 3 })).toEqual({ action: 'hold', nudgesInRow: 3 })
  // A turn that did work starts the count again.
  expect(afterTurn({ ...base, ending: 'asks-a-question', nudgesInRow: 3, toolCallsThisTurn: 4 })).toEqual({ action: 'nudge', nudgesInRow: 1 })
  expect(afterTurn({ ...base, ending: 'needs-a-human' })).toEqual({ action: 'nudge', nudgesInRow: 1 })
  expect(afterTurn({ ...base, ending: 'needs-a-human', nudgesInRow: 1 })).toEqual({ action: 'hold', nudgesInRow: 1 })
  expect(afterTurn({ ...base, ending: 'finished' })).toEqual({ action: 'review', nudgesInRow: 0 })
  expect(afterTurn({ ...base, ending: 'finished', reviewRounds: 5 })).toEqual({ action: 'done', nudgesInRow: 0 })
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
