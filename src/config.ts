/**
 * Settings, read from `<agent dir>/pi-lanes.json`.
 *
 * Every field is optional; a missing file means the defaults. Numbers are
 * clamped, so the pool can trust them.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveIsolation, type IsolationConfig, type ResolvedIsolation } from "./isolation.ts";

export type UnhintedRoute = "lane" | "session";

export interface LanesConfig {
	/** Route extension prompts at all (default: true) */
	enabled?: boolean;
	/** Lanes working at the same time (default: 3, 1-16) */
	maxConcurrent?: number;
	/** Lane processes kept alive, busy or idle (default: 6, at least maxConcurrent, max 32) */
	maxLanes?: number;
	/** An idle lane exits after this many minutes; its session stays (default: 30) */
	idleMinutes?: number;
	/** A lane quiet for longer starts a fresh session (default: 72, 0 = always continue) */
	freshAfterHours?: number;
	/** The pi executable (default: "pi") */
	command?: string;
	/** Extra arguments for every lane, e.g. ["--model", "provider/id"] */
	args?: string[];
	/** Extra environment for every lane */
	env?: Record<string, string>;
	/** A trigger whose command is one of these aborts the lane's running work */
	stopWords?: string[];
	/** A trigger whose command is one of these starts the lane over with a fresh session */
	resetWords?: string[];
	/**
	 * Where a prompt without a hint goes (default: "lane", as a one-off lane).
	 * "session" keeps it in the front session, like pi without this package.
	 */
	unhinted?: UnhintedRoute;
	/**
	 * A prompt without a hint that arrives this soon after a key press in the
	 * front session stays there (default: 10 s). That is what a slash command
	 * that asks the agent to do something looks like: the person is right there
	 * and waiting for the answer in this session.
	 */
	userGraceSeconds?: number;
	/** What a lane, and everything it starts, may reach. See isolation.ts. */
	isolation?: IsolationConfig;
}

export interface ResolvedLanesConfig {
	enabled: boolean;
	maxConcurrent: number;
	maxLanes: number;
	idleMinutes: number;
	freshAfterHours: number;
	command: string;
	args: string[];
	env: Record<string, string>;
	stopWords: string[];
	resetWords: string[];
	unhinted: UnhintedRoute;
	userGraceSeconds: number;
	isolation: ResolvedIsolation;
}

export const DEFAULTS: ResolvedLanesConfig = {
	enabled: true,
	maxConcurrent: 3,
	maxLanes: 6,
	idleMinutes: 30,
	freshAfterHours: 72,
	command: "pi",
	args: [],
	env: {},
	stopWords: ["stop", "stopp", "abbrechen", "abbruch", "cancel"],
	resetWords: ["neues thema", "new topic", "reset"],
	unhinted: "lane",
	userGraceSeconds: 10,
	isolation: resolveIsolation(undefined),
};

const BOUNDS = {
	maxConcurrent: { min: 1, max: 16 },
	maxLanes: { min: 1, max: 32 },
	idleMinutes: { min: 1, max: 1440 },
	freshAfterHours: { min: 0, max: 8760 },
	userGraceSeconds: { min: 0, max: 600 },
};

function clamp(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

function words(list: unknown, fallback: string[]): string[] {
	if (!Array.isArray(list)) return [...fallback];
	return list
		.filter((w): w is string => typeof w === "string" && w.trim() !== "")
		.map((w) => normalizeCommand(w));
}

/** Lower case, no punctuation, single spaces. The form commands are compared in. */
export function normalizeCommand(text: string): string {
	return text
		.toLowerCase()
		.replace(/[.,;:!?"'„“”«»()[\]@]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function resolveConfig(value: LanesConfig | undefined): ResolvedLanesConfig {
	const v: LanesConfig = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const maxConcurrent = clamp(v.maxConcurrent, BOUNDS.maxConcurrent, DEFAULTS.maxConcurrent);
	const env: Record<string, string> = {};
	if (v.env && typeof v.env === "object") {
		for (const [key, val] of Object.entries(v.env)) if (typeof val === "string") env[key] = val;
	}
	return {
		enabled: v.enabled !== false,
		maxConcurrent,
		maxLanes: Math.max(maxConcurrent, clamp(v.maxLanes, BOUNDS.maxLanes, DEFAULTS.maxLanes)),
		idleMinutes: clamp(v.idleMinutes, BOUNDS.idleMinutes, DEFAULTS.idleMinutes),
		freshAfterHours: clamp(v.freshAfterHours, BOUNDS.freshAfterHours, DEFAULTS.freshAfterHours),
		command: typeof v.command === "string" && v.command.trim() ? v.command.trim() : DEFAULTS.command,
		args: Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [...DEFAULTS.args],
		env,
		stopWords: words(v.stopWords, DEFAULTS.stopWords),
		resetWords: words(v.resetWords, DEFAULTS.resetWords),
		unhinted: v.unhinted === "session" ? "session" : "lane",
		userGraceSeconds: clamp(v.userGraceSeconds, BOUNDS.userGraceSeconds, DEFAULTS.userGraceSeconds),
		isolation: resolveIsolation(v.isolation),
	};
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "pi-lanes.json");
}

/** Read and resolve the config. A broken file falls back to the defaults. */
export function loadConfig(agentDir = getAgentDir()): { config: ResolvedLanesConfig; error?: string } {
	const path = getConfigPath(agentDir);
	if (!existsSync(path)) return { config: resolveConfig(undefined) };
	try {
		return { config: resolveConfig(JSON.parse(readFileSync(path, "utf-8"))) };
	} catch (err) {
		return {
			config: resolveConfig(undefined),
			error: `${path}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
