// Pure rules nightshift decides with. No `$` here, so tests can call them directly.

// Commands nightshift never approves on its own, whatever the classifier says.
const NEVER: readonly RegExp[] = [
  /\b(shutdown|reboot|poweroff|halt|logoff)\b/i,
  /\b(Restart|Stop)-Computer\b/i,
  /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|filter-branch|filter-repo)\b/i,
  /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i,
  /\b(mkfs|diskpart|format\s+[a-z]:)/i,
  /\bdd\s+[^\n]*\bof=/i,
  /\b(drop\s+(database|table|schema)|truncate\s+table)\b/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\b(docker|podman)\s+push\b/i,
  /\b(vercel|netlify)\b[^\n]*--prod\b/i,
  /\bfly(ctl)?\s+deploy\b/i,
  /\bgh\s+(release\s+create|repo\s+(delete|create[^\n]*--public)|pr\s+merge)\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\bkubectl\s+(delete|apply)\b/i,
  /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\*|\.\.?)(\s|\/?$)/i,
  /\brm\s+-[a-z]*r[a-z]*\s+\/?(c|mnt\/c)\/?(\s|$)/i,
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*\s(C:\\?|~|\$HOME|\$env:USERPROFILE)(\s|$)/i,
  /\b(rmdir|rd)\s+\/s\s+[^\n]*\b[a-z]:\\?(\s|$)/i,
]

export const parseExtraDeny = (raw: unknown): RegExp[] =>
  String(raw ?? '')
    .split(/\r?\n|;;/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [new RegExp(line, 'i')]
      } catch {
        return []
      }
    })

// The text of a tool call as one string, for the rules and the classifier.
export const describeCall = (tool: string, input: unknown): string => {
  const record = (input ?? {}) as Record<string, unknown>
  const command = typeof record.command === 'string' ? record.command : undefined

  return command !== undefined
    ? `${tool}: ${command}`
    : `${tool}: ${JSON.stringify(input ?? {}).slice(0, 2000)}`
}

// Local file tools: approved without asking the classifier, which can mistake a
// script's contents for the act of running it.
export const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'TodoWrite'])

export const neverRule = (call: string, extra: readonly RegExp[] = []): RegExp | undefined =>
  [...NEVER, ...extra].find(rule => rule.test(call))

export const RISK_LABELS = ['safe', 'risky'] as const

// What nightshift tells every part of the session about money, unless the owner sets their own.
export const DEFAULT_BUDGET =
  'Spend as little as possible. Use free options first: the Claude Code subscription, local CPU tools, models already set up. '
  + 'Pay for cloud GPUs (RunPod and the like) only when nothing free works: the cheapest machine that fits the job, at most $0.60 an hour, '
  + 'no storage volumes, shut down and deleted right after each run, never left running. No other paid services or APIs.'

export const riskText = (call: string, budget: string = DEFAULT_BUDGET): string =>
  [
    'An AI coding agent working alone on the owner\'s own computer wants to run this tool call.',
    'safe: it stays on this machine and can be undone or is harmless (builds, tests, scripts, installs, edits, local git, reading anything, pushing a normal branch to the owner\'s own repo, editing or rewriting files inside a project with a script or heredoc).',
    `risky: it destroys data that cannot be got back, spends money beyond this budget (${budget}), starts a paid cloud machine with no plan to shut it down, or publishes or sends something to other people or public places (deploys, releases, emails, chat messages, posts, force pushes, deleting cloud resources).`,
    '',
    'Tool call:',
    call.slice(0, 3000),
  ].join('\n')

export const ENDING_LABELS = ['asks-a-question', 'waiting-on-work', 'stopped-early', 'finished', 'needs-a-human'] as const
export type Ending = (typeof ENDING_LABELS)[number]

