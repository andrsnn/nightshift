export type NightshiftPilot = {
  isOn: boolean
  goal: string
  everyMs: number
  isTurnRunning: boolean
  turnId: string
  // 'check' and 'nudge' are turns nightshift started; 'other' is anything else.
  turnKind: 'check' | 'nudge' | 'other'
  lastActivityAt: number
  lastTurnEndAt: number
  // Background work (commands, agents, monitors, workflows, scheduled wake-ups) the last Stop reported.
  workInFlight: number
  stopAt: number
  toolCallsThisTurn: number
  nudgesInRow: number
  // Strict reviews of a "done" claim since the owner last typed.
  reviewRounds: number
  isGoalDone: boolean
  isAbortedByPilot: boolean
}

export type NightshiftLogEntry = {
  at: number
  session: string
  kind: 'on' | 'off' | 'allow' | 'deny' | 'nudge' | 'check' | 'stall' | 'review' | 'answer' | 'done'
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    nightshift: { pilot: NightshiftPilot }
  }
}
