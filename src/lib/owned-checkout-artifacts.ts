import fs from 'node:fs';
import path from 'node:path';

import type { HeldArchiveLock } from './archive-lock.ts';
import type { Finding } from './reporting.ts';

import {
	listReplacementRecordBackups,
	readReplacementRecord,
	removeReplacementRecord,
} from './checkout-replacement-record.ts';
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

// A replaced checkout's backup is deleted only when its replacement record says the fresh
// checkout was published. Without that, including every backup an older StarSync left, it may be
// the only copy of the checkout, so it stays and is reported.
const keptBackupFinding = (backup: string, original: null | string): Finding =>
	createFinding(
		'warning',
		'owned-checkout-backup-kept',
		`StarSync kept the replaced checkout at ${backup}${
			original === null ? '' : ` (previously ${original})`
		} because it can't confirm that replacement finished. It may be the only copy of that checkout, with its local changes and history. Inspect it, then move it back or delete it yourself.`,
	);

const removeArtifact = (
	targetPath: string,
	name: string,
	kind: OwnedCheckoutArtifactKind,
	onProgress?: (message: string) => void,
): Finding => {
	onProgress?.(`Removing abandoned ${kind} — ${name}`);
	try {
		fs.rmSync(path.join(targetPath, name), { force: true, recursive: true });
		if (kind === 'damaged backup') removeReplacementRecord(targetPath, name);
		return createFinding(
			'info',
			'owned-checkout-artifact-removed',
			`Abandoned StarSync ${kind} ${name} was permanently removed.`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return createFinding(
			'warning',
			'owned-checkout-artifact-remove-failed',
			`Cannot remove abandoned StarSync ${kind} ${name}: ${sanitizeMessage(message)}`,
		);
	}
};

const cleanupArtifact = (
	targetPath: string,
	name: string,
	kind: OwnedCheckoutArtifactKind,
	onProgress?: (message: string) => void,
): Finding => {
	if (kind === 'damaged backup') {
		const record = readReplacementRecord(targetPath, name);
		if (record?.state !== 'published') return keptBackupFinding(name, record?.original ?? null);
	}
	return removeArtifact(targetPath, name, kind, onProgress);
};

// A record whose backup is gone protects nothing; a failure here is retried on the next pass.
const dropStaleReplacementRecords = (targetPath: string): void => {
	for (const backup of listReplacementRecordBackups(targetPath)) {
		if (fs.existsSync(path.join(targetPath, backup))) continue;
		try {
			removeReplacementRecord(targetPath, backup);
		} catch {
			continue;
		}
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
	for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
		const kind = entry.isDirectory() ? ownedCheckoutArtifactKind(entry.name) : null;
		if (kind !== null) findings.push(cleanupArtifact(targetPath, entry.name, kind, onProgress));
	}
	dropStaleReplacementRecords(targetPath);
	return findings;
};
