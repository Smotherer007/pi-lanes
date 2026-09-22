/**
 * pi-lanes: background work never blocks the session you type in.
 *
 * In the front session (interactive pi, not itself a lane) every prompt an
 * extension sends is taken off the session and handed to a lane: a
 * `pi --mode rpc` process with a session of its own. Lanes run in parallel;
 * prompts for the same lane continue its session. What a person types, and
 * what a slash command they just ran sends, stays in the front session.
 *
 * Inside a lane this extension does nothing but offer `lanes_journal`: a lane
 * never routes again, so there is no recursion.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getConfigPath, loadConfig, type ResolvedLanesConfig } from "./config.ts";
import { laneIdentity } from "./lane.ts";
import { LanePool } from "./pool.ts";
import { controlOf, decideRoute, HINT_CHANNEL, HintStore, isFrontSession, labelFor } from "./router.ts";
import { excerpt } from "./journal.ts";
import { lanesJournalTool } from "./tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function (pi: ExtensionAPI) {
	const self = laneIdentity();
	const hints = new HintStore();

	let config: ResolvedLanesConfig = loadConfig().config;
	let pool: LanePool | undefined;
	let front = false;
	let lastKeyAt: number | undefined;
	let uiCtx: any;
	let unsubscribeKeys: (() => void) | undefined;
	let onceCounter = 0;

	// Hints arrive on the shared bus right before their prompt. Listening costs
	// nothing in a lane; the store is simply never read there.
	pi.events.on(HINT_CHANNEL, (data: unknown) => {
		if (front) hints.add(data);
	});

	const paint = () => {
		if (!uiCtx || !pool) return;
		const s = pool.status();
		const text = s.alive + s.queued === 0 ? undefined : `lanes ${s.busy}/${s.maxConcurrent}${s.queued ? ` +${s.queued}` : ""}`;
		try {
			uiCtx.ui.setStatus("lanes", text);
		} catch {
			/* ignore */
		}
	};

	const poolFor = (ctx: any): LanePool => {
		if (pool) return pool;
		pool = new LanePool({
			config,
			agentDir: getAgentDir(),
			cwd: ctx?.cwd ?? process.cwd(),
			onError: (message) => uiCtx?.ui?.notify?.(message, "warning"),
			onChange: paint,
		});
		return pool;
	};

	pi.on("session_start", async (_event, ctx: any) => {
		const loaded = loadConfig();
		config = loaded.config;
		pool?.configure(config);
		if (loaded.error) ctx.ui.notify(`pi-lanes: config ignored, ${loaded.error}`, "warning");

		// Only an interactive pi routes. A lane, a subagent (json), a print run or
		// an embedding over RPC is somebody else's process.
		front = isFrontSession({ mode: ctx.mode, hasUI: !!ctx.hasUI, enabled: config.enabled, env: process.env });
		uiCtx = front ? ctx : undefined;

		unsubscribeKeys?.();
		unsubscribeKeys = undefined;
		if (front && typeof ctx.ui?.onTerminalInput === "function") {
			unsubscribeKeys = ctx.ui.onTerminalInput(() => {
				lastKeyAt = Date.now();
				return undefined;
			});
		}
	});

	pi.on("session_shutdown", () => {
		unsubscribeKeys?.();
		unsubscribeKeys = undefined;
		pool?.stopAll();
		pool = undefined;
	});

	pi.on("input", async (event: any, ctx: any) => {
		if (!front || event.source !== "extension") return;

		const now = Date.now();
		const hint = hints.take(event.text, now);
		if (decideRoute({ hint, lastKeyAt, now, config }) === "session") return;

		const oneShot = !hint?.lane;
		const lane = hint?.lane ?? `once:${now.toString(36)}-${(onceCounter += 1)}`;
		poolFor(ctx).deliver({
			lane,
			label: hint?.label ?? labelFor(event.text),
			prompt: event.text,
			images: event.images,
			env: hint?.env,
			trusted: hint?.trusted,
			oneShot,
			control: controlOf(hint?.command, config),
			from: hint?.from,
			request: hint?.request ?? excerpt(event.text, 160),
		});
		return { action: "handled" };
	});

	pi.registerTool({
		...lanesJournalTool,
		execute: (toolCallId: string, params: any) => lanesJournalTool.execute(toolCallId, params),
	} as any);

	pi.registerCommand("lanes", {
		description: "Show the lanes: which work, which idle, which wait. `/lanes stop <name>` aborts one.",
		handler: async (args, ctx) => {
			if (self) {
				ctx.ui.notify(`This pi is the lane "${self.label}".`, "info");
				return;
			}
			if (!front) {
				ctx.ui.notify(`pi-lanes is off in this session (${getConfigPath()}).`, "info");
				return;
			}
			const [action, ...rest] = args.trim().split(/\s+/);
			if (action === "stop") {
				const needle = rest.join(" ").toLowerCase();
				const match = pool?.status().lanes.find((l) => l.busy && (l.label.toLowerCase().includes(needle) || l.lane === needle));
				ctx.ui.notify(
					match && pool?.abort(match.lane) ? `Aborted lane "${match.label}".` : `No busy lane matches "${needle}".`,
					"info",
				);
				return;
			}
			const s = pool?.status();
			if (!s || s.alive + s.queued === 0) {
				ctx.ui.notify(`No lanes running (max ${config.maxConcurrent} in parallel).`, "info");
				return;
			}
			const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`;
			ctx.ui.notify(
				[
					`Lanes: ${s.busy}/${s.maxConcurrent} busy, ${s.alive} alive, ${s.queued} waiting`,
					...s.lanes.map((l) => `- ${l.label}: ${l.busy ? `working for ${minutes(l.sinceMs)}` : `idle for ${minutes(l.sinceMs)}`}`),
					...s.waiting.map((l) => `- ${l.label}: waiting for a slot`),
				].join("\n"),
				"info",
			);
		},
	});
}
