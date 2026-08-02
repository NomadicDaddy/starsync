import { spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedRepository } from '../../src/lib/repository-resolution.ts';

import { readArchiveConfig } from '../../src/lib/archive-config.ts';
import { acquireArchiveLock, releaseArchiveLock } from '../../src/lib/archive-lock.ts';
import { verifyArchive } from '../../src/lib/archive-verification.ts';
import {
	cleanupOwnedCheckoutArtifacts,
	DAMAGED_CHECKOUT_PREFIX,
} from '../../src/lib/owned-checkout-artifacts.ts';

const targetPath = process.argv[2];
if (!targetPath) throw new Error('A target path is required.');

const rawRepository = process.env.TEST_RESOLVED_REPOSITORY;
if (!rawRepository) throw new Error('TEST_RESOLVED_REPOSITORY is required.');
const repository = JSON.parse(rawRepository) as ResolvedRepository;

const actualRemove = fs.rmSync;
const removeSpy =
	process.env.TEST_FAIL_DAMAGED_CLEANUP === '1'
		? spyOn(fs, 'rmSync').mockImplementation((entryPath, options) => {
				if (
					path
						.basename(path.resolve(String(entryPath)))
						.startsWith(DAMAGED_CHECKOUT_PREFIX)
				) {
					throw new Error('Injected damaged-backup cleanup failure.');
				}
				return actualRemove(entryPath, options);
			})
		: null;
const acquisition = acquireArchiveLock(targetPath, 'verify');
if (!acquisition.ok) throw new Error(acquisition.message);
let releaseError: null | string = null;

const output = await (async (): Promise<string> => {
	try {
		const cleanupFindings = cleanupOwnedCheckoutArtifacts(targetPath, acquisition.held);
		const result = await verifyArchive(targetPath, {
			repair: {
				archiveOwnerId: readArchiveConfig(targetPath).owner.id,
				resolveRepository: async (owner, name) => {
					if (
						owner.toLowerCase() !== repository.owner.toLowerCase() ||
						name.toLowerCase() !== repository.name.toLowerCase()
					) {
						throw new Error('Repository not found.');
					}
					return repository;
				},
				targetPath,
			},
		});
		return JSON.stringify({ ...result, findings: [...result.findings, ...cleanupFindings] });
	} finally {
		const released = releaseArchiveLock(acquisition.held);
		removeSpy?.mockRestore();
		if (!released.ok) releaseError = released.message;
	}
})();
if (releaseError !== null) throw new Error(releaseError);
console.log(output);
