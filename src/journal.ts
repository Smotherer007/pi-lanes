/**
 * What every lane was asked and answered, one JSON object per line in
 * `<agent dir>/pi-lanes/journal.jsonl`.
 *
 * Lanes keep separate contexts on purpose, so no single session knows what
 * happened in the others. The journal does, and `lanes_journal` reads it.
 */

import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export type JournalEvent = "start" | "steer" | "queued" | "stop" | "reset" | "done" | "error" | "idle-exit";

export interface JournalEntry {
	at: string;
	lane: string;
	label: string;
	event: JournalEvent;
	from?: string;
	request?: string;
	/** The lane's last answer, shortened */
	result?: string;
	durationMs?: number;
	detail?: string;
}

export function lanesHome(agentDir: string): string {
	return join(agentDir, "pi-lanes");
}

export function journalPath(agentDir: string): string {
	return join(lanesHome(agentDir), "journal.jsonl");
}

/** Append an entry. Never throws: a broken journal must not stop an answer. */
export function appendJournal(agentDir: string, entry: JournalEntry): void {
	try {
		const dir = lanesHome(agentDir);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = journalPath(agentDir);
		const isNew = !existsSync(path);
		appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
		if (isNew) chmodSync(path, 0o600);
	} catch {
		/* ignore */
	}
}

/** The last `maxBytes` of the journal, parsed. */
export function readJournal(agentDir: string, maxBytes = 2 * 1024 * 1024): JournalEntry[] {
	const path = journalPath(agentDir);
	if (!existsSync(path)) return [];
	const size = statSync(path).size;
	const start = Math.max(0, size - maxBytes);
	const buffer = Buffer.alloc(size - start);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, start);
	} finally {
		closeSync(fd);
	}
	const lines = buffer.toString("utf-8").split("\n");
	if (start > 0) lines.shift();
	const entries: JournalEntry[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			/* skip */
		}
	}
	return entries;
}

/** One line, at most `max` characters. */
export function excerpt(text: string | undefined, max = 300): string | undefined {
	if (!text) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
