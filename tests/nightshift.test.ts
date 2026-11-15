import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_BUDGET, riskText, afterTurn, describeCall, guessEnding, parseReview, reviewPrompt, neverRule, parseArgs, parseExtraDeny, guardRefused, REFUSED_ANSWER } from '../hooks/judge'
import { openGoals, settleAnswers } from '../hooks/register'

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
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nightshift__${e.name}` } }))
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

test('bounds: the reviewer sends back open-ended loops', () => {
  expect(reviewPrompt('ship the feature', '')).toContain('Bounds')
  expect(reviewPrompt('ship the feature', '')).toContain('at most two tries')
})

test('clean-up: the reviewer flags leftovers and hand-offs', () => {
  expect(reviewPrompt('ship the feature', '')).toContain('Clean-up')
  expect(reviewPrompt('ship the feature', '')).toContain('stop and delete them now')
})

test('goal: the open goals from the latest status update', async () => {

  const status = [
    'Update: two films are filming.',
    '',
    'GOALS',
    'G1 refine the director - DOING',
    'G2 make a few movies - PAUSED',
    'G3 fix the scroll - DONE',
    'G4 a dropped idea - DROPPED',
    '',
    'WIP',
    '- G1: refine the director',
  ].join('\n')
  expect(openGoals(status)).toEqual(['G1 refine the director (DOING)', 'G2 make a few movies (PAUSED)'])
  expect(openGoals('no status here')).toEqual([])
})

// Owner: "it should wait if still idle after 15 THEN it prompts not immediately."
test('after a turn ends, nightshift waits 15 quiet minutes before it says anything', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const sent: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'nightshift' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: 's1' }))
  on('model.classify', () => ({ value: 'stopped-early' }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nightshift__${e.name}` } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'finish the parser')
  await clock.advance(1000)
  sent.length = 0

  const turn = async (id: string): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ($ as any).turn.start({ turnId: id, text: 'go' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ($ as any).turn.complete({ turnId: id, reason: 'answer', answer: 'I stopped here.', isAborted: false })
  }

  await turn('t1')
  await clock.advance(14 * 60_000)
  expect(sent).toEqual([])
  await clock.advance(2 * 60_000)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('Nightshift')

  // The owner replies within the 15 minutes: the held answer is dropped, nothing is sent.
  sent.length = 0
  await turn('t2')
  await clock.advance(5 * 60_000)
  await turn('t3')
  await clock.advance(10 * 60_000)
  expect(sent).toEqual([])
})

test('arguments: force', () => {
  expect(parseArgs('force')).toEqual({ kind: 'on', goal: '', isForced: true })
  expect(parseArgs('force 10m ship it')).toEqual({ kind: 'on', goal: 'ship it', everyMinutes: 10, isForced: true })
  expect(parseArgs('Force ship it')).toEqual({ kind: 'on', goal: 'ship it', isForced: true })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callOff = async ($: any): Promise<string> =>
  String((await $.tool.call({ tool: 'mcp__nightshift__off', input: { done: 'parser done; tests and a run checked' } })).result)

test('the agent turns nightshift off when the goals are done', async ($, on) => {
  engine(on, 'safe')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'finish the parser')

  expect(await callOff($)).toContain('Nightshift is off')
  expect((await run($, 'status')).text).toBe('Nightshift is off.')
})

test('forced on: the agent cannot turn it off, the owner can', async ($, on) => {
  engine(on, 'safe')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await run($, 'force finish the parser')).text).toContain('forced')

  expect(await callOff($)).toContain('stays on')
  expect((await run($, 'status')).text).toContain('Forced on')
  await run($, 'off')
  expect((await run($, 'status')).text).toBe('Nightshift is off.')
})

test('the force setting forces every /nightshift on', { options: { force: true } }, async ($, on) => {
  engine(on, 'safe')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run($, 'finish the parser')

  expect(await callOff($)).toContain('stays on')
})

