# pi-lanes

Background work never blocks the session you type in.

pi runs one turn at a time. Everything an extension triggers (a Teams message
in listen mode, a mail hook, a scheduled prompt) is queued into the session
you are working in, and waits for whatever runs there. A twenty-minute task
for one colleague means twenty minutes of silence for everyone else.

pi-lanes takes those prompts off your session and runs each in a **lane**: a
`pi --mode rpc` process with a session of its own.

```
you ──typing──▶ front session (pi in the terminal)
                   │
extension prompt ──┼──▶ lane "teams:Anna"  pi --mode rpc, own session ──▶ subagents …
                   ├──▶ lane "teams:Bob"   pi --mode rpc, own session
                   └──▶ one-off lane        pi --mode rpc, ends when done
```

## Installation

```bash
pi install npm:@patimweb/pi-lanes
```

No configuration needed. Settings go in `~/.pi/agent/pi-lanes.json`.

## What goes where

| Prompt | Goes to |
|--------|---------|
| Typed by you | the front session |
| Sent by an extension right after you pressed a key (a slash command asking the agent for something) | the front session |
| Sent by an extension with a hint naming a lane | that lane: same lane, same session |
| Sent by an extension without a hint | a one-off lane with a fresh session |

Within a lane, order is kept: a prompt for a lane that is busy is steered into
the running turn and read after the current step. Different lanes run in
parallel, up to `maxConcurrent`; more wait in line.

## Lanes do not chain

Only the interactive terminal session routes. Every lane is started with
`PI_LANE` in its environment, and every process a lane starts (a subagent, a
tool, another pi) inherits it. A prompt an extension sends inside a lane stays
in that lane. So the depth is fixed: front session, lane, and what the lane
itself starts.

## For extension authors: hints

Emit a hint on pi's event bus right before sending the prompt:

```ts
const prompt = buildPrompt(message);
pi.events.emit("pi-lanes:route", {
  text: prompt,                       // exactly what goes to sendUserMessage
  lane: `mychat:${conversationId}`,   // same key, same lane and session
  label: "Anna Schmidt",
  env: { MY_EXTENSION_CONVERSATION: conversationId },
  command: normalisedMessageText,     // for stop and reset words
  request: shortFormForTheJournal,
  from: "Anna Schmidt",
  trusted: false,                     // may this lane read lanes_journal?
});
pi.sendUserMessage(prompt, { deliverAs: "followUp" });
```

Nothing listens when pi-lanes is not installed, and the prompt takes the usual
way into the session: the hint needs no dependency on this package.

| Field | Meaning |
|-------|---------|
| `text` | the prompt, exactly (required) |
| `lane` | lane key; absent means a one-off lane |
| `label` | name in `/lanes` and the journal |
| `env` | extra environment for the lane process, e.g. which conversation it may answer |
| `command` | the triggering text, compared to `stopWords` and `resetWords` |
| `request`, `from` | for the journal |
| `trusted` | the lane may read what other lanes were asked (`lanes_journal`) |
| `session` | `true` keeps this prompt in the front session after all |

`env` is how an extension tells the process in the lane what it is for. pi-teams
sets `PI_TEAMS_WORKER_CHAT`, and in a process with that variable it refuses to
write to any other chat and never starts its own watcher.

## Control words

When a hint carries a `command` that is exactly one of these words:

| Word (default) | Effect |
|----------------|--------|
| `stop`, `stopp`, `abbrechen`, `abbruch`, `cancel` | the lane's running turn is aborted; the prompt still reaches the model, so it confirms |
| `neues thema`, `new topic`, `reset` | the lane process ends and starts over with a fresh session |

## Settings

`~/.pi/agent/pi-lanes.json`, every key optional:

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | route at all |
| `maxConcurrent` | `3` | lanes working at the same time (1-16) |
| `maxLanes` | `6` | lane processes alive, busy or idle; the longest-idle makes room |
| `idleMinutes` | `30` | an idle lane exits; its session stays on disk |
| `freshAfterHours` | `72` | a lane quiet for longer starts a fresh session (`0` = always continue) |
| `command` | `"pi"` | the pi executable |
| `args` | `[]` | extra arguments for every lane, e.g. `["--model", "provider/id"]` |
| `env` | `{}` | extra environment for every lane |
| `stopWords`, `resetWords` | see above | control words |
| `unhinted` | `"lane"` | `"session"` keeps prompts without a hint in the front session |
| `userGraceSeconds` | `10` | a prompt without a hint this soon after a key press stays in the front session |

## Commands and tools

| | |
|---|---|
| `/lanes` | which lanes work, idle or wait |
| `/lanes stop <name>` | abort a lane's running turn |
| `lanes_journal` | what the lanes were asked and answered; in a lane only when it was started as `trusted` |

Files, all below `~/.pi/agent/pi-lanes/`:

| Path | Content |
|------|---------|
| `sessions/<hash>/` | sessions of a lane |
| `sessions/once/` | sessions of one-off lanes |
| `journal.jsonl` | start, steer, queue, stop, reset, result, duration, errors |

## Things to know

- **Nobody sits in front of a lane.** Dialogs (`confirm`, `select`, …) are
  cancelled. An extension that asks before acting has to be configured to act
  on its own, or it will refuse in a lane.
- **Lanes are RPC processes, so `ctx.hasUI` is true in them.** An extension
  that starts background loops on `hasUI` (a scheduler, a poller) would start
  them in every lane. Check `ctx.mode === "tui"` instead, or pass an
  environment variable through `env` that switches the loop off.
- **Context is per lane.** Nothing from one lane reaches another by itself.
  Shared memory extensions still work across lanes, since they read the same
  files.

## License

MIT
