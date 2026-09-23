import { test } from "node:test";
import assert from "node:assert/strict";
import { mayReadContents, renderJournal } from "../src/tools.ts";
import { laneIdentity } from "../src/lane.ts";

test("the front session and trusted lanes see contents, other lanes only who and when", () => {
	assert.equal(mayReadContents(undefined), true);
	assert.equal(mayReadContents({ lane: "a", label: "A", trusted: true }), true);
	assert.equal(mayReadContents({ lane: "a", label: "A", trusted: false }), false);
});

test("the outline shows who and when, never what", () => {
	const now = Date.parse("2026-09-22T12:00:00Z");
	const text = renderJournal(
		[
			{ at: "2026-09-22T11:00:00Z", lane: "teams:1", label: "Anna", event: "done", from: "anna@x.de", request: "Gehaltsgespräch vorbereiten", result: "Entwurf fertig", durationMs: 42_000 },
			{ at: "2026-09-22T11:05:00Z", lane: "teams:1", label: "Anna", event: "error", detail: "lane ended: Gehalt" },
		],
		{},
		now,
		false,
	);
	assert.match(text, /Anna · done · from anna@x\.de · 42 s/);
	assert.doesNotMatch(text, /Gehalt|Entwurf/);
	assert.match(text, /Only who and when/);
});

test("lane identity comes from the environment", () => {
	assert.deepEqual(laneIdentity({ PI_LANE: "teams:1", PI_LANE_LABEL: "Anna", PI_LANE_TRUSTED: "1" }), {
		lane: "teams:1",
		label: "Anna",
		trusted: true,
	});
	assert.equal(laneIdentity({}), undefined);
});

test("renderJournal filters by time and lane", () => {
	const now = Date.parse("2026-09-22T12:00:00Z");
	const text = renderJournal(
		[
			{ at: "2026-09-22T11:00:00Z", lane: "teams:1", label: "Anna", event: "done", result: "ok" },
			{ at: "2026-09-22T11:30:00Z", lane: "teams:2", label: "Bob", event: "start" },
			{ at: "2026-09-01T11:30:00Z", lane: "teams:1", label: "Anna", event: "start" },
		],
		{ lane: "anna" },
		now,
	);
	assert.match(text, /Anna · done · answered: ok/);
	assert.doesNotMatch(text, /Bob|09\/01/);
});
