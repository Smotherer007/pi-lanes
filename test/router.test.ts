/**
 * Routing: what stays in the front session and what goes to a lane.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { controlOf, decideRoute, HintStore, HINT_TTL_MS, isFrontSession, labelFor, sanitizeHint } from "../src/router.ts";
import { resolveConfig } from "../src/config.ts";

const config = resolveConfig(undefined);

describe("decideRoute", () => {
	const now = 1_000_000;
	test("a hint decides", () => {
		assert.equal(decideRoute({ hint: { text: "x", lane: "a" }, now, config }), "lane");
		assert.equal(decideRoute({ hint: { text: "x", session: true }, now, config }), "session");
	});
	test("a hint wins over a recent key press", () => {
		assert.equal(decideRoute({ hint: { text: "x", lane: "a" }, lastKeyAt: now - 1, now, config }), "lane");
	});
	test("without a hint, a prompt right after a key press stays (a slash command)", () => {
		assert.equal(decideRoute({ lastKeyAt: now - 2_000, now, config }), "session");
	});
	test("without a hint and nobody typing, it is background work", () => {
		assert.equal(decideRoute({ lastKeyAt: now - 60_000, now, config }), "lane");
		assert.equal(decideRoute({ now, config }), "lane");
	});
	test("unhinted: session keeps plain pi behaviour", () => {
		assert.equal(decideRoute({ now, config: resolveConfig({ unhinted: "session" }) }), "session");
	});
});

describe("hints", () => {
	test("are matched by exact prompt text, once", () => {
		const store = new HintStore();
		store.add({ text: "p", lane: "teams:1" });
		assert.equal(store.take("other"), undefined);
		assert.equal(store.take("p")?.lane, "teams:1");
		assert.equal(store.take("p"), undefined);
	});
	test("expire", () => {
		const store = new HintStore();
		store.add({ text: "p", lane: "a" }, 0);
		assert.equal(store.take("p", HINT_TTL_MS + 1), undefined);
	});
	test("are sanitised: junk is dropped, env keys must be names", () => {
		assert.equal(sanitizeHint(null), undefined);
		assert.equal(sanitizeHint({ lane: "a" }), undefined);
		const h = sanitizeHint({ text: "p", env: { OK_1: "v", "bad key": "x", NUM: 3 }, trusted: "yes" });
		assert.deepEqual(h?.env, { OK_1: "v" });
		assert.equal(h?.trusted, false);
	});
});

describe("control words", () => {
	test("only the whole command counts", () => {
		assert.equal(controlOf("Stopp!", config), "stop");
		assert.equal(controlOf("Neues Thema.", config), "reset");
		assert.equal(controlOf("stopp bitte das Deployment", config), undefined);
		assert.equal(controlOf(undefined, config), undefined);
	});
});

test("labelFor shortens", () => {
	assert.equal(labelFor("a\n b"), "a b");
	assert.equal(labelFor("x".repeat(50), 10), "xxxxxxxxx…");
});

test("config clamps and keeps maxLanes >= maxConcurrent", () => {
	const c = resolveConfig({ maxConcurrent: 99, maxLanes: 2, stopWords: ["Halt!"], env: { A: "1", B: 2 as any } });
	assert.equal(c.maxConcurrent, 16);
	assert.equal(c.maxLanes, 16);
	assert.deepEqual(c.stopWords, ["halt"]);
	assert.deepEqual(c.env, { A: "1" });
	assert.equal(resolveConfig(undefined).unhinted, "lane");
});

describe("no chains: only the terminal session routes", () => {
	const base = { hasUI: true, enabled: true };
	test("the interactive session routes", () => {
		assert.equal(isFrontSession({ ...base, mode: "tui", env: {} }), true);
	});
	test("a lane never routes, whatever its mode", () => {
		assert.equal(isFrontSession({ ...base, mode: "rpc", env: { PI_LANE: "teams:1" } }), false);
	});
	test("a process started from a lane inherits PI_LANE and never routes, even interactive", () => {
		assert.equal(isFrontSession({ ...base, mode: "tui", env: { PI_LANE: "teams:1" } }), false);
	});
	test("subagents, print runs and RPC embeddings do not route", () => {
		assert.equal(isFrontSession({ hasUI: false, enabled: true, mode: "json", env: {} }), false);
		assert.equal(isFrontSession({ hasUI: false, enabled: true, mode: "print", env: {} }), false);
		assert.equal(isFrontSession({ ...base, mode: "rpc", env: {} }), false);
	});
	test("switched off, nothing routes", () => {
		assert.equal(isFrontSession({ ...base, enabled: false, mode: "tui", env: {} }), false);
	});
});
