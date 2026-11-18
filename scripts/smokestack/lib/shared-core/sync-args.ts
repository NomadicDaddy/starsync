/**
 * The arguments `bun run shared-core:sync` and `shared-core:write` take, and the help text that
 * names them. Kept apart from sync-shared-core.ts so that file stays within its line limit once
 * it gained an in-process entry (runSharedCoreCli, test-suite-lanes-stage-two).
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { parseArgs } from 'node:util';

export const USAGE = `sync-shared-core — sync the files this fleet shares between peer repositories.

  --check                 In the owner: compare every group's targets against it and report. In
                          any other repository: check this repository against its own
                          smokestack.lock, and nothing else. Read-only. The flags below this one
                          belong to the owner and are refused elsewhere.
  --write                 Deliver and replace the files --check reports as absent or drifted, for
                          the groups this repository owns. Refuses to overwrite uncommitted work.
                          Made only from the annotated tag of this repository's version, with no
                          tracked file modified. Rewrites the smokestack.lock of each target that
                          has one, once every group that target takes is delivered. Refused while
                          frozen-targets.json is missing, names anything and --only is absent, or
                          --only names a frozen target.
  --dry-run               With --write: run every refusal and report what would be written. Off a
                          tag it warns and goes on.
  --group <name>          Restrict to one manifest group. Repeatable; a subsystem whose files span
                          more than one group is named one group per flag.
  --only <csv>            Restrict to the named target directories. Narrows what the group's target
                          model already resolved; it can never add a target the model rejected.
  --retire <name>         With --write: a group a target's lock declares and no longer takes, and
                          the record has forgotten there, leaves it. Its files are removed where
                          they are exactly as delivered, and the lock drops it. Repeatable.
  --fleet-root <dir>      Directory holding the peer repositories. Defaults to SMOKESTACK_FLEET_ROOT
                          when set, else the parent of this repository's main checkout (from a
                          branch worktree, not the worktree's own parent). Its untracked
                          .shared-core-roots.json names the other repo-holding roots this does not
                          sweep, each with its reason.
  --help                  This text.

--check and --write are exclusive. Neither is the default; with no mode this script does nothing.
`;

/**
 * Unknown flags are rejected rather than ignored. The license sync script this generalized tested
 * only for the presence of --check: every other argument — including --help, and including a
 * typo — falls through to the write path and performs a real four-repository write. That is a trap
 * laid for exactly the person trying to find out what the script does, and it is not carried here.
 */
export interface SharedCoreOptions {
	check: boolean;
	dryRun: boolean;
	fleetRoot?: string;
	groups: string[];
	help: boolean;
	only?: Set<string>;
	retire: Set<string>;
	write: boolean;
}

export function parseSharedCoreArgs(args: string[]): SharedCoreOptions {
	const { values } = parseArgs({
		args,
		options: {
			check: { type: 'boolean' },
			'dry-run': { type: 'boolean' },
			'fleet-root': { type: 'string' },
			group: { multiple: true, type: 'string' },
			help: { short: 'h', type: 'boolean' },
			only: { multiple: true, type: 'string' },
			retire: { multiple: true, type: 'string' },
			write: { type: 'boolean' },
		},
		strict: true,
	});
	// parseArgs takes the token after a value-taking flag as its value even when that token is
	// itself a flag, so `--group --check` would name a group nothing matches and quietly run zero
	// groups against a fleet the caller believed it had just checked.
	for (const [name, value] of Object.entries(values)) {
		const given = Array.isArray(value) ? value : [value];
		if (given.some((v) => typeof v === 'string' && (v.trim() === '' || v.startsWith('-')))) {
			throw new Error(`--${name} needs a value.`);
		}
	}
	const parsed: SharedCoreOptions = {
		check: values.check === true,
		dryRun: values['dry-run'] === true,
		groups: values.group ?? [],
		help: values.help === true,
		retire: new Set(values.retire ?? []),
		write: values.write === true,
	};
	if (values['fleet-root'] !== undefined) parsed.fleetRoot = values['fleet-root'];
	if (values.only !== undefined) {
		parsed.only = new Set(values.only.flatMap((v) => v.split(',').map((s) => s.trim())));
	}
	// Exclusive rather than "write wins" or "check wins": both readings are defensible, which is
	// precisely why neither should be guessed on a command that overwrites files in other people's
	// repositories.
	if (parsed.check && parsed.write) {
		throw new Error('--check and --write are exclusive. Pick one.');
	}
	if (parsed.dryRun && !parsed.write) {
		throw new Error('--dry-run only means anything with --write.');
	}
	if (parsed.retire.size > 0 && !parsed.write) {
		throw new Error('--retire only means anything with --write.');
	}
	return parsed;
}
