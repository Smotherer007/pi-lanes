/**
 * lanes_journal: what the lanes were asked, and what they answered.
 *
 * Reading across lanes is exactly what separate lanes prevent by default, so a
 * lane may use this tool only when it was started as trusted (the extension
 * that routed it said so in its hint). The front session is never restricted.
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

export function journalRefusal(identity: LaneIdentity | undefined): string | undefined {
	if (!identity || identity.trusted) return undefined;
	return (
		"What other lanes were asked is not available here. Every lane keeps its own context, and only lanes " +
		"started as trusted may look across them."
	);
}

export function renderJournal(entries: JournalEntry[], params: JournalParams, now = Date.now()): string {
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
		if (entry.request) parts.push(`asked: ${entry.request}`);
		if (entry.result) parts.push(`answered: ${entry.result}`);
		if (entry.durationMs) parts.push(`${Math.round(entry.durationMs / 1000)} s`);
		if (entry.detail) parts.push(entry.detail);
		return parts.join(" · ");
	});
	const more = hits.length > shown.length ? `\n\n(${hits.length - shown.length} older entries not shown)` : "";
	return lines.join("\n") + more;
}

export const lanesJournalTool = {
	name: "lanes_journal",
	label: "Lanes Journal",
	description:
		"Look up what the lanes (background pi processes, e.g. one per Teams chat) were asked and what they " +
		"answered. Use it when someone asks what happened in another conversation or job. Read-only.",
	parameters: Type.Object({
		lane: Type.Optional(Type.String({ description: "Only lanes whose name, key or requester contains this text" })),
		sinceHours: Type.Optional(Type.Number({ description: "How far back, in hours (default 24, max 2160)" })),
		limit: Type.Optional(Type.Number({ description: "Most recent entries to show (default 20, max 200)" })),
	}),
	async execute(_toolCallId: string, params: JournalParams) {
		const refusal = journalRefusal(laneIdentity());
		if (refusal) return { content: [{ type: "text" as const, text: refusal }], details: { error: true } };
		const text = renderJournal(readJournal(getAgentDir()), params);
		return { content: [{ type: "text" as const, text }], details: {} };
	},
};
