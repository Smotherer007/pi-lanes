/**
 * lanes_journal: who the lanes talked to, and when. What they were asked and
 * what they answered only for those who may look across lanes.
 *
 * Reading across lanes is exactly what separate lanes prevent, so a lane sees
 * the contents only when it was started as trusted (the extension that routed
 * it said so in its hint). Every other lane gets the outline: which lane, who,
 * when, how long. The front session is never restricted.
 */

import { Type } from "typebox";
import { getAgentDir } from "./config.ts";
import { readJournal, type JournalEntry } from "./journal.ts";
import { laneIdentity, type LaneIdentity } from "./lane.ts";

export interface JournalParams {
	lane?: string;
	sinceHours?: number;
	limit?: number;
}

/** Whether this process may see what lanes were asked and answered, not only who and when. */
export function mayReadContents(identity: LaneIdentity | undefined): boolean {
	return !identity || identity.trusted;
}

export const OUTLINE_NOTE =
	"Only who and when is shown here. What other conversations were about stays in them: every lane keeps its " +
	"own context, and only lanes started as trusted may read it.";

export function renderJournal(entries: JournalEntry[], params: JournalParams, now = Date.now(), contents = true): string {
	const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
	const since = now - Math.min(Math.max(params.sinceHours ?? 24, 1), 24 * 90) * 3_600_000;
	const needle = params.lane?.trim().toLowerCase();

	const hits = entries.filter((entry) => {
		const at = Date.parse(entry.at ?? "");
		if (!Number.isFinite(at) || at < since) return false;
		if (!needle) return true;
		return `${entry.label ?? ""} ${entry.lane ?? ""} ${entry.from ?? ""}`.toLowerCase().includes(needle);
	});
	const shown = hits.slice(-limit);
	if (shown.length === 0) return "No lane activity in that window.";

	const lines = shown.map((entry) => {
		const parts = [`- ${new Date(entry.at).toLocaleString()} · ${entry.label} · ${entry.event}`];
		if (entry.from) parts.push(`from ${entry.from}`);
		if (contents && entry.request) parts.push(`asked: ${entry.request}`);
		if (contents && entry.result) parts.push(`answered: ${entry.result}`);
		if (entry.durationMs) parts.push(`${Math.round(entry.durationMs / 1000)} s`);
		if (contents && entry.detail) parts.push(entry.detail);
		return parts.join(" · ");
	});
	const more = hits.length > shown.length ? `\n\n(${hits.length - shown.length} older entries not shown)` : "";
	return lines.join("\n") + more + (contents ? "" : `\n\n${OUTLINE_NOTE}`);
}

export const lanesJournalTool = {
	name: "lanes_journal",
	label: "Lanes Journal",
	description:
		"Look up which lanes (background pi processes, e.g. one per Teams chat) were active, for whom and when. " +
		"In a trusted lane or the front session it also shows what they were asked and answered. Read-only.",
	parameters: Type.Object({
		lane: Type.Optional(Type.String({ description: "Only lanes whose name, key or requester contains this text" })),
		sinceHours: Type.Optional(Type.Number({ description: "How far back, in hours (default 24, max 2160)" })),
		limit: Type.Optional(Type.Number({ description: "Most recent entries to show (default 20, max 200)" })),
	}),
	async execute(_toolCallId: string, params: JournalParams) {
		const text = renderJournal(readJournal(getAgentDir()), params, Date.now(), mayReadContents(laneIdentity()));
		return { content: [{ type: "text" as const, text }], details: {} };
	},
};