export const endingText = (answer: string): string =>
  [
    'How does this final message of an AI coding agent end its turn?',
    'asks-a-question: it asks the user something, offers options to pick from, asks for approval or confirmation, or says some decision is set aside, parked or waiting for the user (even while other work goes on).',
    'waiting-on-work: it says it is waiting for background agents, jobs, builds or renders it started, which are still running.',
    'stopped-early: it reports progress or a plan, but stops while work on its task is still left to do and nothing it started is still running.',
    'finished: it says the task is done, perhaps with a summary, and asks nothing.',
    'needs-a-human: it cannot go on without something only a person can give (a password, a login, a payment, a physical action).',
    '',
    'Message:',
    answer.slice(-4000),
  ].join('\n')

const ASKING =
  /\?\s*$|\b(should i|shall i|do you want|would you like|want me to|let me know|which (one|option)|your call|before i (continue|proceed|go ahead)|can you confirm|please confirm|ok to proceed|okay to proceed|waiting for your|awaiting your|waiting for you|set aside for you|needs your ok|your ok|answers? i need from you)\b/i

// The fallback when the classifier can't answer: a question near the end of the message.
export const guessEnding = (answer: string): Ending =>
  ASKING.test(answer.slice(-500)) ? 'asks-a-question' : 'finished'

const MAX_NUDGES_IN_ROW = 3

// What to do when a main-loop turn ends. nightshift speaks up only when the
// session is blocked or off course:
// - a question for the owner, or a stop with nothing running, gets a nudge;
// - waiting on agents that are still working gets nothing (their reports wake it);
// - "done" with nothing running gets a strict review; with work still running it waits.
// Nudges in a row count only turns that did no work, so a session that keeps
// stopping without acting is left alone until the next check-in.
export const afterTurn = (turn: {
  ending: Ending
  toolCallsThisTurn: number
  nudgesInRow: number
  reviewRounds: number
  maxReviews: number
  isWorkRunning: boolean
}): { action: 'review' | 'rest' | 'hold' | 'nudge'; nudgesInRow: number } => {
  const nudgesInRow = turn.toolCallsThisTurn > 0 ? 0 : turn.nudgesInRow
  const isWaiting = turn.ending === 'waiting-on-work' || turn.ending === 'stopped-early'

  if (turn.isWorkRunning && (isWaiting || turn.ending === 'finished')) return { action: 'rest', nudgesInRow }

  if (turn.ending === 'finished') {
    return { action: turn.reviewRounds < turn.maxReviews ? 'review' : 'rest', nudgesInRow: 0 }
  }

  // A human-only block gets one nudge to do everything else; a question or a stall gets a few.
  const limit = turn.ending === 'needs-a-human' ? 1 : MAX_NUDGES_IN_ROW

  return nudgesInRow >= limit ? { action: 'hold', nudgesInRow } : { action: 'nudge', nudgesInRow: nudgesInRow + 1 }
}

// The question put to a fork of the session when it says it is done. The
// checks come from mining one owner's pushback on "done" claims (research/).
export const reviewPrompt = (goal: string, notes: string, budget: string = DEFAULT_BUDGET): string =>
  [
    "Step out of your role for a moment. You are now the owner's strict reviewer, not the agent who did the work.",
    'The owner is asleep. In the morning they will hold the result up against what they asked for, and they are tired of "done" claims that fall far short of it.',
    '',
    "The owner's original goal:",
    goal || '(the task the owner gave at the start of this conversation)',
    '',
    'Check the work in this conversation, one point at a time:',
    '1. The ask. Take the goal and every later "I want" or "make sure" from the owner, word for word. Is each one met? Any part dropped, narrowed, sampled ("3 of 61"), stubbed, faked, reframed, or capped by a limit the owner never set?',
    '2. Eyes on the output. Was the real output looked at in this conversation: run, opened, played, read back, and for anything visual, real screenshots or frames viewed? Tests passing is not looking. A claim with no evidence counts as unchecked.',
    '3. The bar. Next to the mock, reference or example the owner gave, would they accept it, or say "not even close"? Is there a flaw the agent noticed and shipped anyway?',
    '4. The whole scope. Every item, screen, level or platform the goal covers, not a sample.',
    '5. Words. Would a person say every user-facing line out loud? Anything convoluted or padded fails.',
    '6. Loose ends. A "still open" list, a "want me to...?", or a wait on a job that never got checked all mean not done.',
    `7. Money. The owner's budget: ${budget} Was money spent where a free option would have worked, or is any paid machine still running? Either is a gap.`,
    '8. Bounds. The owner wants bounded, smart tasks. Did any task or agent loop with no stated end, such as proof run after proof run or round after round of tuning? That is a gap: the next step is a bounded task with exact steps, one check, at most two tries and a time limit.',
    '9. Clean-up. Is anything the agent or its helpers started still running with no use (dev servers, browsers, background jobs, watchers), or are their temp files left behind? Did the agent hand the owner a list of things to stop or delete instead of doing it itself? Either is a gap: the next step is to stop and delete them now.',
    '',
    'The owner told the agent to decide things itself rather than wait for them. Acting on its own recommendation instead of waiting for a pick or an OK is not a gap, and neither is anything only the owner could give (a password, a purchase, publishing).',
    ...(notes ? ['', `The owner's own notes on how to check work: ${notes}`] : []),
    '',
    'Answer in exactly this form and nothing else:',
    'VERDICT: PASS or FAIL',
    'GAPS:',
    '- the most important gap, and the concrete next step that closes it',
    '- (up to five, most important first)',
    'Say PASS only if the owner would accept it as it is.',
  ].join('\n')

