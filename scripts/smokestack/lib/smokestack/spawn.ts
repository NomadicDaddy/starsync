/**
 * Starts one step and waits for it, and can stop it with what it started.
 *
 * Every step is `bun run <script>`, so the process doing the work is always a child of the child
 * this starts. Stopping only the child leaves the work running, holding files and ports, after the
 * gate has reported. So a stop takes the whole tree: on Windows by the process tree. Elsewhere it
 * takes every process descended from the step, found by its parent links before anything is
 * signalled, and then signals the group the step leads and each of those processes, so one started
 * detached in a group of its own is stopped too (runner-stop-reaches-detached-grandchildren-on-
 * posix). A process orphaned to init before the stop began is no longer the step's descendant, and
 * nothing finds it; nor does anything find one started detached after the descendants are taken.
 *
 * A step gets no standard input, in a terminal and in a commit hook alike. A hook has none; a step
 * that read a terminal's would behave one way at the keyboard and another at commit time. A step
 * that asks a question reads end-of-file.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execPath, kill, platform } from 'node:process';

export type Ended =
	| { code: number; state: 'exited' }
	| { reason: string; state: 'could-not-start' }
	| { state: 'stopped' };

const INTERRUPT_GRACE_MS = 100;

/** The same bun that is running the gate, not whichever is first on PATH. */
function resolveProgram(program: string): string {
	return program === 'bun' ? execPath : program;
}

/**
 * With an allow-list (`env` given), the bun the runner starts is told not to load .env files, which
 * would put keys the list does not name back into its environment. Only that bun: one a script
 * starts loads them again, so with a list those files are keyed instead (env.ts, cache.ts).
 */
function argsFor(
	program: string,
	args: string[],
	env: Record<string, string> | undefined,
): string[] {
	return program === 'bun' && env !== undefined ? ['--no-env-file', ...args] : args;
}

/** A running process's parent, and where /proc tells it, when it started (in clock ticks). */
interface Link {
	parent: number;
	started: string | undefined;
}

/**
 * The parent pid and start time of the process `pid`, from /proc/<pid>/stat, or undefined where
 * it is gone. The command name sits in parentheses and may hold spaces; counting from the state
 * after the last ')', the parent is the second field and the start time the twentieth (stat(5)
 * fields 4 and 22).
 */
function procLink(pid: string): Link | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		const parent = Number(fields[1]);
		return Number.isInteger(parent) ? { parent, started: fields[19] } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every running process's link, by pid: from /proc where there is one (Linux), else from ps,
 * which gives no start time. Empty where neither can be read, which leaves the stop to the step's
 * group alone.
 */
function parentLinks(): Map<number, Link> {
	const links = new Map<number, Link>();
	if (existsSync('/proc/self/stat')) {
		for (const name of readdirSync('/proc')) {
			const link = /^\d+$/u.test(name) ? procLink(name) : undefined;
			if (link !== undefined) links.set(Number(name), link);
		}
		return links;
	}
	const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
	if (ps.status !== 0) return links;
	for (const line of ps.stdout.split('\n')) {
		const [pid, parent] = line.trim().split(/\s+/u).map(Number);
		if (
			pid !== undefined &&
			parent !== undefined &&
			Number.isInteger(pid) &&
			Number.isInteger(parent)
		) {
			links.set(pid, { parent, started: undefined });
		}
	}
	return links;
}

/** Every process now descended from `root`, through any number of generations, with its link. */
function descendants(root: number): Map<number, Link> {
	const links = parentLinks();
	const children = new Map<number, number[]>();
	for (const [pid, { parent }] of links) {
		children.set(parent, [...(children.get(parent) ?? []), pid]);
	}
	const found = new Map<number, Link>();
	const queue = [...(children.get(root) ?? [])];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		const link = links.get(next);
		if (found.has(next) || link === undefined) continue;
		found.set(next, link);
		queue.push(...(children.get(next) ?? []));
	}
	return found;
}

function terminate(target: number): void {
	try {
		kill(target, 'SIGTERM');
	} catch {
		// Already gone.
	}
}

/**
 * Signals a descendant found before the stop, unless its pid already names another process: where
 * /proc gave a start time, it is read again just before the signal, and a changed one means the
 * process exited and the pid was reused since the descendants were taken (Morticia, c6d74a0). That
 * narrows the window rather than closing it: the reread and the signal are separate calls, so a
 * pid reused between them can still be signalled (Roger, 57e9719). With ps there is no start time
 * to read, and the whole window remains.
 */
