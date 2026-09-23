/**
 * Isolation: what a lane, and everything it starts, may reach.
 *
 * Separate sessions keep lanes from *knowing* about each other. Isolation keeps
 * them from *looking*: a lane that is asked "what did Bob talk about?" must not
 * be able to read Bob's session files, his lane's workspace, or his chat. The
 * rules live here, next to the lanes, because keeping lanes apart is what
 * pi-lanes promises.
 *
 * Two roles below the front session:
 *
 * - **lane**: the `pi --mode rpc` process pi-lanes started. It talks to the
 *   outside world, so its tools can be limited to an allow list.
 * - **child**: anything the lane starts (a subagent, a background review, a
 *   `pi -p`). It inherits `PI_LANE`, and pi-lanes marks it with
 *   `PI_LANE_CHILD` (the lane's pid), which the model cannot change.
 *
 * Checked on every tool call in both roles:
 *
 * 1. Tool lists (`lane.allowedTools`, `lane.blockedTools`, `children.blockedTools`).
 * 2. `ownLane`: a tool argument must equal a value from the lane's environment,
 *    e.g. `teams_read_chat` only with the chat the lane answers.
 * 3. Protected paths: `<agent dir>/pi-lanes` always, plus `protectedPaths`, plus
 *    the workspaces of all other lanes. Path arguments are resolved (symlinks
 *    included); every other string argument, a bash command above all, is
 *    searched for the paths in their usual spellings (absolute, `~/`, `$HOME/`).
 *
 * The string search is a guard rail, not a sandbox: a command that assembles a
 * path at run time gets past it. Where that matters, run lanes as their own OS
 * user, or in a sandbox.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type IsolationRole = "lane" | "child";

export interface OwnLaneRule {
	/** The tool argument to check, e.g. "chat" */
	param: string;
	/** The environment variable holding the only allowed value, e.g. "PI_TEAMS_WORKER_CHAT" */
	env: string;
}

export interface IsolationConfig {
	lane?: { allowedTools?: string[]; blockedTools?: string[] };
	children?: { blockedTools?: string[] };
	ownLane?: Record<string, OwnLaneRule>;
	protectedPaths?: string[];
	/** Root of per-lane working directories. Absent: all lanes share the front session's cwd. */
	workspace?: string;
}

export interface ResolvedIsolation {
	lane: { allowedTools: string[]; blockedTools: string[] };
	children: { blockedTools: string[] };
	ownLane: Record<string, OwnLaneRule>;
	protectedPaths: string[];
	workspace?: string;
}

export const CHILD_ENV = "PI_LANE_CHILD";
export const WORKSPACE_ENV = "PI_LANE_WORKSPACE";

export function expandHome(path: string, home = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function list(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}

export function resolveIsolation(value: IsolationConfig | undefined): ResolvedIsolation {
	const v: IsolationConfig = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const ownLane: Record<string, OwnLaneRule> = {};
	if (v.ownLane && typeof v.ownLane === "object") {
		for (const [tool, rule] of Object.entries(v.ownLane)) {
			if (rule && typeof rule.param === "string" && typeof rule.env === "string" && rule.param && rule.env) {
				ownLane[tool] = { param: rule.param, env: rule.env };
			}
		}
	}
	const workspace = typeof v.workspace === "string" && v.workspace.trim() ? resolve(expandHome(v.workspace.trim())) : undefined;
	return {
		lane: { allowedTools: list(v.lane?.allowedTools), blockedTools: list(v.lane?.blockedTools) },
		children: { blockedTools: list(v.children?.blockedTools) },
		ownLane,
		protectedPaths: list(v.protectedPaths).map((p) => resolve(expandHome(p))),
		workspace,
	};
}

/**
 * Which role this process has, decided once when the extension loads.
 *
 * The lane marks itself as the parent of everything it starts by putting its
 * pid into `PI_LANE_CHILD`. A process that finds someone else's pid there is a
 * child; the lane itself finds its own (after a reload) or none.
 */
export function roleOf(env: NodeJS.ProcessEnv = process.env, pid = process.pid): IsolationRole | undefined {
	if (!env.PI_LANE?.trim()) return undefined;
	const marker = env[CHILD_ENV];
	return marker && marker !== String(pid) ? "child" : "lane";
}

/** Glob match on tool names: `*` stands for anything. */
export function toolMatches(name: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		if (pattern === name) return true;
		if (!pattern.includes("*")) return false;
		const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		return re.test(name);
	});
}

/** The working directory of a lane below the workspace root. */
export function laneWorkspace(root: string, key: string): string {
	return join(root, key);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// Not there (yet): resolve what exists of it, so a symlinked parent still counts.
		const parent = dirname(path);
		if (parent === path) return path;
		return join(real(parent), basename(path));
	}
}

