import js from '@eslint/js';
import perfectionist from 'eslint-plugin-perfectionist';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// eslint-disable-next-line import/no-default-export
export default tseslint.config([
	{
		ignores: [
			'dist',
			'dev-dist',
			'eslint.config.js',
			'vite.config.ts',
			'node_modules',
			'src/types/*.d.ts',
		],
	},
	{
		extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
		files: ['**/*.{ts,tsx}'],
		languageOptions: {
			ecmaVersion: 2020,
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				project: ['./tsconfig.json'],
				tsconfigRootDir: __dirname,
			},
		},
		plugins: {
			import: noDefaultExportPlugin,
			'react-hooks': reactHooks,
			'react-refresh': reactRefresh,
			perfectionist,
		},
		rules: {
			...reactHooks.configs.recommended.rules,

			'@typescript-eslint/array-type': ['error', { default: 'array' }],
			'@typescript-eslint/ban-ts-comment': 'error',
			'@typescript-eslint/consistent-type-imports': [
				'warn',
				{ fixStyle: 'inline-type-imports', prefer: 'type-imports' },
			],
			'@typescript-eslint/no-explicit-any': 'error',

			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],

			'@typescript-eslint/require-await': 'off',
			'@typescript-eslint/unbound-method': 'off',
			'@typescript-eslint/no-floating-promises': 'warn',
			'@typescript-eslint/no-misused-promises': 'warn',

			eqeqeq: ['error', 'always'],
			'import/no-default-export': 'error',
			'no-console': ['error', { allow: ['debug', 'info', 'warn', 'error'] }],
			'prefer-const': 'error',

			'react-hooks/rules-of-hooks': 'warn',
			'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

			'perfectionist/sort-enums': [
				'warn',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-exports': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-imports': [
				'error',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-interfaces': [
				'warn',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-jsx-props': [
				'warn',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-objects': [
				'warn',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-object-types': [
				'warn',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'perfectionist/sort-switch-case': ['warn', { order: 'asc', type: 'alphabetical' }],
			'perfectionist/sort-union-types': [
				'warn',
				{ ignoreCase: false, order: 'asc', type: 'alphabetical' },
			],
			'sort-keys': 'off',
		},
	},
	{
		files: ['src/hooks/*.{ts,tsx}'],
		rules: {
			'react-refresh/only-export-components': 'off',
		},
	},
	{
		files: ['src/components/ui/**/*.{ts,tsx}'],
		rules: {
			'react-refresh/only-export-components': 'off',
		},
	},
]);
