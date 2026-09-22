/**
 * The lane pool: one `pi --mode rpc` process per lane.
 *
 * The rules, in the order they are applied:
 *
 * - A lane that is busy gets the new prompt **steered** into its running turn:
 *   read after the current step, not after the whole task. A lane that has
 *   been handed a prompt but not started it yet holds the steer back until it
 *   has (pi would drop it otherwise).
 * - A lane that is not busy starts working, if fewer than `maxConcurrent` lanes
 *   are busy. Otherwise it waits in line; a newer prompt for a lane already in
 *   line replaces the older one.
 * - A stop word aborts the running turn, a reset word ends the process and the
 *   lane starts over with a fresh session. Both prompts still reach the model,
 *   so whoever asked gets a confirmation.
 * - An idle lane exits after `idleMinutes`. Its session stays on disk, and the
 *   next prompt continues it, unless the lane has been quiet for longer than
 *   `freshAfterHours`. A one-off lane (no lane key) exits as soon as it is done.
 *
 * Process handling is injectable (`spawn`), so the rules are tested without pi.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedLanesConfig } from "./config.ts";
import { appendJournal, excerpt, lanesHome, type JournalEntry, type JournalEvent } from "./journal.ts";
import { laneEnv, type LaneIdentity } from "./lane.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaneJob {
	/** Lane key. Same key, same process and session. */
	lane: string;
	label: string;
	prompt: string;
	images?: unknown[];
	/** Extra environment, from the hint */
	env?: Record<string, string>;
	trusted?: boolean;
	/** No lane key was given: fresh session, process ends when done */
	oneShot?: boolean;
	control?: "stop" | "reset";
	from?: string;
	request?: string;
}

export type DeliverOutcome = "started" | "steered" | "queued" | "stopped" | "reset";

/** The part of a child process the pool uses. */
export interface LaneProcess {
	pid?: number;
	stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (err: Error) => void): unknown } | null;
	stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: "error", listener: (err: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnLane = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => LaneProcess;

export interface PoolOptions {
	config: ResolvedLanesConfig;
	agentDir: string;
	/** Working directory of the lanes */
	cwd: string;
	spawn?: SpawnLane;
	now?: () => number;
	/** Environment the lanes inherit (default: process.env) */
	env?: NodeJS.ProcessEnv;
	journal?: (entry: JournalEntry) => void;
	/** Something the person at the front session should hear about */
	onError?: (message: string) => void;
	/** Called whenever a lane starts, settles, queues or exits */
	onChange?: () => void;
	/** Interval of the idle sweep in ms (default: 60 000, 0 = no timer) */
	sweepIntervalMs?: number;
}

export interface PoolStatus {
	busy: number;
	alive: number;
	queued: number;
	maxConcurrent: number;
	lanes: Array<{ lane: string; label: string; busy: boolean; sinceMs: number }>;
	waiting: Array<{ lane: string; label: string }>;
}

interface Lane {
	identity: LaneIdentity;
	oneShot: boolean;
	proc: LaneProcess;
	busy: boolean;
	/**
	 * The agent has actually started the current run (agent_start seen).
	 *
	 * Until then pi drops a second prompt: measured against pi 0.85, a steer
	 * sent while the first prompt is still in preflight is acknowledged and
	 * then lost. So everything for a lane that is busy but not yet streaming
	 * waits in `pending` and is sent on agent_start.
	 */
	streaming: boolean;
	pending: Array<() => void>;
	job?: LaneJob;
	startedAt: number;
	lastActivity: number;
	buffer: string;
	lastText?: string;
	stderrTail: string;
	retiring: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Session directory of a lane. Hashed: keys contain ':' and '@'. One-off lanes share one. */
export function laneSessionDir(agentDir: string, lane: string, oneShot = false): string {
	if (oneShot) return join(lanesHome(agentDir), "sessions", "once");
	const key = createHash("sha256").update(lane).digest("hex").slice(0, 16);
	return join(lanesHome(agentDir), "sessions", key);
}

/** Whether the lane's last session is recent enough to continue. */
export function shouldContinue(dir: string, freshAfterHours: number, now: number): boolean {
	let newest = 0;
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			const mtime = statSync(join(dir, name)).mtimeMs;
			if (mtime > newest) newest = mtime;
		}
	} catch {
		return false;
	}
	if (newest === 0) return false;
	if (freshAfterHours === 0) return true;
	return now - newest <= freshAfterHours * 3_600_000;
}

