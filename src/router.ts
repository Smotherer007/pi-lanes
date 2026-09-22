/**
 * Which prompt goes where.
 *
 * pi-lanes sits on pi's `input` event and sees every prompt before the agent
 * does. What a person types stays in the front session. What an extension
 * sends (`pi.sendUserMessage`) is background work by default and goes to a
 * lane, so it never blocks the session a person works in.
 *
 * An extension that knows more about its prompt says so with a **hint** on the
 * shared event bus, emitted right before it sends the prompt:
 *
 *     pi.events.emit("pi-lanes:route", {
 *       text: prompt,              // exactly what goes to sendUserMessage
 *       lane: `teams:${chatId}`,   // same key, same lane and session
 *       label: "Anna Schmidt",
 *       env: { MY_EXTENSION_CHAT: chatId },
 *       command: "stopp",          // normalised trigger text, for control words
 *       trusted: false,
 *     });
 *
 * Emitting costs nothing when pi-lanes is not installed: nobody listens, and
 * the prompt takes the usual way into the session. So an extension needs no
 * dependency on this package to work well with it.
 */

import { normalizeCommand, type ResolvedLanesConfig } from "./config.ts";

/** The event-bus channel extensions emit hints on. */
export const HINT_CHANNEL = "pi-lanes:route";

export interface LaneHint {
	/** The prompt text, exactly as passed to sendUserMessage */
	text: string;
	/** Lane key. Same key, same lane and session. Absent: a one-off lane. */
	lane?: string;
	/** Human-readable lane name */
	label?: string;
	/** Extra environment for the lane process, e.g. which chat it answers */
	env?: Record<string, string>;
	/** The text that triggered the prompt, for stop and reset words */
	command?: string;
	/** Short form of the request, for the journal */
	request?: string;
	/** Who triggered it, for the journal */
	from?: string;
	/** The lane may read what other lanes were asked (lanes_journal) */
	trusted?: boolean;
	/** Keep this prompt in the front session after all */
	session?: boolean;
}

/** How long an unclaimed hint is kept. A hint belongs to a prompt sent right after it. */
export const HINT_TTL_MS = 60_000;

/** Hints by prompt text, waiting for their prompt to arrive. */
export class HintStore {
	private readonly hints = new Map<string, { hint: LaneHint; at: number }>();

	add(value: unknown, now = Date.now()): void {
		const hint = sanitizeHint(value);
		if (!hint) return;
		this.prune(now);
		this.hints.set(hint.text, { hint, at: now });
	}

	take(text: string, now = Date.now()): LaneHint | undefined {
		this.prune(now);
		const entry = this.hints.get(text);
		if (!entry) return undefined;
		this.hints.delete(text);
		return entry.hint;
	}

	get size(): number {
		return this.hints.size;
	}

	private prune(now: number): void {
		for (const [text, entry] of this.hints) if (now - entry.at > HINT_TTL_MS) this.hints.delete(text);
	}
}

/** Keep only well-formed fields. Hints come from other extensions. */
export function sanitizeHint(value: unknown): LaneHint | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.text !== "string" || !v.text) return undefined;
	const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
	const env: Record<string, string> = {};
	if (v.env && typeof v.env === "object") {
		for (const [key, val] of Object.entries(v.env as Record<string, unknown>)) {
			if (typeof val === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = val;
		}
	}
	return {
		text: v.text,
		lane: str(v.lane),
		label: str(v.label),
		env,
		command: str(v.command),
		request: str(v.request),
		from: str(v.from),
		trusted: v.trusted === true,
		session: v.session === true,
	};
}

export type Route = "session" | "lane";

/**
 * Whether this pi process routes at all: the one guarantee against chains.
 *
 * Only the interactive terminal session routes. Every lane is started with
 * PI_LANE, and every process a lane starts (subagent, tool, another pi)
 * inherits it, so nothing below the front session can open a lane again. A
 * prompt an extension sends inside a lane stays in that lane. The depth is
 * therefore fixed: front session, lane, and whatever the lane itself starts
 * (subagents, which neo-guard in turn keeps from starting more).
 */
export function isFrontSession(input: { mode: string | undefined; hasUI: boolean; enabled: boolean; env: NodeJS.ProcessEnv }): boolean {
	if (!input.enabled) return false;
	if (input.env.PI_LANE) return false;
	const mode = input.mode ?? (input.hasUI ? "tui" : "print");
	return mode === "tui";
}

/**
 * The routing rule, in one place.
 *
 * - A hint decides: its lane, or the session when it asks for that.
 * - Without a hint, a prompt right after a key press belongs to the person at
 *   the keyboard (a slash command asking the agent to do something) and stays.
 * - Everything else is background work and goes to a lane, unless the config
 *   says unhinted prompts stay in the session.
 */
export function decideRoute(input: {
	hint?: LaneHint;
	lastKeyAt?: number;
	now: number;
	config: Pick<ResolvedLanesConfig, "unhinted" | "userGraceSeconds">;
}): Route {
	const { hint, lastKeyAt, now, config } = input;
	if (hint) return hint.session ? "session" : "lane";
	if (config.unhinted === "session") return "session";
	if (lastKeyAt !== undefined && now - lastKeyAt <= config.userGraceSeconds * 1000) return "session";
	return "lane";
}

/** Whether a trigger is a control word, and which. */
export function controlOf(
	command: string | undefined,
	config: Pick<ResolvedLanesConfig, "stopWords" | "resetWords">,
): "stop" | "reset" | undefined {
	if (!command) return undefined;
	const text = normalizeCommand(command);
	if (!text) return undefined;
	if (config.resetWords.includes(text)) return "reset";
	if (config.stopWords.includes(text)) return "stop";
	return undefined;
}

/** A readable name for a prompt nobody named. */
export function labelFor(text: string, max = 40): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || "prompt";
}
