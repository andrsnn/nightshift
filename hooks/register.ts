import type { EngineInterface, Register } from 'claude-code'

import type { NightshiftLogEntry, NightshiftPilot } from '../types'
import {
  afterTurn,
  describeCall,
  FILE_TOOLS,
  endingText,
  ENDING_LABELS,
  guessEnding,
  minutes,
  neverRule,
  parseArgs,
  parseExtraDeny,
  parseReview,
  reviewPrompt,
  riskText,
  DEFAULT_BUDGET,
  RISK_LABELS,
} from './judge'
import type { Ending } from './judge'

const PILOT = { plugin: 'nightshift', key: 'pilot' } as const
const LOG_KEEP = 300
const CHECK_MARK = 'Nightshift check-in'
const NUDGE_MARK = 'Nightshift:'

const OFF: NightshiftPilot = {
  isOn: false,
  goal: '',
  everyMs: 15 * 60_000,
  isTurnRunning: false,
  turnId: '',
  turnKind: 'other',
  lastActivityAt: 0,
  lastTurnEndAt: 0,
  workInFlight: 0,
  stopAt: 0,
  toolCallsThisTurn: 0,
  nudgesInRow: 0,
  reviewRounds: 0,
  isGoalDone: false,
  isAbortedByPilot: false,
  pendingAnswer: '',
}

type $ = EngineInterface

const getPilot = async ($: $): Promise<NightshiftPilot> => {
  const { value } = await $.state.get(PILOT)

  return { ...OFF, ...(value ?? {}) }
}

const patchPilot = async ($: $, patch: Partial<NightshiftPilot>): Promise<NightshiftPilot> => {
  const next = { ...(await getPilot($)), ...patch }
  await $.state.set(PILOT, next)

  return next
}

const log = async ($: $, kind: NightshiftLogEntry['kind'], text: string): Promise<void> => {
  const [at, session, held] = await Promise.all([$.clock.now(), $.session.id(), $.store.get('log')])
  const list = Array.isArray(held) ? (held as NightshiftLogEntry[]) : []
  await $.store.set('log', [...list, { at, session, kind, text: text.slice(0, 300) }].slice(-LOG_KEEP))
}

const rules = (goal: string): string =>
  [
    'Nightshift is on. The owner is away, probably asleep, and asked you to work on your own until the goal is met.',
    `Goal: ${goal || '(the task the owner gave you in this conversation)'}`,
    '- Never stop to ask the owner something or wait for approval. Make the call yourself: pick what best serves the goal, prefer choices that can be undone, and keep going. Where you have a recommendation ("I\'d pick B"), take it.',
    `- ${WAIT_RULE}`,
    `- ${BOUND_RULE}`,
    `- ${CLEANUP_RULE}`,
    `- ${costRule()}`,
    '- AskUserQuestion is switched off. Ending your turn with a question wastes the night.',
    '- Keep a short "Decisions I made" list in your final summary so the owner can check them in the morning.',
    `- ${STATUS_RULE}`,
    '- If one item truly needs the owner, note it and do all the other work you can, in parallel where you can (background tasks, subagents).',
    '- Run scripts so they never wait on the keyboard: --yes style flags, CI=1, timeouts, background runs for long jobs.',
    '- Permission prompts are answered for you: safe local steps are approved, destructive or outward-facing ones are refused. When one is refused, find a safer way or set it aside, and keep going.',
    '- Before you say done, check it yourself: every part of the goal met (not a sample), the real output looked at this turn (screenshots for anything visual; tests alone are not looking), held up against any mock or reference, and no "still open" list. A strict review will check the same and send it back if it falls short.',
    '- End your turn only when the goal is done and checked, or when everything left needs the owner.',
  ].join('\n')

// The only things that may wait for the owner. Everything else gets decided.
// Set from the owner's budget setting when the module registers.
let budget = DEFAULT_BUDGET
let maxReviews = 5
let reviewNotes = ''
const costRule = (): string => `Money: ${budget} When you choose, choose the cheapest option that does the job.`

