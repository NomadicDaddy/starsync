/**
 * When a process started, read from the system, so a heavy slot can tell its runner from a later
 * process that was given the same pid (heavy.ts; Morticia #53017). Windows reuses pids soon after a
 * process ends, so a pid that answers is not proof that the runner which wrote the slot still runs.
 *
 * Null whenever the time cannot be read: another account's process, a missing tool, or a pid that
 * has gone. The caller then treats the process as the one it recorded, as it treats EPERM.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { platform } from 'node:process';

/** Milliseconds since the epoch at which `pid` started, or null when that cannot be read. */
export function processStartMs(pid: number): null | number {
	const command =
		platform === 'win32'
			? [
					'pwsh',
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
				]
			: ['ps', '-o', 'lstart=', '-p', String(pid)];
	try {
		const ran = Bun.spawnSync(command, { stderr: 'ignore', stdout: 'pipe', windowsHide: true });
		if (ran.exitCode !== 0) return null;
		const at = Date.parse(ran.stdout.toString().trim());
		return Number.isNaN(at) ? null : at;
	} catch {
		return null; // The tool is not installed.
	}
}
