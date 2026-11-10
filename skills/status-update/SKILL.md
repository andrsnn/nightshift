---
name: status-update
description: Use for EVERY progress or status message to the owner (after a step, when a background job reports, when asked "status"/"ETA"/"what are you doing", before ending a turn on long work). A short update in fixed sections that never mix - Update (3-4 brief sentences), GOALS (every goal the owner asked for, with its state), then WIP, DONE, ISSUES, NEED ME, where every line starts with the goal ID it serves - so the owner sees what each piece of work is for and what is finished. Keeps STATUS.md so the mission and goals survive compaction, and says when an approved goal may be resumed without asking.
---

# Status update

**The problem this solves:** the owner has to dig through a mixed list to see what is finished, what is still running, what is stuck, and what any of it is for. So every update lists the owner's goals first, uses the same sections in the same order, and starts every line with the goal it serves.

## The update

```
Update: <3-4 brief sentences: what the mission is, where it stands now, and what lands next and when>

GOALS
G1 <the goal, in the owner's words> - <DOING | DONE | BLOCKED | PAUSED | DROPPED>
G2 <the goal, in the owner's words> - <state>

WIP
- G1: <the goal, in the owner's words, the same text as in GOALS>
   - Update: <what is being worked on right now, in plain words, with an ETA>

DONE
- G2: <what finished since the last update, with the proof: a number, a link, or the picture or video attached>

ISSUES
- G1: <what is wrong or at risk, and what you will do about it>

NEED ME
- G3: <a decision or action only the owner can take, written so it can be answered yes/no or with a choice>
```

Rules:
- **Update** is 3-4 brief sentences, no more. It starts from the owner's mission, says where things stand, and ends with what comes next and when.
- **GOALS lists every goal the owner asked for this session, every time,** in the owner's own words, each with one state. Finished goals stay on the list marked DONE, so the owner can see the whole picture. A goal is a thing the owner asked for, never a step you chose.
- **WIP shows each goal's words, not just its ID.** Each WIP item is the goal ID plus the goal's text, exactly as in GOALS, with the work under it as an indented "Update:" line. The owner sees the goal and what's happening on it at a glance, without looking back up at GOALS. If a goal has more than one thing running, give it more than one Update line.
- **Every line in WIP, DONE, ISSUES and NEED ME starts with its goal ID** ("G2: ..."). The owner reads "G2" and knows what the line is for. A line that serves no goal is a tangent: propose it under NEED ME as a new goal, don't do it.
- **One item, one section.** Something finished goes only in DONE. Something still running goes only in WIP. Never put a finished item in WIP or a running one in DONE.
- **DONE lists only what finished since the last update.** Don't repeat older finished work. The goal's state in GOALS shows it's done.
- **Write "Nothing." under any empty section.** Keep all six sections, in this order, every time.
- **Each line says what the thing IS, in words.** Explain any term the owner might not know the first time it appears.
- **Short lines.** One sentence each. No step lists, tables or inner workings unless asked.
- **Show, don't tell.** Attach the visual a DONE line talks about.
- **Real numbers and clock times.** Mark estimates with "~".
- **Plain words.** Write the way a person would say it out loud.
- **No "no change" updates.**

## STATUS.md (the memory)

Keep `STATUS.md` in the project folder. Read it before every update, and update it after. The GOALS section of every update comes from this file.

```
MISSION: <owner's original ask, verbatim, with date>
G1 | <goal> | approved <date> "<owner's words>" | doing | ETA
G2 | ... | done
G3 | ... | dropped <date>: <why>
```

- **IDs never change.** A goal never gets renumbered; mark it done or dropped instead.
- **Only the owner approves a goal,** in their own words. Everything else is proposed.
- **Every task maps to a goal.** If it doesn't, it's a tangent: propose it, don't do it.
- **Evals, scoring and research are tools, not goals.** Keep them short, and say which goal they serve.

## Approved goals: keep going without asking

The owner said: "If I okayed it previously and it's aligned with the goal, don't sit there and wait for me. Get it done. Do whatever you need to get the goal done unless I tell you to stop or shut you down."

- An approved goal is standing permission. Never end a turn idle with an approved goal unfinished and nothing running toward it.
- Keep that permission through compaction, resumed sessions, background-job notices and subagent reports.
- **Ask only for:**
  - a new goal or a change in what a goal means;
  - spend over budget, anything public, or deletes that can't be undone;
  - logins.
- **"Stop" pauses everything** until the owner says go. After their go, approved goals resume without another OK.
- A background-job notice or subagent report is information, not approval. It can't approve new work, and it doesn't need to for goals the owner already approved.
- Subagent briefs name the goal ID they serve. Ask subagents for short reports.

## Example

```
Update: The goal is a small web game that saves scores online. The game and the save button work end to end. The score board page is being built now, ~6 PM.

GOALS
G1 Save each player's best score - DONE
G2 Show a score board page - DOING
G3 Let players pick a name - BLOCKED on your choice below

WIP
- G2: Show a score board page
   - Update: The page lists the top 20 scores from the database, ~6 PM

DONE
- G1: Scores save and come back after a reload (screenshot attached)

ISSUES
- G2: The page is slow with 10,000 scores, so I'm adding paging.

NEED ME
- G3: Should names be unique across all players? (yes/no)
```