const WAIT_RULE =
  'Only four kinds of thing may wait for the owner: a password or login, spending beyond a budget the owner already set, making something public or sending it to other people, and deleting something that cannot be got back. Picking between options, approving a sample or draft, choosing a model or tool to test within the budget, and settling a design are yours to decide. A "needs your OK" list of anything else is not allowed.'

// Owner: "keep it bounded ... make sure we work on bounded smart tasks." Every task and subagent brief has an end.
const BOUND_RULE =
  'Keep every task bounded. Before you start a task or brief a subagent, write down where it ends: the exact steps, the one check that proves it, at most two tries at that check, and a time limit (an hour at most). Then stop and report, done or not. No open-ended loops: no "run it until it passes", no proof run after proof run, no new tuning rounds past the stated end. If the check still fails after two tries, report what fails and move on to the next task. Pick the smallest task that moves the goal forward.'

// Status messages in one shape, so the owner can scan them and nightshift can read the open goals back out
// of the latest one (see openGoals). The skill ships with this plugin as nightshift:status-update.
const STATUS_RULE =
  'Write every progress or status message with the nightshift:status-update skill: Update, then GOALS (every goal the owner asked for, in their words, each marked DOING, DONE, BLOCKED, PAUSED or DROPPED), then WIP, DONE, ISSUES and NEED ME. Nightshift reads the GOALS list from your latest update to keep its goal current.'

// Owner: "if you spin resources up its up to you to clean up after yourself not force someone else to."
const CLEANUP_RULE =
  'Clean up after yourself. Whatever you or your helper agents start, you stop: dev servers, browsers, background jobs, watchers, cloud machines, temp files and folders. Every task and subagent brief ends with "stop what you started and delete your temp files", and you check it was done. Before you report a task done, list what is still running from your work and stop anything no longer needed. Never hand the owner a list of processes to kill or files to delete: stop and delete them yourself, using their exact process IDs or paths.'

const nudgeText = (ending: Ending, goal: string): string =>
  ending === 'needs-a-human'
    ? `${NUDGE_MARK} the owner can't help right now. Note what you need from them, then do every other part of the goal you can without it (${goal || 'see the task above'}). ${WAIT_RULE}`
    : `${NUDGE_MARK} the owner asked you to work without them, so settle that yourself: choose what best serves the goal (${goal || 'see the task above'}), take your own recommendation where you made one, prefer choices that can be undone, add it to your "Decisions I made" list, and keep going. ${WAIT_RULE} ${BOUND_RULE} ${CLEANUP_RULE}`

// When the session leaves questions for the owner, a fork of it answers them as the owner would.
const standInPrompt = (goal: string): string =>
  [
    'Step out of your role for a moment. You are standing in for the owner, who wants every open question settled without them.',
    "The owner's goal:",
    goal || '(the task the owner gave at the start of this conversation)',
    '',
    'List every question, decision or approval your last message left for the owner, including anything "set aside", "waiting for you" or listed in a decisions file you mentioned.',
    "For each, give the answer the owner would most likely give, from the goal, what they said in this conversation and their standing rules. Where you made a recommendation, that is the answer, unless a cheaper option does the job just as well: then pick the cheaper one.",
    costRule(),
    'Answer "skip it for now and do the rest" only for a password or login, spending beyond that budget, making something public or sending it to people, or deleting something that cannot be got back.',
    'A "Decisions I made" list or a summary of choices already made is not open: leave it out.',
    'Reply as a numbered list, one line each: the question in a few words, then the answer. No preamble. If nothing is actually left open for the owner, reply with exactly NONE.',
  ].join('\n')

const answersText = (answers: string): string =>
  [
    `${NUDGE_MARK} the owner wants these settled without them. Answers on their behalf:`,
    answers,
    `Act on them now, add them to your "Decisions I made" list, and keep going. ${WAIT_RULE} ${BOUND_RULE} ${CLEANUP_RULE} ${costRule()}`,
  ].join('\n')

