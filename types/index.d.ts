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
  // true when the owner typed the goal after /nightshift; otherwise it is rebuilt from the conversation each time
  isGoalGiven?: boolean
  // The last answer, held until the session has been quiet for the check-in interval. Empty when nothing waits.
  pendingAnswer: string
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
