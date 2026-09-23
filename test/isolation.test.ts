/**
 * Isolation: a lane reaches its own conversation and workspace, nothing else.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCall, pathViolation, resolveIsolation, roleOf, spellings, toolMatches, type Guard } from "../src/isolation.ts";
import { sanitizeHint } from "../src/router.ts";
import { laneCwd, laneHash } from "../src/pool.ts";

const home = "/home/neo";
const lanes = "/home/neo/.pi/agent/pi-lanes";

describe("roles", () => {
	test("no PI_LANE: not a lane at all", () => {
		assert.equal(roleOf({}, 10), undefined);
	});
	test("the lane itself: no marker, or its own pid after a reload", () => {
		assert.equal(roleOf({ PI_LANE: "teams:1" }, 10), "lane");
		assert.equal(roleOf({ PI_LANE: "teams:1", PI_LANE_CHILD: "10" }, 10), "lane");
	});
	test("anything the lane starts is a child", () => {
		assert.equal(roleOf({ PI_LANE: "teams:1", PI_LANE_CHILD: "10" }, 11), "child");
	});
	test("a hint cannot set pi-lanes' own variables", () => {
		const hint = sanitizeHint({ text: "x", env: { PI_LANE_TRUSTED: "1", PI_LANE_CHILD: "1", OK: "y" } });
		assert.deepEqual(hint?.env, { OK: "y" });
	});
});

describe("tool rules", () => {
	const config = resolveIsolation({
		lane: { allowedTools: ["subagent", "teams_send_chat_message", "teams_read_chat", "lanes_journal"] },
		children: { blockedTools: ["teams_*", "subagent"] },
		ownLane: { teams_read_chat: { param: "chat", env: "PI_TEAMS_WORKER_CHAT" } },
	});
	const guard: Guard = { protectedPaths: [lanes] };
	const env = { PI_TEAMS_WORKER_CHAT: "19:abc" };
	const call = (role: "lane" | "child", tool: string, input: unknown = {}) =>
		checkCall({ role, tool, input, cwd: "/workspace", config, guard, env, home });

	test("globs", () => {
		assert.ok(toolMatches("teams_read_chat", ["teams_*"]));
		assert.ok(!toolMatches("teams_read_chat", ["teams_send*"]));
	});
	test("a lane gets only its allow list", () => {
		assert.equal(call("lane", "subagent"), undefined);
		assert.match(call("lane", "memory_search") ?? "", /not available in a lane/);
		assert.match(call("lane", "teams_search_messages") ?? "", /not available in a lane/);
	});
	test("children work freely, except for what is blocked for them", () => {
		assert.equal(call("child", "bash", { command: "npm test" }), undefined);
		assert.match(call("child", "teams_read_chat", { chat: "19:abc" }) ?? "", /processes a lane starts/);
		assert.match(call("child", "subagent") ?? "", /processes a lane starts/);
	});
	test("own conversation only, and the refusal says which one", () => {
		assert.equal(call("lane", "teams_read_chat", { chat: "19:abc" }), undefined);
		const refusal = call("lane", "teams_read_chat", { chat: "Bob" }) ?? "";
		assert.match(refusal, /own conversation only/);
		assert.match(refusal, /chat: "19:abc"/);
		assert.match(checkCall({ role: "lane", tool: "teams_read_chat", input: { chat: "19:abc" }, cwd: "/", config, guard, env: {}, home }) ?? "", /does not/);
	});
	test("no allow list: every tool, as before", () => {
		const open = resolveIsolation(undefined);
		assert.equal(checkCall({ role: "lane", tool: "bash", input: { command: "ls" }, cwd: "/", config: open, guard, env, home }), undefined);
	});
});

describe("paths", () => {
	const guard: Guard = { protectedPaths: [lanes, "/home/neo/.pi/agent/sessions"] };
	test("spellings", () => {
		assert.deepEqual(spellings(lanes, home).sort(), [lanes, "$HOME/.pi/agent/pi-lanes", "${HOME}/.pi/agent/pi-lanes", "~/.pi/agent/pi-lanes"].sort());
	});
	test("path arguments are resolved against the cwd", () => {
		assert.equal(pathViolation({ path: "pi-lanes/journal.jsonl" }, "/home/neo/.pi/agent", guard, home), lanes);
		assert.equal(pathViolation({ path: "../.pi/agent/sessions/x.jsonl" }, "/home/neo/work", guard, home), "/home/neo/.pi/agent/sessions");
		assert.equal(pathViolation({ path: "src/index.ts" }, "/workspace/repo", guard, home), undefined);
	});
	test("commands are searched for every spelling", () => {
		for (const command of [
			"cat /home/neo/.pi/agent/pi-lanes/journal.jsonl",
			"grep -r Gehalt ~/.pi/agent/pi-lanes/sessions",
			'ls "$HOME/.pi/agent/sessions"',
			"tail ${HOME}/.pi/agent/pi-lanes/journal.jsonl",
		]) {
			assert.ok(pathViolation({ command }, "/workspace", guard, home), command);
		}
		assert.equal(pathViolation({ command: "git -C /workspace/repo log" }, "/workspace", guard, home), undefined);
	});
	test("a symlink to a protected place counts as that place", () => {
		const base = mkdtempSync(join(tmpdir(), "pi-lanes-iso-"));
		const secret = join(base, "secret");
		mkdirSync(secret);
		symlinkSync(secret, join(base, "alias"));
		assert.equal(pathViolation({ path: join(base, "alias", "x") }, base, { protectedPaths: [secret] }, home), secret);
	});
	test("a lane has its own workspace, the others are closed", () => {
		const root = "/workspace/lanes";
		const own = laneCwd(root, "teams:19:abc", "/workspace");
		const other = laneCwd(root, "teams:19:bob", "/workspace");
		assert.equal(own, join(root, laneHash("teams:19:abc")));
		const ws: Guard = { protectedPaths: [], workspace: { root, own } };
		assert.equal(pathViolation({ path: "notes.md" }, own, ws, home), undefined);
		assert.equal(pathViolation({ command: `cat ${own}/notes.md` }, own, ws, home), undefined);
		assert.equal(pathViolation({ path: join(other, "notes.md") }, own, ws, home), root);
		assert.equal(pathViolation({ path: "../" + laneHash("teams:19:bob") }, own, ws, home), root);
		assert.equal(pathViolation({ command: `cat ${other}/notes.md` }, own, ws, home), root);
		assert.equal(pathViolation({ command: `ls ${root}` }, own, ws, home), root);
		assert.equal(pathViolation({ path: "/workspace/repo/x" }, own, ws, home), undefined);
	});
	test("without a workspace root, lanes share the cwd", () => {
		assert.equal(laneCwd(undefined, "teams:1", "/workspace"), "/workspace");
	});
});