const reviewText = (gaps: string, round: number, notes: string): string =>
  [
    `${NUDGE_MARK} not done yet. A strict review against the owner's goal (round ${round}) sent it back with these gaps:`,
    gaps,
    'Close them, most important first, each as its own bounded task. Look at the real output each time (run it, open it, screenshot it and put it next to the reference). Do the whole thing, not a sample, and end with proof: what you looked at and a met / not met list against the goal.',
    BOUND_RULE,
    ...(notes ? [`How the owner checks work: ${notes}`] : []),
  ].join('\n')

const checkText = (goal: string, idleMs: number): string =>
  [
    `${CHECK_MARK}: the owner is still away and this session has been idle for ${minutes(idleMs)}.`,
    `Goal: ${goal || '(the task the owner gave you in this conversation)'}`,
    '1. Look for anything stuck: a question you asked, a decision you put off, a background job or agent that failed or hung, a script waiting on input. Settle it yourself.',
    `2. Look for anything open-ended: an agent or job looping on runs, retries or tuning with no stated end. Give it a bound now or stop it and take its report. ${BOUND_RULE}`,
    '3. Make sure no paid cloud machine (a RunPod pod or the like) is left running with nothing to do; shut down and delete any that are.',
    `4. List the dev servers, browsers, background jobs and temp folders that you or your agents started (match by command line, port, path and start time). Stop and delete every one that is no longer needed, yourself. ${CLEANUP_RULE}`,
    '5. If work toward the goal is left, carry on with it now as bounded tasks.',
    '6. If the goal is fully done, check it (run the tests or checks it calls for), then say it is done in one line with your "Decisions I made" list.',
  ].join('\n')

const stallText = (stallMs: number): string =>
  `${NUDGE_MARK} your last turn sat for ${minutes(stallMs)} with no progress (most likely a prompt or a hung command), so nightshift stopped it. Don't run the same thing the same way again: use non-interactive flags, a timeout, or a background run, or take another route. Then keep going on the goal.`

// The goals still open in Claude's latest status update: a "GOALS" heading followed by lines like
// "G2 <the goal in the owner's words> - DOING". Finished and dropped goals are left out.
export const openGoals = (text: string): string[] => {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex(line => line.trim() === 'GOALS')
  if (at < 0) return []
  lines.splice(0, at + 1)
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      if (out.length) break
      continue
    }
    const m = line.match(/^(G\d+)\s+(.+?)\s+[-\u2013\u2014]\s+(DOING|DONE|BLOCKED|PAUSED|DROPPED)\s*$/i)
    if (!m) break
    if (!/^(DONE|DROPPED)$/i.test(m[3] ?? '')) out.push(`${m[1]} ${m[2]} (${(m[3] ?? '').toUpperCase()})`)
  }
  return out
}

// Goal from the conversation when `/nightshift` is run without one: the open goals in Claude's latest status
// update when there is one, otherwise the owner's first message; plus the owner's latest message either way.
const goalFromConversation = async ($: $): Promise<string> => {
  const all = await $.session.messages()
  const status = [...all].reverse().find(row => row.role === 'assistant' && openGoals(row.text).length > 0)
  // Skip wrappers, slash commands and prompts any plugin sent (nightshift's own included).
  const rows = all.filter(
    row =>
      row.role === 'user' &&
      row.text.trim() !== '' &&
      !/^\s*[</]/.test(row.text) &&
      !/plugin sent a message/i.test(row.text) &&
      !row.text.includes(NUDGE_MARK) &&
      !row.text.includes(CHECK_MARK),
  )
  const first = rows[0]?.text.trim().slice(0, 800) ?? ''
  const last = rows.length > 1 ? (rows[rows.length - 1]?.text.trim().slice(0, 600) ?? '') : ''
  if (status) {
    const goals = `Open goals:\n${openGoals(status.text).join('\n')}`.slice(0, 1500)
    return last ? `${goals}\n(Latest from the owner: ${last})` : goals
  }

  return last && last !== first ? `${first}\n(Latest from the owner: ${last})` : first
}

