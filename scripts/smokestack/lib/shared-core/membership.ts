/**
 * Which groups a repository declares it takes, read from its COMMITTED lock.
 *
 * A declared group (manifest `targets.model: "declared"`) reaches exactly the repositories whose
 * tracked smokestack.lock names it: `"<group>": {}` declares it before its first delivery, and a
 * delivered group holds its files. The declaration is the repository's own reviewed commit, which
 * is why it replaced the owner's gitignored rosters (opt-in-membership-in-the-lock).
 *
 * The answer comes from the blob at HEAD: a half-written or uncommitted edit must not move
 * membership before it is reviewed (Roger 5Q-3, Morticia D-1). A lock that is untracked, does not
 * parse at HEAD, or has uncommitted changes to WHICH groups it declares is reported by name, never
 * taken for "declares nothing", because silently dropping a repository from every group is the
 * hazard the rosters' presence check used to guard, in reverse.
 *
 * An uncommitted change that leaves the declared groups as HEAD has them moves no membership, so
 * it reads as HEAD's answer. That is the state every write leaves behind: it rewrites the entries,
 * never the set, and the lock stays uncommitted, a pending delivery, until the repository's gate
 * commits it (deliveries.ts). The lock check still judges those entries.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCK_FILE, lockFileIn, parseLock, PREVIOUS_LOCK_FILE } from './lock.ts';

export type Membership =
	| { groups: ReadonlySet<string>; kind: 'declared' }
	| { kind: 'no-lock' }
	| { kind: 'unreadable'; reason: string };

function git(root: string, args: string[]): { ok: boolean; out: string } {
	const result = Bun.spawnSync(['git', '-C', root, ...args], {
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
	});
	return { ok: result.success, out: result.stdout.toString() };
}

/**
 * The groups `root`'s committed lock declares, or why that cannot be trusted. `optIn` names the
 * declared groups the answer is for: an uncommitted change is judged only by whether it changes
 * which of those the lock declares, since a write also adds the discovered groups it delivers.
 */
export function committedMembership(root: string, optIn: ReadonlySet<string>): Membership {
	const unreadable = (reason: string): Membership => ({ kind: 'unreadable', reason });
	const paths = [LOCK_FILE, PREVIOUS_LOCK_FILE];
	// Git's view of both lock paths, not the disk's: a tracked lock deleted on disk, or deleted and
	// staged, is a change to membership, never "no lock" (Roger 5Q-3a).
	const listed = git(root, ['ls-files', '--stage', '--', ...paths]);
	if (!listed.ok) return unreadable(`git could not list the lock in ${root}`);
	const index = new Map<string, string>();
	for (const line of listed.out.split('\n').filter((entry) => entry !== '')) {
		const [meta = '', path = ''] = line.split('\t');
		if (meta.split(' ')[2] !== '0') return unreadable(`${path} has an unresolved merge`);
		index.set(path, meta);
	}
	const inHead = git(root, ['rev-parse', '--verify', '-q', 'HEAD']).ok
		? git(root, ['ls-tree', '--name-only', 'HEAD', '--', ...paths]).out.split('\n')
		: [];
	const onDisk = lockFileIn(root);
	const file = onDisk ?? paths.find((p) => index.has(p) || inHead.includes(p));
	if (file === undefined) return { kind: 'no-lock' };
	if (!inHead.includes(file)) {
		return unreadable(index.has(file) ? `${file} is not in HEAD` : `${file} is untracked`);
	}
	const path = join(root, file);
	const committed = declaredAt(git(root, ['show', `HEAD:${file}`]).out, path);
	if (typeof committed === 'string') return unreadable(committed);
	// The next commit is made from the index, so a staged join or retirement moves membership
	// whatever the working tree holds (Roger 5Q-3b); both have to agree with HEAD.
	if (!index.has(file)) return unreadable(`${file} is deleted, uncommitted`);
	if (onDisk !== file) return unreadable(`${file} is deleted in the working tree`);
	const staged = declaredAt(git(root, ['show', `:${file}`]).out, path);
	if (typeof staged === 'string')
		return unreadable(`${file} has staged changes that do not parse`);
	const current = declaredAt(readFileSync(path, 'utf8'), path);
	if (typeof current === 'string') {
		return unreadable(`${file} has uncommitted changes that do not parse`);
	}
	const same = [...optIn].every(
		(group) =>
			current.has(group) === committed.has(group) &&
			staged.has(group) === committed.has(group),
	);
	return same
		? { groups: committed, kind: 'declared' }
		: unreadable(`${file} has uncommitted changes to the groups it declares`);
}

/** The groups a lock's text declares, or why it does not parse. */
function declaredAt(text: string, path: string): ReadonlySet<string> | string {
	try {
		return new Set(Object.keys(parseLock(text, path).groups));
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * One membership answer per repository for a whole invocation, so every declared group reads each
 * lock once (Roger #59791). `optIn` is the manifest's declared groups (committedMembership).
 */
export function membershipReader(optIn: Iterable<string>): (root: string) => Membership {
	const groups: ReadonlySet<string> = new Set(optIn);
	const seen = new Map<string, Membership>();
	return (root) => {
		let answer = seen.get(root);
		if (answer === undefined) {
			answer = committedMembership(root, groups);
			seen.set(root, answer);
		}
		return answer;
	};
}
