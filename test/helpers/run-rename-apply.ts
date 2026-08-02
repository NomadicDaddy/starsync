import { applyArchiveRenames } from '../../src/lib/archive-rename-apply.ts';
import { previewArchiveRenames } from '../../src/lib/archive-rename.ts';

const targetPath = process.argv[2];
if (!targetPath) throw new Error('A target path is required.');

const repositoryName = process.env.TEST_REPOSITORY_NAME ?? 'repository';
const repositoryOwner = process.env.TEST_REPOSITORY_OWNER ?? 'owner';
const repositoryId = Number(process.env.TEST_REPOSITORY_ID ?? '42');
const previewOnly = process.env.TEST_PREVIEW_ONLY === '1';
const useOriginName = process.env.TEST_USE_ORIGIN_NAME === '1';

const resolver = async (_owner: string, originRepository: string) => ({
	id: useOriginName
		? [...originRepository].reduce((total, character) => total + character.charCodeAt(0), 100)
		: repositoryId,
	name: useOriginName ? originRepository : repositoryName,
	owner: repositoryOwner,
	slug: `${repositoryOwner}/${useOriginName ? originRepository : repositoryName}`,
});
const report = previewOnly
	? await previewArchiveRenames(targetPath, resolver)
	: await applyArchiveRenames(targetPath, resolver);

console.log(JSON.stringify(report));