function assistantText(message: any): string | undefined {
	if (!message || message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export class LanePool {
	private config: ResolvedLanesConfig;
	private readonly options: PoolOptions;
	private readonly lanes = new Map<string, Lane>();
	private queue: LaneJob[] = [];
	private readonly spawnLane: SpawnLane;
	private readonly now: () => number;
	private readonly journal: (entry: JournalEntry) => void;
	private sweepTimer?: ReturnType<typeof setInterval>;
	private stopped = false;

	constructor(options: PoolOptions) {
		this.options = options;
		this.config = options.config;
		this.spawnLane =
			options.spawn ??
			((command, args, opts) =>
				nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] }) as LaneProcess);
		this.now = options.now ?? Date.now;
		this.journal = options.journal ?? ((entry) => appendJournal(options.agentDir, entry));
		const every = options.sweepIntervalMs ?? 60_000;
		if (every > 0) {
			this.sweepTimer = setInterval(() => this.sweep(), every);
			this.sweepTimer.unref?.();
		}
	}

	configure(config: ResolvedLanesConfig): void {
		this.config = config;
		this.drain();
	}

	deliver(job: LaneJob): DeliverOutcome {
		if (this.stopped) return "queued";
		const lane = this.lanes.get(job.lane);

		if (job.control === "reset") {
			this.dropQueued(job.lane);
			if (lane) this.retire(lane);
			this.record(job, "reset");
			this.start(job, true);
			return "reset";
		}

		if (job.control === "stop") {
			this.dropQueued(job.lane);
			if (lane?.busy) {
				const target = lane;
				this.whenStreaming(target, () => {
					target.pending = [];
					this.send(target, { type: "clear_queue" });
					this.send(target, { type: "abort" });
					// Queued behind the abort: the model confirms once the lane is idle.
					this.send(target, { type: "follow_up", message: job.prompt, ...(job.images?.length ? { images: job.images } : {}) });
				});
				this.record(job, "stop");
				lane.job = job;
				return "stopped";
			}
			this.record(job, "stop", { detail: "nothing was running" });
		}

		if (lane?.busy) {
			this.steer(lane, job);
			lane.lastActivity = this.now();
			this.record(job, "steer");
			return "steered";
		}

		if (this.busyCount() >= this.config.maxConcurrent) {
			this.dropQueued(job.lane);
			this.queue.push(job);
			this.record(job, "queued", { detail: `${this.busyCount()} lane(s) busy` });
			this.changed();
			return "queued";
		}

		this.start(job, false);
		return "started";
	}

	status(): PoolStatus {
		const now = this.now();
		return {
			busy: this.busyCount(),
			alive: this.lanes.size,
			queued: this.queue.length,
			maxConcurrent: this.config.maxConcurrent,
			lanes: [...this.lanes.values()].map((l) => ({
				lane: l.identity.lane,
				label: l.identity.label,
				busy: l.busy,
				sinceMs: now - (l.busy ? l.startedAt : l.lastActivity),
			})),
			waiting: this.queue.map((job) => ({ lane: job.lane, label: job.label })),
		};
	}

	/** Abort the running work of a lane, as a stop word would, without a new prompt. */
	abort(laneKey: string): boolean {
		const lane = this.lanes.get(laneKey);
		if (!lane?.busy) return false;
		this.whenStreaming(lane, () => {
			lane.pending = [];
			this.send(lane, { type: "clear_queue" });
			this.send(lane, { type: "abort" });
		});
		return true;
	}

	/** End idle lanes quiet for longer than `idleMinutes`. */
	sweep(): void {
		const now = this.now();
		const limit = this.config.idleMinutes * 60_000;
		for (const lane of [...this.lanes.values()]) {
			if (!lane.busy && now - lane.lastActivity > limit) {
				this.journal({
					at: new Date(now).toISOString(),
					lane: lane.identity.lane,
					label: lane.identity.label,
					event: "idle-exit",
				});
				this.retire(lane);
			}
		}
		this.changed();
	}

	/** End every lane. Their sessions stay on disk. */
	stopAll(): void {
		this.stopped = true;
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.queue = [];
		for (const lane of [...this.lanes.values()]) this.retire(lane);
	}

	// -----------------------------------------------------------------------

	private changed(): void {
		try {
			this.options.onChange?.();
		} catch {
			/* a status line must not break the pool */
		}
	}

	private busyCount(): number {
		let busy = 0;
		for (const lane of this.lanes.values()) if (lane.busy) busy += 1;
		return busy;
	}

	private dropQueued(key: string): void {
		this.queue = this.queue.filter((job) => job.lane !== key);
	}

	private record(job: LaneJob, event: JournalEvent, extra: Partial<JournalEntry> = {}): void {
		this.journal({
			at: new Date(this.now()).toISOString(),
			lane: job.lane,
			label: job.label,
			event,
			from: job.from,
			request: job.request,
			...extra,
		});
	}

	private send(lane: Lane, command: Record<string, unknown>): void {
		try {
			lane.proc.stdin?.write(`${JSON.stringify(command)}\n`);
		} catch {
			/* a dead pipe shows up as an exit event */
		}
	}

	private prompt(lane: Lane, job: LaneJob): void {
		const command: Record<string, unknown> = { type: "prompt", message: job.prompt };
		if (job.images && job.images.length > 0) command.images = job.images;
		this.send(lane, command);
	}

	/** Run now if the lane's agent is running, else as soon as it starts. */
	private whenStreaming(lane: Lane, action: () => void): void {
		if (lane.streaming) action();
		else lane.pending.push(action);
	}

	/** Hand a prompt to a running turn: read after the current step. */
	private steer(lane: Lane, job: LaneJob): void {
		this.whenStreaming(lane, () => {
			const command: Record<string, unknown> = { type: "steer", message: job.prompt };
			if (job.images && job.images.length > 0) command.images = job.images;
			this.send(lane, command);
		});
	}

	private start(job: LaneJob, fresh: boolean): void {
		let lane = this.lanes.get(job.lane);
		if (!lane) lane = this.launch(job, fresh || !!job.oneShot);
		if (!lane) return;

		const now = this.now();
		lane.busy = true;
		lane.streaming = false;
		lane.pending = [];
		lane.job = job;
		lane.startedAt = now;
		lane.lastActivity = now;
		lane.lastText = undefined;
		this.prompt(lane, job);
		this.record(job, "start", fresh ? { detail: "fresh session" } : {});
		this.changed();
	}

	private launch(job: LaneJob, fresh: boolean): Lane | undefined {
		this.makeRoom();

		const identity: LaneIdentity = { lane: job.lane, label: job.label, trusted: !!job.trusted };
		const oneShot = !!job.oneShot;
		const dir = laneSessionDir(this.options.agentDir, job.lane, oneShot);
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch {
			/* spawn reports the real problem */
		}

		const resume = !fresh && !oneShot && shouldContinue(dir, this.config.freshAfterHours, this.now());
		const args = [
			...this.config.args,
			"--mode",
			"rpc",
			"--session-dir",
			dir,
			...(resume ? ["--continue"] : ["--name", `lane: ${job.label}`]),
		];

		let proc: LaneProcess;
		try {
			proc = this.spawnLane(this.config.command, args, {
				cwd: this.options.cwd,
				env: { ...(this.options.env ?? process.env), ...this.config.env, ...(job.env ?? {}), ...laneEnv(identity) },
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.record(job, "error", { detail: `could not start ${this.config.command}: ${message}` });
			this.options.onError?.(`pi-lanes: could not start a lane for "${job.label}": ${message}`);
			return undefined;
		}

		const now = this.now();
		const lane: Lane = {
			identity,
			oneShot,
			proc,
			busy: false,
			streaming: false,
			pending: [],
			startedAt: now,
			lastActivity: now,
			buffer: "",
			stderrTail: "",
			retiring: false,
		};
		this.lanes.set(job.lane, lane);

		proc.stdin?.on("error", () => undefined);
		proc.stdout?.on("data", (chunk) => this.onData(lane, chunk));
		proc.stderr?.on("data", (chunk) => {
			lane.stderrTail = (lane.stderrTail + chunk.toString()).slice(-2000);
		});
		proc.on("error", (err) => this.onExit(lane, `error: ${err.message}`));
		proc.on("exit", (code, signal) => this.onExit(lane, signal ? `signal ${signal}` : `exit code ${code}`));
		return lane;
	}

	/** Keep live lanes under `maxLanes` by ending the longest-idle one. */
	private makeRoom(): void {
		while (this.lanes.size >= this.config.maxLanes) {
			const idle = [...this.lanes.values()].filter((l) => !l.busy).sort((a, b) => a.lastActivity - b.lastActivity);
			if (idle.length === 0) return;
			this.retire(idle[0]!);
		}
	}

	/** End a lane on purpose. Closing stdin lets pi shut down cleanly. */
	private retire(lane: Lane): void {
		lane.retiring = true;
		if (this.lanes.get(lane.identity.lane) === lane) this.lanes.delete(lane.identity.lane);
		try {
			lane.proc.stdin?.end();
		} catch {
			/* ignore */
		}
		const timer = setTimeout(() => {
			try {
				lane.proc.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}, 10_000);
		timer.unref?.();
	}

	private onData(lane: Lane, chunk: Buffer | string): void {
		lane.buffer += chunk.toString();
		let index = lane.buffer.indexOf("\n");
		while (index >= 0) {
			const line = lane.buffer.slice(0, index).replace(/\r$/, "");
			lane.buffer = lane.buffer.slice(index + 1);
			if (line.trim()) this.onLine(lane, line);
			index = lane.buffer.indexOf("\n");
		}
	}

	private onLine(lane: Lane, line: string): void {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!event || typeof event !== "object") return;

		switch (event.type) {
			case "agent_start": {
				lane.streaming = true;
				if (!lane.busy) {
					lane.busy = true;
					lane.startedAt = this.now();
					this.changed();
				}
				const pending = lane.pending;
				lane.pending = [];
				for (const action of pending) action();
				return;
			}
			case "message_end": {
				const text = assistantText(event.message);
				if (text) lane.lastText = text;
				return;
			}
			case "agent_settled":
				// Only a run that actually started can settle. Anything else is
				// noise from a prompt pi did not take up.
				if (!lane.streaming) return;
				lane.streaming = false;
				this.finish(lane);
				return;
			case "extension_ui_request":
				// Nobody sits in front of a lane. A dialog would wait forever.
				if (DIALOG_METHODS.has(event.method)) {
					this.send(lane, { type: "extension_ui_response", id: event.id, cancelled: true });
				}
				return;
			case "response":
				if (event.success === false) {
					const detail = `${event.command ?? "command"} failed: ${event.error ?? "unknown error"}`;
					if (lane.job) this.record(lane.job, "error", { detail });
					this.options.onError?.(`pi-lanes (${lane.identity.label}): ${detail}`);
					if (event.command === "prompt" && lane.busy) this.finish(lane, true);
				}
				return;
			default:
				return;
		}
	}

	private finish(lane: Lane, failed = false): void {
		if (!lane.busy) return;
		const now = this.now();
		lane.busy = false;
		lane.streaming = false;
		lane.pending = [];
		lane.lastActivity = now;
		if (lane.job && !failed) {
			this.record(lane.job, "done", { durationMs: now - lane.startedAt, result: excerpt(lane.lastText) });
		}
		if (lane.oneShot) this.retire(lane);
		this.drain();
		this.changed();
	}

	private onExit(lane: Lane, how: string): void {
		if (this.lanes.get(lane.identity.lane) === lane) this.lanes.delete(lane.identity.lane);
		if (!lane.retiring && lane.busy && lane.job) {
			const detail = `lane ended (${how})${lane.stderrTail ? `: ${excerpt(lane.stderrTail, 200)}` : ""}`;
			this.record(lane.job, "error", { detail });
			this.options.onError?.(`pi-lanes (${lane.identity.label}): ${detail}`);
		}
		lane.busy = false;
		lane.retiring = true;
		if (!this.stopped) this.drain();
		this.changed();
	}

	/** Start waiting lanes while there is room. */
	private drain(): void {
		while (this.queue.length > 0 && this.busyCount() < this.config.maxConcurrent) {
			const job = this.queue.shift()!;
			const lane = this.lanes.get(job.lane);
			if (lane?.busy) {
				this.steer(lane, job);
				this.record(job, "steer");
				continue;
			}
			this.start(job, false);
		}
	}
}