const classify = async ($: $, text: string, labels: readonly string[]): Promise<string | undefined> => {
  try {
    return await $.model.classify(text, labels)
  } catch {
    return undefined
  }
}

// Work still in flight wakes the session when it reports, so waiting on it is not being stuck.
// The Stop event lists every kind (background commands, agents, monitors, workflows,
// scheduled wake-ups); the agent list backs it up.
const hasFreshStop = (pilot: NightshiftPilot): boolean => pilot.stopAt >= pilot.lastTurnEndAt - 3000

const isWorkRunning = async ($: $, pilot: NightshiftPilot): Promise<boolean> => {
  if (hasFreshStop(pilot) && pilot.workInFlight > 0) return true
  try {
    return (await $.agent.list()).some(agent => agent.status === 'running' || agent.status === 'pending')
  } catch {
    return false
  }
}

// The last sign of life: a turn ending, or any tool call, subagents' included.
const quietSince = (pilot: NightshiftPilot): number => Math.max(pilot.lastTurnEndAt, pilot.lastActivityAt)

const showStatus = async ($: $): Promise<void> => {
  const pilot = await getPilot($)
  if (!pilot.isOn) return $.ui.status(undefined)
  if (pilot.isGoalDone) return $.ui.status('nightshift: goal done')
  if (pilot.isTurnRunning) return $.ui.status('nightshift on')

  $.ui.status('nightshift on · watching')
}

// Remembered per session, so nightshift stays on when the session restarts.
const remember = async ($: $, pilot: NightshiftPilot | undefined): Promise<void> => {
  const session = await $.session.id()
  const held = await $.store.get('sessions')
  const all = (held && typeof held === 'object' ? held : {}) as Record<string, { goal: string; everyMs: number; at: number }>
  const now = await $.clock.now()
  const kept = Object.fromEntries(Object.entries(all).filter(([id, row]) => id !== session && now - row.at < 7 * 86_400_000))
  await $.store.set('sessions', pilot ? { ...kept, [session]: { goal: pilot.goal, everyMs: pilot.everyMs, at: now } } : kept)
}

// Sends only while the session is still quiet: the owner may have typed during a slow review.
const send = async ($: $, text: string): Promise<boolean> => {
  if ((await getPilot($)).isTurnRunning) return false
  void $.prompt.submit({ text })
  return true
}

// `pilot` is the state from before the tick reset the idle clock, so background work still shows.
const followUp = async ($: $, answer: string, pilot: NightshiftPilot): Promise<boolean> => {
  const ending = ((await classify($, endingText(answer), ENDING_LABELS)) ?? guessEnding(answer)) as Ending
  const step = afterTurn({ ending, ...pilot, maxReviews, isWorkRunning: await isWorkRunning($, pilot) })
  await patchPilot($, { nudgesInRow: step.nudgesInRow })

  if (step.action === 'review') {
    const reply = await $.model.fork({ prompt: reviewPrompt(pilot.goal, reviewNotes, budget) })
    const review = reply.isAnswered ? parseReview(reply.text) : undefined
    const round = pilot.reviewRounds + 1
    await patchPilot($, { reviewRounds: round })

    if (review === undefined) {
      await log($, 'review', `round ${round}: no review (${reply.isAnswered ? '' : reply.reason}); next check-in will retry`)
      return false
    }
    if (review.isPass) {
      await patchPilot($, { isGoalDone: true })
      await log($, 'done', `review round ${round} passed; check-ins paused`)
      return false
    }
    await log($, 'review', `round ${round} failed: ${review.gaps.replace(/\s+/g, ' ')}`)
    return send($, reviewText(review.gaps, round, reviewNotes))
  }
  if (step.action === 'hold') {
    await log($, 'nudge', `holding: ${pilot.nudgesInRow} nudges with no work done; next check-in will retry`)
    return false
  }
  if (step.action === 'nudge' && ending === 'asks-a-question') {
    const reply = await $.model.fork({ prompt: standInPrompt(pilot.goal) })
    const answers = reply.isAnswered ? reply.text.trim() : ''
    if (/^NONE/i.test(answers)) {
      // Nothing was really left open (a summary of decisions read as questions): say nothing.
      await patchPilot($, { nudgesInRow: pilot.nudgesInRow })
      await log($, 'answer', 'nothing left open; no message sent')
      return false
    }
    await log($, 'answer', answers ? answers.replace(/\s+/g, ' ') : `no stand-in answer (${reply.isAnswered ? 'empty' : reply.reason})`)
    return send($, answers ? answersText(answers) : nudgeText(ending, pilot.goal))
  }
  if (step.action === 'nudge') {
    await log($, 'nudge', `${ending}: ${answer.slice(-160).replace(/\s+/g, ' ')}`)
    return send($, nudgeText(ending, pilot.goal))
  }

  return false
}

