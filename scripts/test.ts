import path from 'node:path';

const testRoot = path.resolve(import.meta.dir, '..', 'test');
const mockedUnitTest = path.join(testRoot, 'index.test.ts');
const testFiles = [...new Bun.Glob('**/*.test.ts').scanSync({ absolute: true, cwd: testRoot })];
const processBoundaryTests = testFiles
	.filter((testFile) => testFile !== mockedUnitTest)
	.sort((left, right) => left.localeCompare(right));

for (const suite of [[mockedUnitTest], processBoundaryTests]) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, 'test', ...suite],
		stderr: 'inherit',
		stdout: 'inherit',
	});
	if (result.exitCode !== 0) process.exit(result.exitCode);
}
