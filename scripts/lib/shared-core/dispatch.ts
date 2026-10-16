/**
 * What git actually runs in a repository, and which of a group's files it calls.
 *
 * Split out of check.ts because it answers a different question. check.ts asks whether a target's
 * copy of a file matches its owner; this asks whether anything in that target will ever execute it.
 * Both are needed to classify a guard, and conflating them is what made `--write` willing to
 * deliver a file into a repository whose dispatcher does not chain it.
 *
 * NOTHING HERE IS DECLARED IN THE MANIFEST, deliberately. A hook body already states which guards
 * it chains, and a target's dispatcher already states which of ours it calls. Restating either in
 * JSON would create a second copy free to drift from the first, which is the defect this whole
 * subsystem exists to remove one level down.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SharedCoreGroup } from './manifest.ts';

const configuredHooks = new Map<string, string>();

/**
 * The single value git dispatches hooks from. An empty string means unset, in which case git runs
 * .git/hooks and a file written to the group's targetRoot would never execute. Read once per
 * repository per process: every group with a hook asks it of every target, and a sweep does not
 * change a repository's config.
 */
export function hooksPath(repoPath: string): string {
	const known = configuredHooks.get(repoPath);
	if (known !== undefined) return known;
	const result = Bun.spawnSync(['git', '-C', repoPath, 'config', '--local', 'core.hooksPath'], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	const configured = result.success ? result.stdout.toString().trim() : '';
	configuredHooks.set(repoPath, configured);
	return configured;
}

/**
 * True when `body` invokes `file` as a path rather than merely containing its name somewhere.
 *
 * The boundary is the whole point. A bare `includes` would find `guard.sh` inside `leak-guard.sh`
 * and report a guard as chained by a hook that never names it, and callers turn this answer into a
 * decision about whether to deliver a file.
 */
export function invokes(body: string, file: string): boolean {
	const escaped = file.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&');
	return new RegExp(`(^|[^\\w.-])${escaped}([^\\w.-]|$)`, 'u').test(body);
}

/**
 * The files a group's own hook chains, read out of the hook body rather than declared beside it.
 *
 * The hook already states this and cannot be wrong about it: `.githooks/pre-commit` runs
 * leak-guard.sh and not leak-guard-setup.sh, which `prepare` runs instead. Both pre-commit variants
 * chain the same guard, so this is a property of the group rather than of the variant a particular
 * target receives — which of them a target actually runs is settled separately, against that
 * target's real dispatcher.
 */
export function chainedByHook(group: SharedCoreGroup, ownerRoot: string): Set<string> {
	if (group.hook === undefined) return new Set();
	const body = readFileSync(join(ownerRoot, group.sourceRoot, group.hook), 'utf8');
	const names = group.files
		.map((file) => file.target ?? file.source)
		.filter((name) => name !== group.hook && invokes(body, name));
	return new Set(names);
}

/**
 * Extensions that make a token a script somebody runs. `.json` and `.lock` are deliberately absent:
 * the canonical pre-commit greps for `bun\.lock` and `package\.json` to decide whether to run the
 * license check, and neither is a thing it invokes.
 */
const INVOKED = /[\w.-]+\.(?:bash|cjs|js|mjs|ps1|sh|ts)\b/gu;

/**
 * The script files a hook body invokes, by basename, with comment lines removed first.
 *
 * Basename rather than path because the two idioms in this fleet disagree about the path and agree
 * about the name: the canonical pre-commit writes `bash .githooks/leak-guard.sh` while pre-push
 * writes `bash "$hooks_dir/aidd-history-guard.sh"`, and a scan keyed on either spelling would miss
 * the other. Anything without one of the extensions above is not matched, so a hook chaining an
 * extensionless file is invisible here — an extensionless token cannot be told apart from `set` or
 * `echo`, and a scan that guessed would fail loads for words.
 *
 * Comments are stripped here and NOT in `chainedByHook`, which reads the same bodies. The two ask
 * different questions and a mention in a comment is the wrong answer in opposite directions: there
 * it makes a guard conditional on the target's dispatcher, which errs toward not delivering, while
 * here it would reject a manifest that describes reality correctly. The leak-guard-only pre-commit
 * names `install-leak-guard.ts` in its header for the reader's benefit and invokes nothing of the
 * sort.
 */
export function invokedScripts(body: string): Set<string> {
	const code = body
		.split('\n')
		.filter((line) => !/^\s*#/u.test(line))
		.join('\n');
	return new Set([...code.matchAll(INVOKED)].map((match) => match[0]));
}

/** Commands whose arguments are text written out, not anything run. */
const OUTPUT_COMMANDS = new Set(['echo', 'printf']);

/**
 * A shell body reduced to what it runs: comments removed, including a trailing `#` comment outside
 * quotes, and every `echo` or `printf` command dropped, since their arguments are output. Quoted
 * arguments to anything else stay, because `sh "$dir/leak-guard.sh"` is a call.
 *
 * For a body somebody else wrote, where a mention is the wrong answer in the direction that
 * matters: `standingOf` reads a foreign dispatcher with this, and a guard it merely names in a note
 * or a message must not count as dispatched. Commands are split on `;`, `&`, `&&`, `|` and `||`
 * only outside quotes and escapes, so an output command keeps all of its text, separators included.
 * A `$(…)` or backtick substitution runs wherever it sits outside single quotes, so its text is kept
 * as code even inside an output command; dropping it would read a guard that really runs as not
 * dispatched. Not a shell parser; heredocs are left as they are.
 */
export function executableShell(body: string): string {
	return body.split('\n').map(runnableCommands).join('\n');
}

interface Command {
	/** The text of every `$(…)` and backtick substitution in it, which runs whatever the command. */
	substitutions: string[];
	text: string;
}

/** One line's commands, without comments, and output commands reduced to their substitutions. */
function runnableCommands(line: string): string {
	const commands: Command[] = [];
	let current: Command = { substitutions: [], text: '' };
	let quote: null | string = null;
	for (let i = 0; i < line.length; i++) {
		const char = line[i] as string;
		if (char === '\\' && quote !== "'") {
			current.text += char + (line[i + 1] ?? '');
			i++;
			continue;
		}
		const substitution = quote === "'" ? null : substitutionAt(line, i);
		if (substitution !== null) {
			// Reduced by the same rule, so an output command inside it is text and a call is kept.
			const runs = runnableCommands(substitution.inner);
			current.substitutions.push(runs);
			current.text += ` ${runs} `;
			i = substitution.end - 1;
			continue;
		}
		if (quote !== null) {
			if (char === quote) quote = null;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (char === '#' && (i === 0 || /\s/u.test(line[i - 1] as string))) {
			break;
		} else if (char === ';' || char === '&' || char === '|') {
			commands.push(current);
			current = { substitutions: [], text: '' };
			continue;
		}
		current.text += char;
	}
	commands.push(current);
	return commands
		.map((command) =>
			OUTPUT_COMMANDS.has(command.text.trim().split(/\s+/u)[0] ?? '')
				? command.substitutions.join(' ')
				: command.text,
		)
		.join(' ');
}

/** The `$(…)` or backtick substitution starting at `start`, with its inner text, or null. */
function substitutionAt(line: string, start: number): { end: number; inner: string } | null {
	if (line[start] === '`') {
		const close = line.indexOf('`', start + 1);
		return close === -1 ? null : { end: close + 1, inner: line.slice(start + 1, close) };
	}
	if (line[start] !== '$' || line[start + 1] !== '(') return null;
	let depth = 0;
	for (let i = start + 1; i < line.length; i++) {
		if (line[i] === '(') depth++;
		else if (line[i] === ')' && --depth === 0) {
			return { end: i + 1, inner: line.slice(start + 2, i) };
		}
	}
	return null;
}

/**
 * The body of the hook git will actually run for `hookName`, or null when nothing is dispatched.
 *
 * An unset core.hooksPath is not "no hooks" — it is git's default, `.git/hooks`, which is exactly
 * where a foreign dispatcher such as simple-git-hooks writes. Reading it is how a caller tells a
 * guard a target genuinely runs from one it merely holds a copy of.
 */
/**
 * Whether `configured`, a core.hooksPath value, names `targetRoot` inside `repoPath`. Compared as
 * resolved paths, the way git and `dispatcherBody` read it: `./.githooks`, a trailing separator and
 * an absolute path all name the same directory, and on Windows so does any other letter case.
 */
export function namesTargetRoot(repoPath: string, configured: string, targetRoot: string): boolean {
	if (configured === '') return false;
	const canonical = (path: string): string => {
		const resolved = resolve(path).replace(/[\\/]+$/u, '');
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};
	return canonical(resolve(repoPath, configured)) === canonical(resolve(repoPath, targetRoot));
}

export function dispatcherBody(
	repoPath: string,
	configured: string,
	hookName: string,
): null | string {
	const dir = configured === '' ? join(repoPath, '.git', 'hooks') : resolve(repoPath, configured);
	const path = join(dir, hookName);
	return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
