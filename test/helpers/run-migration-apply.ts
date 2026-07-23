import { applyArchiveMigration } from '../../src/lib/archive-migration-apply.ts';

const targetPath = process.argv[2];
if (!targetPath) throw new Error('A target path is required.');

const repositoryName = process.env.TEST_REPOSITORY_NAME ?? 'repository';
const repositoryOwner = process.env.TEST_REPOSITORY_OWNER ?? 'owner';
const repositoryId = Number(process.env.TEST_REPOSITORY_ID ?? '42');
const useOriginName = process.env.TEST_USE_ORIGIN_NAME === '1';

const report = await applyArchiveMigration(
	targetPath,
	async (_owner, originRepository) => ({
		id: useOriginName
			? [...originRepository].reduce(
					(total, character) => total + character.charCodeAt(0),
					100
				)
			: repositoryId,
		name: useOriginName ? originRepository : repositoryName,
		owner: repositoryOwner,
		slug: `${repositoryOwner}/${useOriginName ? originRepository : repositoryName}`,
	}),
	{ id: 7, login: 'archive-owner' }
);

console.log(JSON.stringify(report));
