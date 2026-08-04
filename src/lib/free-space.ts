import fs from 'node:fs';
import path from 'node:path';

import type { Finding } from './reporting.ts';

import { createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

export const DEFAULT_MIN_FREE_SPACE_BYTES = 1024 ** 3;

const UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
	B: 1,
	GB: 1024 ** 3,
	GIB: 1024 ** 3,
	KB: 1024,
	KIB: 1024,
	MB: 1024 ** 2,
	MIB: 1024 ** 2,
	TB: 1024 ** 4,
	TIB: 1024 ** 4,
};

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const FREE_SPACE_PATTERN = /^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i;

const invalidFreeSpace = (value: string): Error =>
	new Error(
		'Free space minimum must be a byte count with an optional B, KB, MB, GB, or TB suffix ' +
			'(binary multiples; KiB, MiB, GiB, TiB also accepted), got: ' +
			`${value}`,
	);

/**
 * Reads a free-space minimum written the way an operator thinks about disks.
 *
 * Suffixes are binary, so `1GB` and `1GiB` both mean 1073741824 bytes. A bare
 * number is a byte count and must be whole; only a suffixed value may carry a
 * fraction, which rounds down to whole bytes.
 */
export const parseFreeSpaceBytes = (value: string): number => {
	const match = FREE_SPACE_PATTERN.exec(value.trim());
	const amount = match?.[1];
	if (amount === undefined) throw invalidFreeSpace(value);
	const unit = match?.[2]?.toUpperCase();
	const multiplier = unit === undefined ? 1 : UNIT_MULTIPLIERS[unit];
	if (multiplier === undefined) throw invalidFreeSpace(value);
	const bytes = Math.floor(Number(amount) * multiplier);
	if (!Number.isSafeInteger(bytes)) throw invalidFreeSpace(value);
	if (unit === undefined && !Number.isInteger(Number(amount))) throw invalidFreeSpace(value);
	return bytes;
};

export const formatByteSize = (bytes: number): string => {
	let amount = bytes;
	let index = 0;
	while (amount >= 1024 && index < SIZE_UNITS.length - 1) {
		amount /= 1024;
		index += 1;
	}
	const unit = SIZE_UNITS[index] ?? 'B';
	return index === 0 ? `${amount} ${unit}` : `${amount.toFixed(1)} ${unit}`;
};

/**
 * The nearest existing ancestor of a target path, so free space can be measured
 * before the target directory itself exists. A not-yet-created target lives on the
 * same filesystem as its parent, so the ancestor's measurement is the target's; the
 * target itself is the first candidate when it already exists.
 */
const resolveMeasurementPath = (targetPath: string): string => {
	let candidate = targetPath;
	while (!fs.existsSync(candidate)) {
		const parent = path.dirname(candidate);
		if (parent === candidate) break;
		candidate = parent;
	}
	return candidate;
};

/**
 * Reports the bytes the current account may still write to the filesystem that
 * holds the path, which is what a clone actually gets rather than the raw free
 * total a privileged account would see. A target that does not yet exist is
 * measured at its nearest existing ancestor, since both share one filesystem.
 */
export const measureAvailableSpace = (targetPath: string): number => {
	const stats = fs.statfsSync(resolveMeasurementPath(targetPath));
	return stats.bavail * stats.bsize;
};

/**
 * Reads a caller-supplied minimum, defaulting it and rejecting a value that is not
 * a whole count of bytes. Returned as a finding rather than thrown, because every
 * caller reports an invalid option as a usage error rather than a crash.
 */
export const resolveMinFreeSpace = (value: number | undefined): Finding | number => {
	const minFreeSpace = value ?? DEFAULT_MIN_FREE_SPACE_BYTES;
	if (!Number.isSafeInteger(minFreeSpace) || minFreeSpace < 0) {
		return createFinding(
			'error',
			'invalid-min-free-space',
			'minFreeSpace must be a whole number of bytes that is zero or greater.',
		);
	}
	return minFreeSpace;
};

/**
 * Measures the archive filesystem against the configured floor.
 *
 * `shortfallSeverity` is the caller's: work that writes nothing reports a shortfall
 * as a warning, because the operator still needs to see what a real run would hit,
 * while work that is about to clone treats it as a refusal. A minimum of zero turns
 * the check off, and an unmeasurable filesystem is reported rather than treated as
 * empty or as full.
 */
export const checkFreeSpace = (
	targetPath: string,
	minFreeSpace: number,
	shortfallSeverity: 'error' | 'warning',
	purpose: string,
): Finding | null => {
	if (minFreeSpace === 0) return null;
	let available: number;
	try {
		available = measureAvailableSpace(targetPath);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return createFinding(
			'warning',
			'free-space-unknown',
			`Cannot measure free space at the archive target: ${sanitizeMessage(reason)}`,
		);
	}
	if (available >= minFreeSpace) return null;
	return createFinding(
		shortfallSeverity,
		'insufficient-free-space',
		`Free space at the archive target is ${formatByteSize(available)}, below the ` +
			`${formatByteSize(minFreeSpace)} minimum required to ${purpose}.`,
	);
};
