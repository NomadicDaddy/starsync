import fs from 'node:fs';
import path from 'node:path';

import type { HeldArchiveLock } from './archive-lock.ts';
import type { Finding } from './reporting.ts';

import { createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

export const DAMAGED_CHECKOUT_PREFIX = '.starsync-damaged-';
export const STAGED_CHECKOUT_PREFIX = '.starsync-checkout-';

type OwnedCheckoutArtifactKind = 'damaged backup' | 'staging checkout';

const DAMAGED_CHECKOUT_PATTERN =
	/^\.starsync-damaged-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGED_CHECKOUT_PATTERN = /^\.starsync-checkout-[a-z0-9]{6}$/i;

const ownedCheckoutArtifactKind = (name: string): null | OwnedCheckoutArtifactKind => {
	if (DAMAGED_CHECKOUT_PATTERN.test(name)) return 'damaged backup';
	if (STAGED_CHECKOUT_PATTERN.test(name)) return 'staging checkout';
	return null;
};

export const isOwnedCheckoutArtifactName = (name: string): boolean =>
	ownedCheckoutArtifactKind(name) !== null;

export const isOwnedStagingCheckoutName = (name: string): boolean =>
	STAGED_CHECKOUT_PATTERN.test(name);

const assertArchiveLockHeld = (targetPath: string, held: HeldArchiveLock): void => {
	const expectedLockPath = path.join(
		path.resolve(targetPath),
		'.starsync',
		'operation-lock.json',
	);
	if (path.resolve(held.lockPath) !== expectedLockPath) {
		throw new Error('Refusing owned checkout cleanup without this archive operation lock.');
	}
	const lockStats = fs.lstatSync(held.lockPath);
	if (
		!lockStats.isFile() ||
		lockStats.isSymbolicLink() ||
		fs.readFileSync(held.lockPath, 'utf8') !== held.raw
	) {
		throw new Error('Refusing owned checkout cleanup after archive lock ownership changed.');
	}
};

export const cleanupOwnedCheckoutArtifacts = (
	targetPath: string,
	held: HeldArchiveLock | null,
	onProgress?: (message: string) => void,
): Finding[] => {
	if (held === null) {
		throw new Error('Refusing owned checkout cleanup without an archive operation lock.');
	}
	assertArchiveLockHeld(targetPath, held);
	const findings: Finding[] = [];
	const entries = fs.readdirSync(targetPath, { withFileTypes: true });
	for (const entry of entries) {
		const kind = entry.isDirectory() ? ownedCheckoutArtifactKind(entry.name) : null;
		if (kind === null) continue;
		onProgress?.(`Removing abandoned ${kind} — ${entry.name}`);
		try {
			fs.rmSync(path.join(targetPath, entry.name), { force: true, recursive: true });
			findings.push(
				createFinding(
					'info',
					'owned-checkout-artifact-removed',
					`Abandoned StarSync ${kind} ${entry.name} was permanently removed.`,
				),
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			findings.push(
				createFinding(
					'warning',
					'owned-checkout-artifact-remove-failed',
					`Cannot remove abandoned StarSync ${kind} ${entry.name}: ${sanitizeMessage(message)}`,
				),
			);
		}
	}
	return findings;
};
