/**
 * The clean-run verdict for `--check`.
 *
 * `check:shared-core` reads sibling checkouts rather than this tree, so "no drift" and "nothing was
 * compared" are different results that used to print the same `[OK]`. Both zero cases are real:
 *
 * - **No peer is checked out.** CI clones one repository, and a developer may hold only one. There
 *   is genuinely nothing to compare, which `docs/reference/gate-conventions.md` covers as `[SKIP]`
 *   with the reason, exit 0.
 * - **`--only` matched nothing.** That flag narrows the target directories a group's model already
 *   resolved, so a name that matches none of them silences every group at once. A typo there
 *   produced a green gate over zero targets, which is exactly the presence-over-content failure
 *   this gate exists to catch, reproduced in the gate itself.
 *
 * The two are told apart by whether `--only` was passed at all, because that is the only thing that
 * distinguishes "there was nothing to look at" from "you asked to look at nothing".
 */

import { type GroupReport } from './check.ts';

export function reportClean(reports: GroupReport[], only?: Set<string>): number {
	const targets = reports.reduce((total, report) => total + report.targets, 0);
	const files = reports.reduce((total, report) => total + report.matched, 0);

	if (targets === 0 && only !== undefined) {
		console.error(
			`[FAIL] --only ${[...only].join(',')} matched no target in any group, so nothing was ` +
				'compared. --only narrows the directories a group already resolved; it takes ' +
				'repository directory names, not group names (use --group for those).',
		);
		return 1;
	}

	if (targets === 0) {
		console.log(
			'[SKIP] Shared core: no peer repository is checked out beside this one, so there is ' +
				'nothing to compare against.',
		);
		return 0;
	}

	console.log(
		`[OK] Shared core: no drift (${files} file(s) across ${targets} target(s) examined).`,
	);
	return 0;
}
