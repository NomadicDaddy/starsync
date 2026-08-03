import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import perfectionist from 'eslint-plugin-perfectionist';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const noDefaultExportPlugin = {
	rules: {
		'no-default-export': {
			create(context) {
				return {
					ExportDefaultDeclaration(node) {
						context.report({ message: 'Prefer named exports.', node });
					},
				};
			},
			meta: { schema: [], type: 'suggestion' },
		},
	},
};

export default defineConfig([
	{
		ignores: ['**/*.min.js', '**/dist/**', '**/node_modules/**', '**/starred_repos/**'],
	},
	{
		extends: [js.configs.recommended],
		files: ['eslint.config.js'],
		languageOptions: {
			ecmaVersion: 2022,
			globals: globals.node,
			sourceType: 'module',
		},
	},
	{
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		files: ['**/*.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			globals: {
				...globals.node,
				...globals.bun,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
			sourceType: 'module',
		},
		plugins: {
			import: noDefaultExportPlugin,
			perfectionist,
			'unused-imports': unusedImports,
		},
		rules: {
			'@typescript-eslint/array-type': ['error', { default: 'array' }],
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{ fixStyle: 'inline-type-imports', prefer: 'type-imports' },
			],
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/unbound-method': 'error',
			eqeqeq: ['error', 'always'],
			'import/no-default-export': 'error',
			'no-console': 'off',
			'no-restricted-syntax': [
				'error',
				{
					message: "Catch variable must be named 'err' for consistency.",
					selector: "CatchClause > Identifier[name!='err']",
				},
			],
			'no-useless-rename': 'error',
			'object-shorthand': ['error', 'always'],
			'perfectionist/sort-array-includes': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-enums': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-exports': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-heritage-clauses': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-imports': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-interfaces': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-intersection-types': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-maps': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-named-exports': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-named-imports': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-object-types': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-objects': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-sets': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-switch-case': ['error', { order: 'asc', type: 'alphabetical' }],
			'perfectionist/sort-union-types': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'prefer-const': 'error',
			'prefer-template': 'error',
			'sort-imports': 'off',
			'sort-keys': 'off',
			'unused-imports/no-unused-imports': 'error',
			'unused-imports/no-unused-vars': [
				'warn',
				{
					args: 'after-used',
					argsIgnorePattern: '^_',
					vars: 'all',
					varsIgnorePattern: '^_',
				},
			],
		},
	},
]);