export const parseReview = (text: string): { isPass: boolean; gaps: string } => {
  const verdict = /VERDICT:\s*(PASS|FAIL)/i.exec(text)
  const gaps = text.split(/GAPS:\s*/i)[1]?.trim() ?? ''
  const isPass = verdict ? verdict[1]!.toUpperCase() === 'PASS' : false

  return { isPass, gaps: gaps.slice(0, 2000) || text.trim().slice(0, 2000) }
}

// Reads `/nightshift` arguments: off, status, log, or `[<n>m] [goal...]`.
export type Parsed =
  | { kind: 'off' }
  | { kind: 'status' }
  | { kind: 'log' }
  | { kind: 'help' }
  | { kind: 'on'; goal: string; everyMinutes?: number; isForced?: boolean }

export const parseArgs = (args: string): Parsed => {
  const text = args.trim()

  // `force` first: only the owner can turn it off.
  const force = /^force\b\s*/i.exec(text)
  if (force !== null) {
    const rest = parseArgs(text.slice(force[0].length))
    return rest.kind === 'on' ? { ...rest, isForced: true } : { kind: 'on', goal: '', isForced: true }
  }
  const word = text.toLowerCase()

  if (word === 'off' || word === 'stop') return { kind: 'off' }
  if (word === 'status') return { kind: 'status' }
  if (word === 'log') return { kind: 'log' }
  if (word === 'help') return { kind: 'help' }

  const every = /^(\d{1,4})m\b\s*/i.exec(text)
  if (every === null) return { kind: 'on', goal: text }

  return { kind: 'on', goal: text.slice(every[0].length), everyMinutes: Number(every[1]) }
}

