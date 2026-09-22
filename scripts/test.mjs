#!/usr/bin/env node
/**
 * Test runner.
 *
 * Node strips TypeScript types natively from v23.6 on; v22 needs
 * `--experimental-strip-types`. Passing the flag unconditionally would tie the
 * package to whichever Node versions still accept it, so it is added only
 * where it is actually required.
 *
 * Extra arguments are forwarded to `node --test`, e.g.
 *   npm test -- --watch
 */

import { spawn } from "node:child_process";

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);
const needsFlag = major < 23 || (major === 23 && minor < 6);

const args = [
	...(needsFlag ? ["--experimental-strip-types", "--no-warnings=ExperimentalWarning"] : []),
	"--test",
	...process.argv.slice(2),
	"test/**/*.test.ts",
];

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 1);
});
