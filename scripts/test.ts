import path from 'node:path';

const testRoot = path.resolve(import.meta.dir, '..', 'test');
const mockedUnitTest = path.join(testRoot, 'index.test.ts');
const testFiles = [...new Bun.Glob('**/*.test.ts').scanSync({ absolute: true, cwd: testRoot })];
const processBoundaryTests = testFiles
	.filter((testFile) => testFile !== mockedUnitTest)
	.sort((left, right) => left.localeCompare(right));

// The process-boundary suite drives real Git through real subprocesses, and the windows-latest
// runner spends roughly eight times what ubuntu does on identical work — 5.9s against 0.7s for
// one measured case. Bun's 5000ms default is inside that spread, so tests that are nowhere near
// hanging fail the release gate one at a time: two different ones did so on two consecutive
// pushes to main. Raising the budget once for the whole suite fixes the class rather than the
// instance, and 30s still catches a genuine hang. Individual tests may state a tighter budget.
//
// The mocked unit suite keeps the default, because nothing in it waits on a process.
const suites = [
	{ args: [], files: [mockedUnitTest] },
	{ args: ['--timeout', '30000'], files: processBoundaryTests },
];

for (const suite of suites) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, 'test', ...suite.args, ...suite.files],
		stderr: 'inherit',
		stdout: 'inherit',
	});
	if (result.exitCode !== 0) process.exit(result.exitCode);
}
