/**
 * `omits` in `smokestack.json`: the catalogued gates this repository leaves out of its gate, each
 * with the reason it gives (portable-gate-catalogue).
 *
 * The gate catalogue is the `gates` list of each group in smokestack's manifest. smokestack's own
 * gate reports, per repository that takes the runner, each catalogued gate that repository's full
 * qc steps do not run (scripts/check-gate-catalogue.ts there). An entry here turns that row into a
 * recorded omission: printed with its reason, never failing. It explains a catalogue row only; it
 * silences no wiring or delivery finding.
 *
 * The keys are gate ids, not script names. This file checks only the shape: whether an id names a
 * catalogued gate is smokestack's check to say, since the catalogue lives there.
 *
 * smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
 * smokestack; every repository that takes it holds a byte-identical copy.
 */
import { asText, fail } from './config-read.ts';

/** Gate id to the reason this repository gives for leaving it out. Absent is no omission. */
export function parseOmits(raw: unknown): ReadonlyMap<string, string> {
	const omits = new Map<string, string>();
	if (raw === undefined) return omits;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		fail('omits must be an object of gate id to the reason it is left out.');
	}
	for (const [id, reason] of Object.entries(raw as Record<string, unknown>)) {
		if (id.trim().length === 0) fail('omits names a gate with an empty id.');
		omits.set(id, asText(reason, `omits.${id}`));
	}
	return omits;
}
