import type { RepoRecord } from '../../src/lib/refresh.ts';

import { processRepository } from '../../src/lib/refresh.ts';

const targetPath = process.argv[2];
if (!targetPath) throw new Error('A target path is required.');

const rawRepository = process.env.TEST_REPOSITORY;
if (!rawRepository) throw new Error('TEST_REPOSITORY is required.');

const repository = JSON.parse(rawRepository) as RepoRecord;
const archiveOwnerId = Number(process.env.TEST_ARCHIVE_OWNER_ID ?? '7');
const result = await processRepository(repository, targetPath, () => false, {
	archiveOwnerId,
});

console.log(JSON.stringify(result));
