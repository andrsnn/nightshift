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

export const riskText = (call: string): string =>
  [
    'An AI coding agent working alone on the owner\'s own computer wants to run this tool call.',
    'safe: it stays on this machine and can be undone or is harmless (builds, tests, scripts, installs, edits, local git, reading anything, pushing a normal branch to the owner\'s own repo).',
    'risky: it destroys data that cannot be got back, spends money, or publishes or sends something to other people or public places (deploys, releases, emails, chat messages, posts, force pushes, deleting cloud resources).',
    '',
    'Tool call:',
    call.slice(0, 3000),
  ].join('\n')

export const ENDING_LABELS = ['asks-a-question', 'stopped-early', 'finished', 'needs-a-human'] as const
export type Ending = (typeof ENDING_LABELS)[number]

export const endingText = (answer: string): string =>
  [
    'How does this final message of an AI coding agent end its turn?',
    'asks-a-question: it asks the user something, offers options to pick from, or asks for approval or confirmation before going on.',
    'stopped-early: it reports progress or a plan, but stops while work on its task is still left to do.',
    'finished: it says the task is done, perhaps with a summary, and asks nothing.',
    'needs-a-human: it cannot go on without something only a person can give (a password, a login, a payment, a physical action).',
    '',
    'Message:',
    answer.slice(-4000),
  ].join('\n')

const ASKING =
  /\?\s*$|\b(should i|shall i|do you want|would you like|want me to|let me know|which (one|option)|your call|before i (continue|proceed|go ahead)|can you confirm|please confirm|ok to proceed|okay to proceed|waiting for your|awaiting your)\b/i

// The fallback when the classifier can't answer: a question near the end of the message.
export const guessEnding = (answer: string): Ending =>
  ASKING.test(answer.slice(-500)) ? 'asks-a-question' : 'finished'

const MAX_NUDGES_IN_ROW = 3

// What to do when a main-loop turn ends. Nudges in a row count only turns that
// did no work, so a session that keeps asking without acting is left alone
// until the next check-in instead of looping. A "done" claim goes to a strict
// review until the review passes or the rounds run out.
export const afterTurn = (turn: {
  ending: Ending
  toolCallsThisTurn: number
  nudgesInRow: number
  reviewRounds: number
  maxReviews: number
}): { action: 'review' | 'done' | 'hold' | 'nudge'; nudgesInRow: number } => {
  const nudgesInRow = turn.toolCallsThisTurn > 0 ? 0 : turn.nudgesInRow

  if (turn.ending === 'finished') {
    return { action: turn.reviewRounds < turn.maxReviews ? 'review' : 'done', nudgesInRow: 0 }
  }

  // A human-only block gets one nudge to do everything else; a question gets a few.
  const limit = turn.ending === 'needs-a-human' ? 1 : MAX_NUDGES_IN_ROW

  return nudgesInRow >= limit ? { action: 'hold', nudgesInRow } : { action: 'nudge', nudgesInRow: nudgesInRow + 1 }
}

// The question put to a fork of the session when it says it is done. The
// checks come from mining one owner's pushback on "done" claims (research/).
export const reviewPrompt = (goal: string, notes: string): string =>
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
  | { kind: 'on'; goal: string; everyMinutes?: number }

export const parseArgs = (args: string): Parsed => {
  const text = args.trim()
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
