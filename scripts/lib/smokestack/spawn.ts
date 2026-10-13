/**
 * Starts one step and waits for it, and can stop it with everything it started.
 *
 * Every step is `bun run <script>`, so the process doing the work is always a child of the child
 * this starts. Stopping only the child leaves the work running, holding files and ports, after the
 * gate has reported. So a stop takes the whole tree: on Windows by the process tree, elsewhere by
 * the process group the step is started in.
 *
 * A step gets no standard input, in a terminal and in a commit hook alike. A hook has none; a step
 * that read a terminal's would behave one way at the keyboard and another at commit time. A step
 * that asks a question reads end-of-file.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
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

function stopTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (platform === 'win32') {
		spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
			stdio: 'ignore',
			windowsHide: true,
		});
		return;
	}
	try {
		// Negative: the group the step leads, which holds everything it started.
		kill(-child.pid, 'SIGTERM');
	} catch {
		// Already gone.
	}
}

/**
 * Runs `run` in `cwd` and resolves when it has ended. When `signal` aborts, the step and everything
 * it started are stopped and the result is `stopped`, whatever exit code the dying process gave.
 */
export function runProcess(run: string[], cwd: string, signal: AbortSignal): Promise<Ended> {
	const [program, ...args] = run;
	if (program === undefined) {
		return Promise.resolve({ reason: 'the step has no program', state: 'could-not-start' });
	}
	if (signal.aborted) return Promise.resolve({ state: 'stopped' });

	return new Promise<Ended>((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(resolveProgram(program), args, {
				cwd,
				detached: platform !== 'win32',
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