const tick = async ($: $, stallMs: number): Promise<void> => {
  const pilot = await getPilot($)
  if (!pilot.isOn || pilot.isGoalDone) return showStatus($)

  const now = await $.clock.now()

  if (pilot.isTurnRunning && now - pilot.lastActivityAt >= stallMs && !pilot.isAbortedByPilot) {
    await patchPilot($, { isAbortedByPilot: true })
    await log($, 'stall', `no activity for ${minutes(now - pilot.lastActivityAt)}; stopping the turn`)
    try {
      await $.turn.abort({ turnId: pilot.turnId })
    } catch {
      await patchPilot($, { isAbortedByPilot: false, lastActivityAt: now })
    }
    return showStatus($)
  }

  // Check in only when nothing at all has happened for the whole interval: no turn, no tool
  // call from any agent. A session whose agents are busy is left alone.
  // With work still in flight, give it until the stall limit before asking what's stuck.
  const quietMs = now - quietSince(pilot)
  const limitMs = hasFreshStop(pilot) && pilot.workInFlight > 0 ? Math.max(pilot.everyMs, stallMs) : pilot.everyMs
  if (!pilot.isTurnRunning && quietMs >= limitMs) {
    // Stamp now so a slow start doesn't fire a second check.
    await patchPilot($, { lastTurnEndAt: now, pendingAnswer: '' })
    // The last answer is followed up only now, after a whole quiet interval, so the owner
    // gets the chance to reply first.
    if (pilot.pendingAnswer && (await followUp($, pilot.pendingAnswer, pilot))) return showStatus($)
    const after = await getPilot($)
    if (after.isGoalDone || after.isTurnRunning) return showStatus($)
    await log($, 'check', `nothing happened for ${minutes(quietMs)}`)
    void $.prompt.submit({ text: checkText(pilot.goal, quietMs) })
  }

  return showStatus($)
}