export const minutes = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))}m`

// ---- Goals: the GOALS block of a status update or STATUS.md ----

export const GOAL_STATES = ['DOING', 'DONE', 'BLOCKED', 'PAUSED', 'DROPPED'] as const
export type GoalState = (typeof GOAL_STATES)[number]
export type Goal = { id: string; words: string; state: GoalState }

const STATE_RE = GOAL_STATES.join('|')
// "GOALS", "GOALS (updated Nov 14)", "## GOALS:", "**GOALS**". Upper case only, so prose about goals is not a header.
const HEADER = /^(?:#{1,6}\s*)?(?:\*\*)?GOALS\b(?![-\w])/
// "G7 the words - DOING", "- G7: "the words" – BLOCKED on your choice below".
const GOAL_LINE = new RegExp(`^(?:[-*]\\s*)?(G\\d+)\\b[:.]?\\s+(.+?)\\s+[-\\u2013\\u2014]\\s+(${STATE_RE})\\b(.*)$`, 'i')

const unquote = (text: string): string => text.trim().replace(/^["“](.*)["”]$/, '$1').trim()

// The first GOALS block in a text: where it is and the goals in it. `found` is false when there is no header.
// The block runs from the header to the first line that is not a goal line (blank lines before the first goal
// are skipped).
export const parseGoalsBlock = (
  text: string,
): { found: boolean; goals: Goal[]; header: number; end: number; notes: Record<string, string>; isQuoted: boolean } => {
  const lines = text.split(/\r?\n/)
  const header = lines.findIndex(line => HEADER.test(line.trim()))
  const goals: Goal[] = []
  const notes: Record<string, string> = {}
  let isQuoted = false
  if (header < 0) return { found: false, goals, header, end: header, notes, isQuoted }
  let end = header + 1
  for (let at = header + 1; at < lines.length; at++) {
    const line = (lines[at] ?? '').trim()
    if (!line && goals.length === 0) {
      end = at + 1
      continue
    }
    const m = line.match(GOAL_LINE)
    if (!m) break
    const id = (m[1] ?? '').toUpperCase()
    if (goals.length === 0) isQuoted = /^["“]/.test((m[2] ?? '').trim())
    goals.push({ id, words: unquote(m[2] ?? '').slice(0, 300), state: (m[3] ?? '').toUpperCase() as GoalState })
    if ((m[4] ?? '').trim()) notes[id] = m[4] ?? ''
    end = at + 1
  }

  return { found: true, goals, header, end, notes, isQuoted }
}

export const isOpenGoal = (goal: Goal): boolean => goal.state !== 'DONE' && goal.state !== 'DROPPED'

export const goalLine = (goal: Goal, isQuoted = false): string =>
  `${goal.id} ${isQuoted ? `"${goal.words}"` : goal.words} - ${goal.state}`

// Nightshift's goal text from a list: the open goals, or a line saying every one is done.
export const goalsText = (goals: readonly Goal[], from = ''): string => {
  const open = goals.filter(isOpenGoal)
  if (goals.length > 0 && open.length === 0) return `Every goal${from ? ` in ${from}` : ''} is done.`

  return `Open goals${from ? ` (from ${from})` : ''}:\n${open.map(goal => `${goal.id} ${goal.words} (${goal.state})`).join('\n')}`
}

// True when nothing on the list is being worked on: every open goal is BLOCKED or PAUSED (waiting on the
// owner), or every goal is done. Check-ins back off then. False when the list is unknown.
export const isWaitingOnOwner = (goals: readonly Goal[] | undefined): boolean =>
  goals !== undefined && goals.length > 0 && !goals.some(goal => goal.state === 'DOING')

// Check-ins while only owner-blocked goals are left: the interval doubles each time, up to 16 times.
export const checkInDelay = (everyMs: number, idleChecks: number): number => everyMs * 2 ** Math.min(Math.max(0, idleChecks), 4)

export type GoalsDiff = {
  added: Goal[]
  removed: Goal[]
  moved: { goal: Goal; was: GoalState }[]
  reworded: { goal: Goal; was: string }[]
}

export const diffGoals = (before: readonly Goal[], after: readonly Goal[]): GoalsDiff => {
  const old = new Map(before.map(goal => [goal.id, goal]))
  const now = new Set(after.map(goal => goal.id))
  const diff: GoalsDiff = { added: [], removed: before.filter(goal => !now.has(goal.id)), moved: [], reworded: [] }
  for (const goal of after) {
    const was = old.get(goal.id)
    if (!was) {
      diff.added.push(goal)
      continue
    }
    if (was.state !== goal.state) diff.moved.push({ goal, was: was.state })
    if (was.words !== goal.words) diff.reworded.push({ goal, was: was.words })
  }

  return diff
}

// The "what changed" lines, one per change, each starting with the goal ID.
export const changeLines = (diff: GoalsDiff): string[] => [
  ...diff.added.map(goal => `- ${goal.id}: added - ${goal.state}`),
  ...diff.moved.map(({ goal, was }) => `- ${goal.id}: ${was} → ${goal.state}`),
  ...diff.reworded.map(({ goal, was }) => `- ${goal.id}: words changed (was "${was}")`),
  ...diff.removed.map(goal => `- ${goal.id}: removed (was "${goal.words}" - ${goal.state})`),
]

// STATUS.md with its GOALS block replaced by `goals`, or a GOALS block added at the end when it has none.
// A goal whose state did not change keeps any note written after its state.
export const writeGoalsBlock = (text: string | undefined, goals: readonly Goal[]): string => {
  const source = text ?? ''
  const block = parseGoalsBlock(source)
  if (!block.found) {
    const lines = ['GOALS', ...goals.map(goal => goalLine(goal, true))]
    return source.trim() ? `${source.replace(/\s*$/, '')}\n\n${lines.join('\n')}\n` : `# Status\n\n${lines.join('\n')}\n`
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const old = new Map(block.goals.map(goal => [goal.id, goal]))
  const isQuoted = block.isQuoted || block.goals.length === 0
  const fresh = goals.map(goal => {
    const note = old.get(goal.id)?.state === goal.state ? (block.notes[goal.id] ?? '') : ''
    return `${goalLine(goal, isQuoted)}${note}`
  })
  // Keep a blank line between the block and whatever follows it.
  const after = lines.slice(block.end)
  const gap = after.length > 0 && (after[0] ?? '').trim() !== '' ? [''] : []

  return [...lines.slice(0, block.header + 1), ...fresh, ...gap, ...after].join(eol)
}

