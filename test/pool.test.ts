/**
 * The lane pool: parallel across lanes, in order within a lane, a steer for a
 * busy lane, a line for a full house. Tested against fake processes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanePool, laneSessionDir, shouldContinue, type LaneJob, type LaneProcess } from "../src/pool.ts";
import { resolveConfig, type LanesConfig } from "../src/config.ts";
import type { JournalEntry } from "../src/journal.ts";

class FakeLane extends EventEmitter {
	commands: any[] = [];
	ended = false;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	stdin = {
		write: (chunk: string) => {
			for (const line of chunk.split("\n").filter(Boolean)) this.commands.push(JSON.parse(line));
			return true;
		},
		end: () => {
			this.ended = true;
		},
		on: () => undefined,
	};
	constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
		super();
		this.command = command;
		this.args = args;
		this.env = env;
	}
	kill() {}
	event(e: Record<string, unknown>) {
		this.stdout.emit("data", `${JSON.stringify(e)}\n`);
	}
	prompts() {
		return this.commands.filter((c) => c.type === "prompt");
	}
}

function setup(config: LanesConfig = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-lanes-"));
	const procs: FakeLane[] = [];
	const journal: JournalEntry[] = [];
	const errors: string[] = [];
	let now = 1_000_000;
	const pool = new LanePool({
		config: resolveConfig({ args: ["--model", "x/y"], env: { GLOBAL: "1" }, ...config }),
		agentDir,
		cwd: agentDir,
		env: {},
		now: () => now,
		journal: (e) => journal.push(e),
		onError: (m) => errors.push(m),
		sweepIntervalMs: 0,
		spawn: (command, args, options) => {
			const p = new FakeLane(command, args, options.env);
			procs.push(p);
			return p as unknown as LaneProcess;
		},
	});
	return { agentDir, pool, procs, journal, errors, advance: (ms: number) => (now += ms) };
}

const job = (lane: string, extra: Partial<LaneJob> = {}): LaneJob => ({
	lane,
	label: `Lane ${lane}`,
	prompt: `prompt for ${lane}`,
	...extra,
});

describe("starting lanes", () => {
	test("a prompt starts pi in rpc mode with the lane's environment", () => {
		const { pool, procs, agentDir } = setup();
		assert.equal(pool.deliver(job("A", { env: { CHAT: "19:a" }, trusted: true })), "started");
		const [p] = procs;
		assert.deepEqual(p!.args.slice(0, 4), ["--model", "x/y", "--mode", "rpc"]);
		assert.ok(p!.args.includes(laneSessionDir(agentDir, "A")));
		assert.equal(p!.env.PI_LANE, "A");
		assert.equal(p!.env.PI_LANE_TRUSTED, "1");
		assert.equal(p!.env.CHAT, "19:a");
		assert.equal(p!.env.GLOBAL, "1");
		assert.deepEqual(p!.prompts()[0], { type: "prompt", message: "prompt for A" });
	});

	test("an untrusted lane carries no trust flag", () => {
		const { pool, procs } = setup();
		pool.deliver(job("A"));
		assert.equal(procs[0]!.env.PI_LANE_TRUSTED, undefined);
	});

	test("different lanes run in parallel", () => {
		const { pool, procs } = setup({ maxConcurrent: 3 });
		pool.deliver(job("A"));
		pool.deliver(job("B"));
		pool.deliver(job("C"));
		assert.equal(procs.length, 3);
		assert.equal(pool.status().busy, 3);
	});

	test("images travel with the prompt", () => {
		const { pool, procs } = setup();
		pool.deliver(job("A", { images: [{ type: "image", data: "x", mimeType: "image/png" }] }));
		assert.equal(procs[0]!.prompts()[0].images.length, 1);
	});
});

describe("a busy lane", () => {
	test("gets the next prompt steered into the running turn", () => {
		const { pool, procs } = setup();
		pool.deliver(job("A"));
		procs[0]!.event({ type: "agent_start" });
		assert.equal(pool.deliver(job("A", { prompt: "second" })), "steered");
		assert.equal(procs.length, 1);
		assert.deepEqual(procs[0]!.commands[1], { type: "steer", message: "second" });
	});

	test("holds a steer back until the agent has started (pi drops it otherwise)", () => {
		const { pool, procs } = setup();
		pool.deliver(job("A"));
		pool.deliver(job("A", { prompt: "early" }));
		assert.equal(procs[0]!.commands.length, 1);
		procs[0]!.event({ type: "agent_start" });
		assert.deepEqual(procs[0]!.commands[1], { type: "steer", message: "early" });
	});

	test("ignores a settle for a run that never started", () => {
		const { pool, procs } = setup();
		pool.deliver(job("A"));
		procs[0]!.event({ type: "agent_settled" });
		assert.equal(pool.status().busy, 1);
	});

	test("continues in the same process once settled", () => {
		const { pool, procs } = setup();
		pool.deliver(job("A"));
		procs[0]!.event({ type: "agent_start" });
		procs[0]!.event({ type: "agent_settled" });
		assert.equal(pool.deliver(job("A")), "started");
		assert.equal(procs.length, 1);
	});
});

describe("a full house", () => {
	test("queues and starts the next lane when a slot frees up", () => {
		const { pool, procs, journal } = setup({ maxConcurrent: 1 });
		pool.deliver(job("A"));
		assert.equal(pool.deliver(job("B")), "queued");
		procs[0]!.event({ type: "agent_start" });
		procs[0]!.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done A" }] } });
		procs[0]!.event({ type: "agent_settled" });
		assert.equal(procs.length, 2);
		assert.equal(procs[1]!.env.PI_LANE, "B");
		assert.equal(journal.find((e) => e.event === "done")?.result, "Done A");
	});

	test("a newer prompt for a waiting lane replaces the older one", () => {
		const { pool, procs } = setup({ maxConcurrent: 1 });
		pool.deliver(job("A"));
		pool.deliver(job("B", { prompt: "old" }));
		pool.deliver(job("B", { prompt: "new" }));
		assert.equal(pool.status().queued, 1);
		procs[0]!.event({ type: "agent_start" });
		procs[0]!.event({ type: "agent_settled" });
		assert.equal(procs[1]!.prompts()[0].message, "new");
	});

	test("a lane that crashes frees its slot and is reported", () => {
		const { pool, procs, errors } = setup({ maxConcurrent: 1 });
		pool.deliver(job("A"));
		pool.deliver(job("B"));
		procs[0]!.emit("exit", 1, null);
		assert.equal(procs.length, 2);
		assert.match(errors[0] ?? "", /Lane A/);
	});
});

describe("one-off lanes", () => {
	test("start fresh and end when done", () => {
		const { pool, procs } = setup();
		pool.deliver(job("once:1", { oneShot: true }));
		assert.ok(!procs[0]!.args.includes("--continue"));
		procs[0]!.event({ type: "agent_start" });
		procs[0]!.event({ type: "agent_settled" });
		assert.equal(procs[0]!.ended, true);
		assert.equal(pool.status().alive, 0);
	});
});

describe("control words", () => {
	test("stop aborts the running turn and still lets the model confirm", () => {
		const { pool, procs } = setup();
		pool.deliver(job("A"));
		procs[0]!.event({ type: "agent_start" });
		assert.equal(pool.deliver(job("A", { control: "stop" })), "stopped");
		assert.deepEqual(procs[0]!.commands.map((c) => c.type), ["prompt", "clear_queue", "abort", "follow_up"]);
	});

	test("stop with nothing running is an ordinary prompt", () => {
		const { pool } = setup();
		assert.equal(pool.deliver(job("A", { control: "stop" })), "started");
	});

	test("reset ends the lane and starts over without --continue", () => {
		const { pool, procs, agentDir } = setup();
		pool.deliver(job("A"));
		procs[0]!.event({ type: "agent_start" });
		procs[0]!.event({ type: "agent_settled" });
		const dir = laneSessionDir(agentDir, "A");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "s.jsonl"), "{}\n");
		assert.equal(pool.deliver(job("A", { control: "reset" })), "reset");
		assert.equal(procs[0]!.ended, true);
		assert.ok(!procs[1]!.args.includes("--continue"));
	});
});

describe("idle lanes", () => {
	test("exit after idleMinutes; the next prompt continues the session", () => {
		const { pool, procs, advance, agentDir } = setup({ idleMinutes: 30 });
		pool.deliver(job("A"));
		procs[0]!.event({ type: "agent_start" });
		procs[0]!.event({ type: "agent_settled" });
		writeFileSync(join(laneSessionDir(agentDir, "A"), "s.jsonl"), "{}\n");
		advance(31 * 60_000);
		pool.sweep();
		assert.equal(procs[0]!.ended, true);
		pool.deliver(job("A"));
		assert.ok(procs[1]!.args.includes("--continue"));
	});

	test("the longest-idle lane makes room at maxLanes", () => {
		const { pool, procs } = setup({ maxConcurrent: 1, maxLanes: 1 });
		pool.deliver(job("A"));
		procs[0]!.event({ type: "agent_start" });
		procs[0]!.event({ type: "agent_settled" });
		pool.deliver(job("B"));
		assert.equal(procs[0]!.ended, true);
		assert.equal(pool.status().alive, 1);
	});
});

describe("dialogs", () => {
	test("are cancelled, because nobody sits in front of a lane", () => {
		const { pool, procs } = setup();
		pool.deliver(job("A"));
		procs[0]!.event({ type: "extension_ui_request", id: "u1", method: "confirm" });
		procs[0]!.event({ type: "extension_ui_request", id: "u2", method: "notify" });
		const answers = procs[0]!.commands.filter((c) => c.type === "extension_ui_response");
		assert.deepEqual(answers, [{ type: "extension_ui_response", id: "u1", cancelled: true }]);
	});
});

test("shouldContinue respects freshAfterHours", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-lanes-fresh-"));
	const now = Date.now();
	assert.equal(shouldContinue(dir, 72, now), false);
	const file = join(dir, "a.jsonl");
	writeFileSync(file, "{}\n");
	const old = (now - 100 * 3_600_000) / 1000;
	utimesSync(file, old, old);
	assert.equal(shouldContinue(dir, 72, now), false);
	assert.equal(shouldContinue(dir, 0, now), true);
});
