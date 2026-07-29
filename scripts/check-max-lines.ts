import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const MAX_COMPLEXITY = 10;
const MAX_FILE_LINES = 300;
const MAX_FUNCTION_LINES = 40;
const MAX_NESTING_DEPTH = 3;

const EXTRACTED_MODULES = new Set([
	'src/lib/archive-api-dates.ts',
	'src/lib/archive-api-migration.ts',
	'src/lib/archive-api-reporting.ts',
	'src/lib/archive-api-sync-planning.ts',
	'src/lib/archive-api-sync.ts',
	'src/lib/archive-api-verification.ts',
	'src/lib/archive-api.ts',
	'src/lib/archive-migration-classification.ts',
	'src/lib/archive-migration-inspection.ts',
	'src/lib/archive-migration-resolution.ts',
	'src/lib/archive-migration.ts',
	'src/lib/archive-verification-checkout.ts',
	'src/lib/archive-verification-duplicates.ts',
	'src/lib/archive-verification-reporting.ts',
	'src/lib/archive-verification.ts',
	'src/lib/dates-command.ts',
	'src/lib/dates-discovery.ts',
	'src/lib/dates-reporting.ts',
	'src/lib/refresh-clone.ts',
	'src/lib/refresh-existing.ts',
	'src/lib/refresh-pool.ts',
	'src/lib/refresh.ts',
]);

const EXCLUDED_PATHS = [
	/(?:^|\/)(?:generated|schema|test|tests)(?:\/|$)/,
	/\.config\.ts$/,
	/\.d\.ts$/,
	/\.test\.ts$/,
];

interface FunctionMetrics {
	complexity: number;
	lines: number;
	maxNesting: number;
	name: string;
	startLine: number;
}

interface Violation {
	message: string;
	path: string;
}

type FunctionNode =
	| ts.ArrowFunction
	| ts.ConstructorDeclaration
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.GetAccessorDeclaration
	| ts.MethodDeclaration
	| ts.SetAccessorDeclaration;

const normalizePath = (filePath: string): string => filePath.replaceAll('\\', '/');

const isExcluded = (filePath: string): boolean =>
	EXCLUDED_PATHS.some((pattern) => pattern.test(filePath));

const isFunctionNode = (node: ts.Node): node is FunctionNode =>
	ts.isArrowFunction(node) ||
	ts.isConstructorDeclaration(node) ||
	ts.isFunctionDeclaration(node) ||
	ts.isFunctionExpression(node) ||
	ts.isGetAccessorDeclaration(node) ||
	ts.isMethodDeclaration(node) ||
	ts.isSetAccessorDeclaration(node);

const functionName = (node: FunctionNode): string => {
	if ('name' in node && node.name) return node.name.getText();
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
		return parent.name.getText();
	}
	return '<anonymous>';
};

const isDecision = (node: ts.Node): boolean =>
	ts.isIfStatement(node) ||
	ts.isForStatement(node) ||
	ts.isForInStatement(node) ||
	ts.isForOfStatement(node) ||
	ts.isWhileStatement(node) ||
	ts.isDoStatement(node) ||
	ts.isCaseClause(node) ||
	ts.isCatchClause(node) ||
	ts.isConditionalExpression(node) ||
	(ts.isBinaryExpression(node) &&
		[
			ts.SyntaxKind.AmpersandAmpersandToken,
			ts.SyntaxKind.BarBarToken,
			ts.SyntaxKind.QuestionQuestionToken,
		].includes(node.operatorToken.kind));

const addsNesting = (node: ts.Node): boolean =>
	ts.isIfStatement(node) ||
	ts.isForStatement(node) ||
	ts.isForInStatement(node) ||
	ts.isForOfStatement(node) ||
	ts.isWhileStatement(node) ||
	ts.isDoStatement(node) ||
	ts.isSwitchStatement(node) ||
	ts.isCatchClause(node) ||
	ts.isConditionalExpression(node);

const countTokenLines = (node: FunctionNode, sourceFile: ts.SourceFile): number => {
	const start = node.getStart(sourceFile);
	const scanner = ts.createScanner(
		ts.ScriptTarget.ES2022,
		true,
		ts.LanguageVariant.Standard,
		node.getText(sourceFile)
	);
	const lines = new Set<number>();
	while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
		const position = start + scanner.getTokenPos();
		lines.add(sourceFile.getLineAndCharacterOfPosition(position).line);
	}
	return lines.size;
};

const analyzeFunction = (node: FunctionNode, sourceFile: ts.SourceFile): FunctionMetrics => {
	let complexity = 1;
	let maxNesting = 0;
	const visit = (current: ts.Node, nesting: number): void => {
		if (current !== node && isFunctionNode(current)) return;
		if (current !== node && isDecision(current)) complexity++;
		const nextNesting = current !== node && addsNesting(current) ? nesting + 1 : nesting;
		maxNesting = Math.max(maxNesting, nextNesting);
		current.forEachChild((child) => visit(child, nextNesting));
	};
	visit(node, 0);
	return {
		complexity,
		lines: countTokenLines(node, sourceFile),
		maxNesting,
		name: functionName(node),
		startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
	};
};

const inspectFunctions = (filePath: string, sourceFile: ts.SourceFile): Violation[] => {
	const violations: Violation[] = [];
	const visit = (node: ts.Node): void => {
		if (isFunctionNode(node)) {
			const metrics = analyzeFunction(node, sourceFile);
			const prefix = `${metrics.name} at line ${metrics.startLine}`;
			if (metrics.complexity > MAX_COMPLEXITY) {
				violations.push({
					message: `${prefix} has complexity ${metrics.complexity} (maximum ${MAX_COMPLEXITY})`,
					path: filePath,
				});
			}
			if (metrics.lines > MAX_FUNCTION_LINES) {
				violations.push({
					message: `${prefix} has ${metrics.lines} non-comment lines (maximum ${MAX_FUNCTION_LINES})`,
					path: filePath,
				});
			}
			if (metrics.maxNesting > MAX_NESTING_DEPTH) {
				violations.push({
					message: `${prefix} has nesting depth ${metrics.maxNesting} (maximum ${MAX_NESTING_DEPTH})`,
					path: filePath,
				});
			}
		}
		node.forEachChild(visit);
	};
	visit(sourceFile);
	return violations;
};

const inspectFile = (filePath: string): Violation[] => {
	const source = fs.readFileSync(filePath, 'utf-8');
	const lines = source.length === 0 ? 0 : source.replace(/\r?\n$/, '').split(/\r?\n/).length;
	const violations =
		lines > MAX_FILE_LINES
			? [
					{
						message: `has ${lines} lines (maximum ${MAX_FILE_LINES})`,
						path: filePath,
					},
				]
			: [];
	if (!EXTRACTED_MODULES.has(filePath)) return violations;
	const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true);
	return [...violations, ...inspectFunctions(filePath, sourceFile)];
};

const sourceFiles = [...new Bun.Glob('**/*.ts').scanSync({ cwd: 'src' })]
	.map((filePath) => normalizePath(path.join('src', filePath)))
	.filter((filePath) => !isExcluded(filePath))
	.sort((left, right) => left.localeCompare(right));
const violations = sourceFiles.flatMap(inspectFile);

if (violations.length > 0) {
	console.error('Source-shape violations:');
	for (const violation of violations) {
		console.error(`- ${violation.path}: ${violation.message}`);
	}
	process.exitCode = 1;
} else {
	console.log(`Source-shape check passed for ${sourceFiles.length} production TypeScript files.`);
}