// A session's conversation and files, for the goal tests: `/nightshift` with no goal reads them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const engineWith = (on: On, messages: any[], files: Record<string, string> = {}, cwd = 'H:/game') => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'nightshift' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: messages }))
  on('session.cwd', () => ({ value: cwd }))
  on('fs.read', (_, e) => {
    const key = e.path.split(String.fromCharCode(92)).join('/')
    if (key in files) return { value: files[key] as string }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', (_, e) => {
    files[e.path.split(String.fromCharCode(92)).join('/')] = e.text
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('model.classify', () => ({ value: 'safe' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('agent.list', () => ({ value: [] }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nightshift__${e.name}` } }))
}

const said = (role: 'user' | 'assistant', text: string, toolUses: unknown[] = []) => ({ role, text, toolUses })
const edit = (path: string) => ({ tool_use_id: `e-${path}`, tool: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } })

const OLD_STATUS = [
  'Update: the core mechanics are merging.',
  '',
  'GOALS',
  'G15 I want to get just the core mechanics of the game working well - DOING',
  'G18 Bring in the full combat and skill system - DOING',
  'G19 No crappy ui - DOING',
  '',
  'WIP',
  '- G15: core mechanics',
].join('\n')

// Owner, Nov 11: "/nightshift" listed G18 and G19 as DOING hours after they were done, and missed the delve build.
test('goal: STATUS.md written after the last status update wins, and its DONE goals are dropped', async ($, on) => {
  engineWith(
    on,
    [
      said('user', 'make the core mechanics work'),
      said('assistant', OLD_STATUS),
      said('user', 'add the delve system from saltblade'),
      said('assistant', 'Updated the status file.', [edit('H:/game/STATUS.md')]),
      said('user', 'tripod should always win for awhile'),
    ],
    {
      'H:/game/STATUS.md': [
        '# Game status',
        '- G15 "I want to get just the core mechanics of the game working well" - DONE',
        '- G18 "Bring in the full combat and skill system" - DOING',
        '- G18 DONE (3a45ced): the port is on main',
        '- G19 "No crappy ui" - DONE',
        '- G21 owner, Nov 11: "add the delve system from saltblade"',
        '- G22 "tripod should always win for awhile" - DOING: tension first',
      ].join('\n'),
    },
  )
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  const { text } = await run($, '')

  expect(text).toContain('G21')
  expect(text).toContain('delve')
  expect(text).toContain('G22')
  expect(text).not.toContain('G15')
  expect(text).not.toContain('G18')
  expect(text).not.toContain('G19')
})

test('goal: owner messages after the last status update are all listed, marked as maybe stale', async ($, on) => {
  engineWith(on, [
    said('user', 'make the core mechanics work'),
    said('assistant', OLD_STATUS),
    said('user', 'add the delve system from saltblade'),
    said('assistant', 'On it.'),
    said('user', 'tripod should always win for awhile'),
  ])
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  const { text } = await run($, '')

  expect(text).toContain('G15')
  expect(text).toContain('add the delve system from saltblade')
  expect(text).toContain('tripod should always win for awhile')
  expect(text).toContain('may be stale')
  expect(text).not.toContain('make the core mechanics work')
})

// The store held "This session is being continued from a previous conversation..." as one session's goal.
test('goal: compaction summaries, system reminders and plugin prompts never become the goal', async ($, on) => {
  engineWith(on, [
    said('user', 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary: ...'),
    said('user', '<system-reminder>\nCodebase instructions\n</system-reminder>'),
    said('user', 'Caveat: The messages below were generated by the user while running local commands.'),
    said('user', 'A plugin sent a message: keep going'),
    said('user', 'build the level editor'),
    said('assistant', 'Working on it.'),
    said('user', '<system-reminder>\nThe user sent a new message\n</system-reminder>\nalso match the mocks'),
  ])
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  const { text } = await run($, '')

  expect(text).toContain('build the level editor')
  expect(text).toContain('also match the mocks')
  expect(text).not.toContain('continued from a previous conversation')
  expect(text).not.toContain('system-reminder')
  expect(text).not.toContain('Caveat')
  expect(text).not.toContain('plugin sent')
})

// ---- 1. A GOALS header with more text after it ----

const NOV8 = ['Update: Nov 8.', '', 'GOALS', 'G1 an old goal from Nov 8 - DOING', '', 'WIP', '- G1: an old goal'].join('\n')

// Owner, Nov 15: with "GOALS (updated Nov 14)" nightshift kept showing the Nov 8 list.
test('goals: a header with more text after GOALS is read, quotes and trailing notes too', async ($, on) => {
  const status = ['Update: Nov 14.', '', 'GOALS (updated Nov 14)', 'G7 "Click Verify in UE 5.8" - BLOCKED on the owner', 'G8 "Ship the menu" - DOING', 'G9 Old thing - DONE'].join('\n')
  expect(openGoals(status)).toEqual(['G7 Click Verify in UE 5.8 (BLOCKED)', 'G8 Ship the menu (DOING)'])
  expect(openGoals('## GOALS:\n- G2: fix the scroll - DOING')).toEqual(['G2 fix the scroll (DOING)'])
  // Prose about goals is not a header.
  expect(openGoals('Goals for today were set.\nG1 nope - DOING')).toEqual([])

  engineWith(on, [said('user', 'make the game'), said('assistant', NOV8), said('assistant', status)])
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  const { text } = await run($, '')
  expect(text).toContain('G8 Ship the menu')
  expect(text).not.toContain('Nov 8')
})

test('goals: when the latest status update has no goals block, nightshift says so and never reuses an old list', async ($, on) => {
  engineWith(on, [
    said('user', 'make the game'),
    said('assistant', NOV8),
    said('assistant', 'Update: the menu is in.\n\nGoals: menu done, combat next.\n\nWIP\n- combat'),
  ])
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  const { text } = await run($, '')
  expect(text).toContain('No goal list')
  expect(text).toContain('no GOALS block')
  expect(text).toContain('make the game')
  expect(text).not.toContain('old goal from Nov 8')
})

// ---- 2. Settled questions are never answered twice; check-ins back off while every goal waits on the owner ----

test('settled: a question answered once is left out the next time', () => {
  const first = settleAnswers('1. Click Verify in UE 5.8 - yes, click it when the window opens', [], [])
  expect(first.length).toBe(1)
  expect(settleAnswers('1. Click the Verify button in UE 5.8? - yes', first, [])).toEqual([])
  expect(settleAnswers('1. Click Verify in UE 5.8 - yes\n2. Which sky colour - blue', first, []).map(item => item.question)).toEqual(['Which sky colour'])
})

// A session whose turns end with a question, for the stand-in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const askingEngine = (on: On, forkText: string, sent: string[], prompts: string[]) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'nightshift' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('session.cwd', () => ({ value: 'H:/game' }))
  on('fs.read', (_, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('model.classify', () => ({ value: 'asks-a-question' }))
  on('model.fork', (_, e) => {
    prompts.push(e.prompt)
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: forkText, usage } }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('tool.check', () => ({ decision: 'ask' }))
  on('classic.PermissionDenied', () => ({}))
  on('agent.list', () => ({ value: [] }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__nightshift__${e.name}` } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return clock
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const askTurn = async ($: any, id: string, answer: string): Promise<void> => {
  await $.turn.start({ turnId: id, text: 'go' })
  await $.turn.complete({ turnId: id, reason: 'answer', answer, isAborted: false })
}

const ANSWERED = 'Answers on their behalf'

// Owner, Nov 15: it "settled" the UE 5.8 Verify click about 15 times with the same answer.
test('settled: the same question asked again gets no second answer', async ($, on) => {
  const sent: string[] = []
  const prompts: string[] = []
  const clock = askingEngine(on, '1. Click Verify in UE 5.8 - yes, click it', sent, prompts)
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  await run($, 'port the game to UE 5.8')
  await clock.advance(1000)

  sent.length = 0
  await askTurn($, 't1', 'The Verify button in UE 5.8 needs a click. Should I click it?')
  await clock.advance(16 * 60_000)
  expect(sent.filter(text => text.includes(ANSWERED)).length).toBe(1)

  sent.length = 0
  await askTurn($, 't2', 'The Verify button in UE 5.8 still needs a click. Should I click it?')
  await clock.advance(16 * 60_000)
  expect(sent.filter(text => text.includes(ANSWERED))).toEqual([])
  // The stand-in was told it was settled already.
  expect(prompts[prompts.length - 1]).toContain('Already settled')
  expect(prompts[prompts.length - 1]).toContain('Click Verify in UE 5.8')
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setGoals = async ($: any, goals: { id: string; words: string; state: string }[], path?: string): Promise<string> =>
  String((await $.tool.call({ tool: 'mcp__nightshift__goals', input: path ? { goals, path } : { goals } })).result)

test('back-off: check-ins wait longer while every open goal is BLOCKED', async ($, on) => {
  const sent: string[] = []
  const clock = askingEngine(on, 'NONE', sent, [])
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  await run($, 'port the game')
  await setGoals($, [
    { id: 'G1', words: 'Click Verify in UE 5.8', state: 'BLOCKED' },
    { id: 'G2', words: 'Port the menu', state: 'DONE' },
  ])
  sent.length = 0
  for (let minute = 0; minute < 110; minute++) await clock.advance(60_000)
  const checks = sent.filter(text => text.includes('Nightshift check-in'))
  // 15, then 30 later, then 60 later: 3 check-ins in 110 minutes.
  expect(checks.length).toBe(3)
  expect(checks[0]).toContain('No goal on the list is DOING')
  expect(checks[0]).toContain('waits 30m')

  // A goal that can move again brings the normal 15-minute check-ins back.
  await setGoals($, [{ id: 'G1', words: 'Click Verify in UE 5.8', state: 'DOING' }])
  sent.length = 0
  for (let minute = 0; minute < 110; minute++) await clock.advance(60_000)
  expect(sent.filter(text => text.includes('Nightshift check-in')).length).toBe(7)
})

// ---- 3. Never answer for an action a permission or safety check refused ----

test('refused: an answer about a refused action is handed back to the owner', () => {
  const refused = ['Bash: git push origin master (auto mode refused a push to the default branch)']
  const out = guardRefused(
    [
      { question: 'Push the fix to master?', answer: 'yes, push' },
      { question: 'The safety check blocked the deploy, retry?', answer: 'yes' },
      { question: 'Which sky colour', answer: 'blue' },
    ],
    refused,
  )
  expect(out[0]?.answer).toBe(REFUSED_ANSWER)
  expect(out[1]?.answer).toBe(REFUSED_ANSWER)
  expect(out[2]?.answer).toBe('blue')
})

// Owner, Nov 15: Claude Code refused a push to master and nightshift answered "yes, push".
test('refused: a push the safety check refused is never answered "yes" for the owner', async ($, on) => {
  const sent: string[] = []
  const prompts: string[] = []
  const clock = askingEngine(on, '1. Push the fix to master - yes, push it\n2. Which sky colour - blue', sent, prompts)
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  await run($, 'fix the save bug')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await ($ as any).classic.PermissionDenied({
    tool_name: 'Bash',
    tool_input: { command: 'git push origin master' },
    tool_use_id: 'u1',
    reason: 'auto mode refused a push to the default branch',
  })
  await clock.advance(1000)
  sent.length = 0
  await askTurn($, 't1', 'The push to master was refused. Should I push it?')
  await clock.advance(16 * 60_000)

  const answers = sent.find(text => text.includes(ANSWERED)) ?? ''
  expect(answers).toContain('leave it for the owner')
  expect(answers).toContain('blue')
  expect(answers).not.toContain('yes, push it')
  expect(prompts[0]).toContain('git push origin master')
  expect(prompts[0]).toContain('Never answer yes to an action')
})

// ---- 4. The goals tool ----

const STATUS_NOV14 = [
  'MISSION: make the game',
  '',
  'GOALS (updated Nov 14)',
  'G1 "Build the menu" - DOING: menus first',
  'G2 "Fix the save bug" - DOING',
  'G3 "Port combat" - DOING',
  '',
  'NOTES',
  '- keep it small',
].join('\n')

test('goals tool: tracks the new list, rewrites the GOALS block, and says what changed', async ($, on) => {
  const files: Record<string, string> = { 'H:/game/STATUS.md': STATUS_NOV14 }
  engineWith(on, [], files)
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })
  await run($, '')

  const report = await setGoals($, [
    { id: 'G1', words: 'Build the menu', state: 'DOING' },
    { id: 'G3', words: 'Port combat', state: 'DONE' },
    { id: 'G4', words: 'Add the delve system', state: 'DOING' },
  ])
  expect(report).toContain('Rewrote the GOALS block in H:/game/STATUS.md')
  expect(report).toContain('GOALS\nG1 Build the menu - DOING\nG3 Port combat - DONE\nG4 Add the delve system - DOING')
  expect(report).toContain('CHANGED')
  expect(report).toContain('- G4: added - DOING')
  expect(report).toContain('- G3: DOING \u2192 DONE')
  expect(report).toContain('- G2: removed (was "Fix the save bug" - DOING)')

  // STATUS.md: the block is replaced, the rest kept, an unchanged goal keeps its note.
  expect(files['H:/game/STATUS.md']).toBe(
    [
      'MISSION: make the game',
      '',
      'GOALS (updated Nov 14)',
      'G1 "Build the menu" - DOING: menus first',
      'G3 "Port combat" - DONE',
      'G4 "Add the delve system" - DOING',
      '',
      'NOTES',
      '- keep it small',
    ].join('\n'),
  )

  // Nightshift now tracks the new list.
  const status = (await run($, 'status')).text
  expect(status).toContain('G4 Add the delve system')
  expect(status).not.toContain('Fix the save bug')

  // Nothing changed: it says so.
  expect(
    await setGoals($, [
      { id: 'G1', words: 'Build the menu', state: 'DOING' },
      { id: 'G3', words: 'Port combat', state: 'DONE' },
      { id: 'G4', words: 'Add the delve system', state: 'DOING' },
    ]),
  ).toContain('CHANGED\nNothing.')
  // A bad list changes nothing.
  expect(await setGoals($, [{ id: 'X', words: '', state: 'MAYBE' }])).toContain('Nothing changed')
})

test('goals tool: makes STATUS.md when there is none, and /nightshift reads the latest call', async ($, on) => {
  const files: Record<string, string> = {}
  const call = { tool_use_id: 'g1', tool: 'mcp__nightshift__goals', input: { goals: [{ id: 'G5', words: 'Ship the build', state: 'DOING' }] } }
  engineWith(on, [said('user', 'make the game'), said('assistant', NOV8), said('assistant', 'Updating goals.', [call])], files)
  await $.session.start({ cwd: 'H:/game', surface: 'terminal', isInteractive: true })

  expect(await setGoals($, [{ id: 'G5', words: 'Ship the build', state: 'DOING' }])).toContain('Created H:/game/STATUS.md')
  expect(files['H:/game/STATUS.md']).toBe('# Status\n\nGOALS\nG5 "Ship the build" - DOING\n')

  const { text } = await run($, '')
  expect(text).toContain('G5 Ship the build')
  expect(text).not.toContain('Nov 8')
})