function inside(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The ways a path is usually written in a command. */
export function spellings(path: string, home = homedir()): string[] {
	const out = new Set([path]);
	if (inside(path, home) && path !== home) {
		const rel = relative(home, path);
		out.add(`~/${rel}`);
		out.add(`$HOME/${rel}`);
		out.add(`\${HOME}/${rel}`);
	}
	return [...out];
}

export interface Guard {
	/** Paths nobody in the lane may touch */
	protectedPaths: string[];
	/** Root of all lane workspaces, and this lane's own one */
	workspace?: { root: string; own?: string };
}

function forbiddenPath(path: string, guard: Guard): string | undefined {
	const candidates = [path, real(path)];
	for (const p of candidates) {
		for (const dir of guard.protectedPaths) if (inside(p, dir) || inside(p, real(dir))) return dir;
		const ws = guard.workspace;
		if (ws && (inside(p, ws.root) || inside(p, real(ws.root)))) {
			if (!ws.own || !(inside(p, ws.own) || inside(p, real(ws.own)))) return ws.root;
		}
	}
	return undefined;
}

const PATH_KEY = /path|file|dir|folder|cwd|root/i;

function strings(value: unknown, key = "", out: Array<{ key: string; value: string }> = []): Array<{ key: string; value: string }> {
	if (typeof value === "string") out.push({ key, value });
	else if (Array.isArray(value)) for (const item of value) strings(item, key, out);
	else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, k, out);
	return out;
}

/** A protected path mentioned anywhere in a string. */
function mentioned(text: string, guard: Guard, home: string): string | undefined {
	for (const dir of guard.protectedPaths) {
		if (spellings(dir, home).some((s) => text.includes(s))) return dir;
	}
	const ws = guard.workspace;
	if (ws) {
		for (const root of spellings(ws.root, home)) {
			let at = text.indexOf(root);
			while (at >= 0) {
				const rest = text.slice(at + root.length);
				// The root itself, or a sibling: `<root>`, `<root>/`, `<root>/other…`
				const segment = rest.startsWith("/") ? rest.slice(1).split(/[/\s'"`;|&)]/)[0] : "";
				const own = ws.own ? basename(ws.own) : undefined;
				if (!own || segment !== own) return ws.root;
				at = text.indexOf(root, at + root.length);
			}
		}
	}
	return undefined;
}

/** Why a tool call touches a place it must not, or undefined. */
export function pathViolation(input: unknown, cwd: string, guard: Guard, home = homedir()): string | undefined {
	for (const { key, value } of strings(input)) {
		if (PATH_KEY.test(key) && value.trim() && !value.includes("\n")) {
			const hit = forbiddenPath(resolve(cwd, expandHome(value.trim(), home)), guard);
			if (hit) return hit;
		}
		const hit = mentioned(value, guard, home);
		if (hit) return hit;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface CallCheck {
	role: IsolationRole;
	tool: string;
	input: unknown;
	cwd: string;
	config: ResolvedIsolation;
	guard: Guard;
	env?: NodeJS.ProcessEnv;
	home?: string;
}

/** The reason a call is refused, or undefined when it may run. */
export function checkCall(call: CallCheck): string | undefined {
	const { role, tool, config } = call;
	const env = call.env ?? process.env;

	if (role === "lane") {
		const { allowedTools, blockedTools } = config.lane;
		if ((allowedTools.length > 0 && !toolMatches(tool, allowedTools)) || toolMatches(tool, blockedTools)) {
			return `The tool "${tool}" is not available in a lane. Hand the work to a subagent, if you have one, with a complete, self-contained task.`;
		}
	} else if (toolMatches(tool, config.children.blockedTools)) {
		return `The tool "${tool}" is not available to processes a lane starts.`;
	}

	const rule = Object.entries(config.ownLane).find(([pattern]) => toolMatches(tool, [pattern]))?.[1];
	if (rule) {
		const own = env[rule.env]?.trim();
		const given = (call.input as Record<string, unknown> | undefined)?.[rule.param];
		if (!own) return `"${tool}" is only available in a lane that belongs to one conversation, and this one does not.`;
		if (typeof given !== "string" || given.trim() !== own) {
			return `This lane may use "${tool}" for its own conversation only. Call it with ${rule.param}: "${own}". Other conversations are not available here.`;
		}
	}

	const hit = pathViolation(call.input, call.cwd, call.guard, call.home);
	if (hit) {
		return `This call reaches ${hit}, which is closed to lanes: it holds other conversations, or state that belongs to the front session.`;
	}
	return undefined;
}