function terminateFound(pid: number, link: Link): void {
	if (link.started !== undefined && procLink(String(pid))?.started !== link.started) return;
	terminate(pid);
}

function stopTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (platform === 'win32') {
		spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
			stdio: 'ignore',
			windowsHide: true,
		});
		return;
	}
	// Taken before anything is signalled: once a parent dies its children are handed to init, and
	// their link to the step is gone (see the header).
	const found = descendants(child.pid);
	// Negative: the group the step leads. Then each descendant by pid, which reaches one started
	// detached in a group of its own.
	terminate(-child.pid);
	for (const [pid, link] of found) terminateFound(pid, link);
}

/**
 * Runs `run` in `cwd` and resolves when it has ended. When `signal` aborts, the step and what it
 * started are stopped (on POSIX its process group and every descendant found; see the header) and
 * the result is `stopped`, whatever exit code the dying process gave.
 * `env` is the whole environment the step is handed; undefined hands it this process's (env.ts),
 * and only then does a bun the runner starts load .env files.
 * `onStart` is told the step's pid once it is running (a heavy slot records it; heavy.ts).
 */
export function runProcess(
	run: string[],
	cwd: string,
	env: Record<string, string> | undefined,
	signal: AbortSignal,
	onStart?: (pid: number) => void,
): Promise<Ended> {
	const [program, ...args] = run;
	if (program === undefined) {
		return Promise.resolve({ reason: 'the step has no program', state: 'could-not-start' });
	}
	if (signal.aborted) return Promise.resolve({ state: 'stopped' });

	return new Promise<Ended>((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(resolveProgram(program), argsFor(program, args, env), {
				cwd,
				detached: platform !== 'win32',
				env,
				stdio: ['ignore', 'inherit', 'inherit'],
				windowsHide: true,
			});
		} catch (err) {
			resolve({
				reason: err instanceof Error ? err.message : String(err),
				state: 'could-not-start',
			});
			return;
		}

		const onAbort = (): void => {
			stopTree(child);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		// Told only once the step is supervised, and never allowed to throw past it: a throw here
		// would leave a running step with nothing waiting on it (Roger 5Q-2, Morticia #53274).
		if (child.pid !== undefined && onStart !== undefined) {
			try {
				onStart(child.pid);
			} catch (err) {
				console.error(
					`    [WARN] could not record the step's pid (${err instanceof Error ? err.message : String(err)})`,
				);
			}
		}
		const settle = (ended: Ended): void => {
			signal.removeEventListener('abort', onAbort);
			resolve(signal.aborted ? { state: 'stopped' } : ended);
		};
		child.once('error', (err) => {
			settle({ reason: err.message, state: 'could-not-start' });
		});
		child.once('exit', (code) => {
			// A null code is a process ended by a signal it was not sent by us: a failure.
			const ended: Ended = { code: code ?? 1, state: 'exited' };
			if (ended.code === 0) {
				settle(ended);
				return;
			}
			// A key pressed in a console reaches the step's processes as well as this one, and
			// the step can die of it before this process has been told. Waiting a moment before
			// calling a non-zero exit a failure lets the interruption arrive first, so it is not
			// reported as a failed step with the next one already started.
			setTimeout(() => {
				settle(ended);
			}, INTERRUPT_GRACE_MS);
		});
	});
}

/**
 * Passes an interruption the runner receives to the gate it restarted (smokestack.ts), so the gate
 * stops its steps and exits 130 as it would on a first start. Not on Windows: there a console
 * interrupt already reaches the restarted gate itself, and kill() would end it outright, with its
 * steps left running, before it could stop them. There the runner only stays to report the gate's
 * exit. Returns a function that removes the listeners.
 */
export function relayInterrupts(
	gate: { kill: (signal: NodeJS.Signals) => void },
	on: NodeJS.Platform = platform,
): () => void {
	const listeners = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((name) => {
		const listener = (): void => {
			if (on !== 'win32') gate.kill(name);
		};
		process.on(name, listener);
		return [name, listener] as const;
	});
	return () => {
		for (const [name, listener] of listeners) process.off(name, listener);
	};
}