// ---- Settled questions and refused actions ----

export type Settled = { question: string; answer: string }

// The stand-in's numbered reply: "1. the question - the answer" (or "question: answer"), one per line.
export const parseAnswers = (text: string): Settled[] =>
  text
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^(\d+[.)]|[-*])\s*/, ''))
    .filter(Boolean)
    .map(line => {
      const cut = line.match(/^(.+?)(?:\s+[-–—]\s+|:\s+)(.+)$/)
      return cut ? { question: (cut[1] ?? '').trim(), answer: (cut[2] ?? '').trim() } : { question: line, answer: '' }
    })

const wordSet = (text: string): Set<string> =>
  new Set(text.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').split(/\s+/).filter(word => word.length >= 3))

// Two questions are the same when most of their words match.
export const isSameQuestion = (a: string, b: string): boolean => {
  const left = wordSet(a)
  const right = wordSet(b)
  if (left.size === 0 || right.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase()
  const shared = [...left].filter(word => right.has(word)).length

  return shared / Math.min(left.size, right.size) >= 0.6
}

export const freshAnswers = (answers: readonly Settled[], settled: readonly Settled[]): Settled[] =>
  answers.filter(item => !settled.some(old => isSameQuestion(item.question, old.question)))

const REFUSAL_WORDS = /\b(refus\w*|denied|blocked by|safety check|permission (check|prompt|rule)|auto mode|classifier|not allowed|was blocked)\b/i

// The word that names a refused action: "Bash: git push origin master" gives "push".
const actionWord = (call: string): string => {
  const parts = call.replace(/^[\w-]+:\s*/, '').trim().split(/\s+/)
  const second = parts[1] ?? ''
  return /^[a-z][\w-]{2,}$/i.test(second) ? second.toLowerCase() : (parts[0] ?? '').toLowerCase()
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const REFUSED_ANSWER = "leave it for the owner. A permission or safety check refused it, so only the owner can say yes. Don't try it another way."

// Answers about an action a permission or safety check refused are never given on the owner's behalf.
export const guardRefused = (answers: readonly Settled[], refused: readonly string[]): Settled[] => {
  const actions = refused.map(actionWord).filter(word => word.length >= 3)
  return answers.map(item => {
    const line = `${item.question} ${item.answer}`.toLowerCase()
    const isAboutRefused = REFUSAL_WORDS.test(item.question) || actions.some(word => new RegExp(`\\b${escapeRe(word)}\\b`).test(line))
    return isAboutRefused ? { question: item.question, answer: REFUSED_ANSWER } : item
  })
}