export const register: Register = (on, options) => {
  const everyDefaultMs = Math.max(1, Number(options.everyMinutes ?? 15)) * 60_000
  const stallMs = Math.max(5, Number(options.stallMinutes ?? 30)) * 60_000
  const extraDeny = parseExtraDeny(options.extraDeny)
  maxReviews = Math.max(0, Number(options.maxReviews ?? 5))
  reviewNotes = String(options.reviewNotes ?? '').trim()
  budget = String(options.budget ?? '').trim() || DEFAULT_BUDGET

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nightshift',
      description: 'Keep working while I\'m away: no questions, prompts settled, check-ins',
      argumentHint: '[off|status|log|<minutes>m] [goal]',
      immediate: true,
    })
    $.clock.every(60_000, () => void tick($, stallMs))

    // A restarted session picks up where it left off.
    const pilot = await getPilot($)
    const held = (await $.store.get('sessions')) as Record<string, { goal: string; everyMs: number }> | undefined
    const saved = held?.[await $.session.id()]
    if (!pilot.isOn && saved) {
      const now = await $.clock.now()
      await patchPilot($, { isOn: true, goal: saved.goal, everyMs: saved.everyMs, lastTurnEndAt: now, lastActivityAt: now })
      await log($, 'on', 'back on after a restart')
    }
    await showStatus($)

    return next(e)
  })

  on('command.run', { command: 'nightshift' }, async ($, e) => {
    const parsed = parseArgs(e.args)
    const pilot = await getPilot($)

    if (parsed.kind === 'help') {
      return {
        text: [
          '/nightshift [goal]        turn on; the goal defaults to what you asked earlier',
          '/nightshift 10m [goal]    turn on with a 10-minute check-in',
          '/nightshift status        what it is doing',
          '/nightshift log           what it approved, refused and nudged',
          '/nightshift off           turn off',
        ].join('\n'),
      }
    }

    if (parsed.kind === 'off') {
      await patchPilot($, { isOn: false })
      await remember($, undefined)
      await log($, 'off', '')
      await showStatus($)
      return { text: 'Nightshift off.', context: ['Nightshift is off: the owner is back. Ask them what you need to.'] }
    }

    if (parsed.kind === 'status') {
      if (!pilot.isOn) return { text: 'Nightshift is off.' }
      const now = await $.clock.now()
      return {
        text: [
          pilot.isGoalDone ? 'Nightshift on: goal reported done; check-ins paused.' : 'Nightshift on.',
          `Goal: ${pilot.goal || '(from the conversation)'}`,
          pilot.isTurnRunning
            ? `Working; last activity ${minutes(now - pilot.lastActivityAt)} ago.`
            : `Idle ${minutes(now - pilot.lastTurnEndAt)}; checks in after ${minutes(pilot.everyMs)} idle.`,
          `Nudges in a row: ${pilot.nudgesInRow}.`,
        ].join('\n'),
      }
    }

    if (parsed.kind === 'log') {
      const session = await $.session.id()
      const held = await $.store.get('log')
      const rows = (Array.isArray(held) ? (held as NightshiftLogEntry[]) : [])
        .filter(row => row.session === session)
        .slice(-40)
      if (rows.length === 0) return { text: 'Nothing logged in this session yet.' }
      return {
        text: rows
          .map(row => `${new Date(row.at).toISOString().slice(11, 16)}  ${row.kind.padEnd(5)}  ${row.text}`)
          .join('\n'),
      }
    }

    // A goal the owner typed is kept; one taken from the conversation is rebuilt, so it follows the latest status.
    const goal = parsed.goal || (pilot.isGoalGiven ? pilot.goal : '') || (await goalFromConversation($)) || pilot.goal
    const everyMs = parsed.everyMinutes ? parsed.everyMinutes * 60_000 : everyDefaultMs
    const now = await $.clock.now()
    const hasConversation = (await $.session.messages()).length > 0
    const next = await patchPilot($, {
      isOn: true,
      goal,
      isGoalGiven: Boolean(parsed.goal) || (Boolean(pilot.isGoalGiven) && goal === pilot.goal),
      everyMs,
      isGoalDone: false,
      nudgesInRow: 0,
      reviewRounds: 0,
      lastTurnEndAt: pilot.isTurnRunning ? pilot.lastTurnEndAt : now,
      lastActivityAt: now,
    })
    await remember($, next)
    await log($, 'on', `every ${minutes(everyMs)}: ${goal.slice(0, 200)}`)
    await showStatus($)

    // Submitting from inside the command would wait on itself, so hand it to a timer.
    if (!next.isTurnRunning) {
      $.clock.after(500, () => void $.prompt.submit(
        hasConversation || !parsed.goal
          ? { text: `${NUDGE_MARK} nightshift is now on and the owner is going away. If you were waiting on them, decide yourself and carry on toward the goal: ${goal || 'see the task above'}` }
          : { text: parsed.goal, asUser: true },
      ))
    }

    return {
      text: `Nightshift on. Check-ins after ${minutes(everyMs)} idle; /nightshift off to stop.\nGoal: ${goal || '(none found; it will use the conversation)'}`,
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const pilot = await getPilot($)
    if (!pilot.isOn) return composed

    return {
      sections: [...composed.sections, { id: 'nightshift:rules', text: rules(pilot.goal), scope: 'session' }],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // The owner typed something: they're here, so start the nudge count afresh.
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      const pilot = await getPilot($)
      if (pilot.isOn) await patchPilot($, { nudgesInRow: 0, reviewRounds: 0, isGoalDone: false })
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    // A plugin's prompt reaches the turn framed ("The nightshift plugin sent a message: ...").
    const turnKind = e.text.includes(CHECK_MARK) ? 'check' : e.text.includes(NUDGE_MARK) ? 'nudge' : 'other'
    await patchPilot($, {
      isTurnRunning: true,
      turnId: e.turnId,
      turnKind,
      toolCallsThisTurn: 0,
      lastActivityAt: await $.clock.now(),
      pendingAnswer: '',
    })
    void showStatus($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const pilot = await getPilot($)
    if (pilot.isOn) {
      await patchPilot($, {
        lastActivityAt: await $.clock.now(),
        toolCallsThisTurn: pilot.toolCallsThisTurn + 1,
      })
    }

    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const pilot = await getPilot($)
    if (!pilot.isOn) return next(e)

    if (e.tool === 'AskUserQuestion') {
      await log($, 'deny', 'AskUserQuestion')
      return {
        decision: 'deny',
        reason: 'Nightshift is on and the owner is away, so nobody can answer. Pick the option you would recommend, add it to your "Decisions I made" list, and keep going.',
      }
    }
    if (e.tool === 'EnterPlanMode') {
      return { decision: 'deny', reason: 'Nightshift is on: nobody can approve a plan. Skip plan mode and do the work.' }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Only a prompt that would really wait for the owner gets here: rules and auto mode's own
  // classifier have already had their say.
  on('classic.PermissionRequest', async ($, e, next) => {
    const pilot = await getPilot($)
    if (!pilot.isOn) return next(e)

    const call = describeCall(e.tool_name, e.tool_input)
    const rule = neverRule(call, extraDeny)
    const risk = rule ? 'risky' : FILE_TOOLS.has(e.tool_name) ? 'safe' : await classify($, riskText(call, budget), RISK_LABELS)

    if (risk === 'risky') {
      await log($, 'deny', call)
      return {
        decision: {
          behavior: 'deny',
          message: `Nightshift refused this because it looks destructive or outward-facing${rule ? ` (matches ${rule.source})` : ''}, and the owner is away. Find a safer way to do it, or set it aside for the owner, note it, and keep going with the rest.`,
        },
      }
    }

    await log($, 'allow', call)
    return { decision: { behavior: 'allow' } }
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    await patchPilot($, {
      workInFlight: (e.background_tasks?.length ?? 0) + (e.session_crons?.length ?? 0),
      stopAt: await $.clock.now(),
    })

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const before = await getPilot($)
    const now = await $.clock.now()
    const pilot = await patchPilot($, { isTurnRunning: false, lastTurnEndAt: now, isAbortedByPilot: false, pendingAnswer: '' })
    if (!pilot.isOn) return done

    if (e.isAborted) {
      if (before.isAbortedByPilot) {
        await log($, 'nudge', 'restart after stall')
        void $.prompt.submit({ text: stallText(stallMs) })
      }
      return done
    }
    if (e.reason !== 'answer') return done

    // Say nothing yet: the owner may be about to reply. The tick follows up once the session
    // has been quiet for the whole check-in interval.
    await patchPilot($, { pendingAnswer: e.answer })
    void showStatus($)

    return done
  })
}
