import type { ResolvedRepository } from '../../src/lib/archive-migration.ts';

import { readArchiveConfig } from '../../src/lib/archive-config.ts';
import { verifyArchive } from '../../src/lib/archive-verification.ts';

const targetPath = process.argv[2];
if (!targetPath) throw new Error('A target path is required.');

const rawRepository = process.env.TEST_RESOLVED_REPOSITORY;
if (!rawRepository) throw new Error('TEST_RESOLVED_REPOSITORY is required.');
const repository = JSON.parse(rawRepository) as ResolvedRepository;

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

console.log(JSON.stringify(result));
