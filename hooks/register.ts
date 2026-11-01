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
    '- Never stop to ask the owner something or wait for approval. Nobody will answer for hours. Make the call yourself: pick what best serves the goal, prefer choices that can be undone, and keep going.',
    '- AskUserQuestion is switched off. Ending your turn with a question wastes the night.',
    '- Keep a short "Decisions I made" list in your final summary so the owner can check them in the morning.',
    '- If one item truly needs the owner (a password, a payment, publishing, anything that cannot be undone), set it aside, note it, and do all the other work you can, in parallel where you can (background tasks, subagents).',
    '- Run scripts so they never wait on the keyboard: --yes style flags, CI=1, timeouts, background runs for long jobs.',
    '- Permission prompts are answered for you: safe local steps are approved, destructive or outward-facing ones are refused. When one is refused, find a safer way or set it aside, and keep going.',
    '- Before you say done, check it yourself: every part of the goal met (not a sample), the real output looked at this turn (screenshots for anything visual; tests alone are not looking), held up against any mock or reference, and no "still open" list. A strict review will check the same and send it back if it falls short.',
    '- End your turn only when the goal is done and checked, or when everything left needs the owner.',
  ].join('\n')

const nudgeText = (ending: Ending, goal: string): string =>
  ending === 'needs-a-human'
    ? `${NUDGE_MARK} the owner is away and can't help right now. Note what you need from them for the morning, then do every other part of the goal you can without it (${goal || 'see the task above'}). Stop once nothing else can move.`
    : `${NUDGE_MARK} the owner is asleep and asked you to work on your own, so nobody will answer that. Make the call yourself: choose what best serves the goal (${goal || 'see the task above'}), prefer choices that can be undone, add it to your "Decisions I made" list, and keep going. If one item truly needs the owner, set it aside and do everything else.`

const reviewText = (gaps: string, round: number, notes: string): string =>
  [
    `${NUDGE_MARK} not done yet. A strict review against the owner's goal (round ${round}) sent it back with these gaps:`,
    gaps,
    'Close them, most important first. Look at the real output each time (run it, open it, screenshot it and put it next to the reference) and keep improving until it meets the goal, not just until it works. Do the whole thing, not a sample, and end with proof: what you looked at and a met / not met list against the goal.',
    ...(notes ? [`How the owner checks work: ${notes}`] : []),
  ].join('\n')

const checkText = (goal: string, idleMs: number): string =>
  [
    `${CHECK_MARK}: the owner is still away and this session has been idle for ${minutes(idleMs)}.`,
    `Goal: ${goal || '(the task the owner gave you in this conversation)'}`,
    '1. Look for anything stuck: a question you asked, a decision you put off, a background job or agent that failed or hung, a script waiting on input. Settle it yourself.',
    '2. If work toward the goal is left, carry on with it now.',
    '3. If the goal is fully done, check it (run the tests or checks it calls for), then say it is done in one line with your "Decisions I made" list.',
  ].join('\n')

const stallText = (stallMs: number): string =>
  `${NUDGE_MARK} your last turn sat for ${minutes(stallMs)} with no progress (most likely a prompt or a hung command), so nightshift stopped it. Don't run the same thing the same way again: use non-interactive flags, a timeout, or a background run, or take another route. Then keep going on the goal.`

// Goal from the conversation when `/nightshift` is run without one.
const goalFromConversation = async ($: $): Promise<string> => {
  // Skip wrappers, slash commands and prompts any plugin sent (nightshift's own included).
  const rows = (await $.session.messages()).filter(
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
    await patchPilot($, { lastTurnEndAt: now })
    await log($, 'check', `nothing happened for ${minutes(quietMs)}`)
    void $.prompt.submit({ text: checkText(pilot.goal, quietMs) })
  }

  return showStatus($)
}

export const register: Register = (on, options) => {
  const everyDefaultMs = Math.max(1, Number(options.everyMinutes ?? 15)) * 60_000
  const stallMs = Math.max(5, Number(options.stallMinutes ?? 30)) * 60_000
  const extraDeny = parseExtraDeny(options.extraDeny)
  const maxReviews = Math.max(0, Number(options.maxReviews ?? 5))
  const reviewNotes = String(options.reviewNotes ?? '').trim()

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

    const goal = parsed.goal || pilot.goal || (await goalFromConversation($))
    const everyMs = parsed.everyMinutes ? parsed.everyMinutes * 60_000 : everyDefaultMs
    const now = await $.clock.now()
    const hasConversation = (await $.session.messages()).length > 0
    const next = await patchPilot($, {
      isOn: true,
      goal,
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
    const risk = rule ? 'risky' : FILE_TOOLS.has(e.tool_name) ? 'safe' : await classify($, riskText(call), RISK_LABELS)

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
    const pilot = await patchPilot($, { isTurnRunning: false, lastTurnEndAt: now, isAbortedByPilot: false })
    if (!pilot.isOn) return done

    if (e.isAborted) {
      if (before.isAbortedByPilot) {
        await log($, 'nudge', 'restart after stall')
        void $.prompt.submit({ text: stallText(stallMs) })
      }
      return done
    }
    if (e.reason !== 'answer') return done

    const ending = ((await classify($, endingText(e.answer), ENDING_LABELS)) ?? guessEnding(e.answer)) as Ending
    // The Stop event that lists background work may land just after this one.
    if (!hasFreshStop(await getPilot($))) await $.clock.sleep(1500)
    const settled = await getPilot($)
    const step = afterTurn({ ending, ...settled, maxReviews, isWorkRunning: await isWorkRunning($, settled) })
    await patchPilot($, { nudgesInRow: step.nudgesInRow })

    if (step.action === 'review') {
      const reply = await $.model.fork({ prompt: reviewPrompt(pilot.goal, reviewNotes) })
      const review = reply.isAnswered ? parseReview(reply.text) : undefined
      const round = pilot.reviewRounds + 1
      await patchPilot($, { reviewRounds: round })

      if (review === undefined) {
        await log($, 'review', `round ${round}: no review (${reply.isAnswered ? '' : reply.reason}); next check-in will retry`)
      } else if (review.isPass) {
        await patchPilot($, { isGoalDone: true })
        await log($, 'done', `review round ${round} passed; check-ins paused`)
      } else {
        await log($, 'review', `round ${round} failed: ${review.gaps.replace(/\s+/g, ' ')}`)
        void $.prompt.submit({ text: reviewText(review.gaps, round, reviewNotes) })
      }
    }
    if (step.action === 'hold') {
      await log($, 'nudge', `holding: ${pilot.nudgesInRow} nudges with no work done; next check-in will retry`)
    }
    if (step.action === 'nudge') {
      await log($, 'nudge', `${ending}: ${e.answer.slice(-160).replace(/\s+/g, ' ')}`)
      void $.prompt.submit({ text: nudgeText(ending, pilot.goal) })
    }
    void showStatus($)

    return done
  })
}
