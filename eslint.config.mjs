// Lint config for the Node-only TypeScript sources (only Node globals and plugins).

import jsPlugin from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import prettierConfigRecommended from 'eslint-plugin-prettier/recommended';
import promisePlugin from 'eslint-plugin-promise';
import unicornPlugin from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const rulesGlobalOld = {
    'no-console': ['warn', { allow: ['warn', 'error'] }],

    strict: ['error', 'global'],
    curly: 'warn',
    'prefer-template': 'error',
    'max-len': [
        'error',
        {
            tabWidth: 4,
            code: 120,
            ignoreComments: true,
            ignoreTrailingComments: true,
            ignoreTemplateLiterals: true,
            ignoreStrings: true,
            ignoreRegExpLiterals: true,
        },
    ],
    quotes: [
        'error',
        'single',
        {
            avoidEscape: true,
        },
    ],

    // require variables to be used before defined
    '@typescript-eslint/no-use-before-define': 'error',

    '@typescript-eslint/no-explicit-any': 'error',

    // Only const assertions are allowed
    '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],

    // don't require explicit return values for functions
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // might report false positives with TS
    'no-shadow': 'warn',
    '@typescript-eslint/no-shadow': 'warn',

    'import/extensions': [
        'off',
        'ignorePackages',
        {
            ts: 'never',
        },
    ],
};

const rulesGlobalNew = {
    '@typescript-eslint/consistent-type-definitions': 'off',
    semi: ['error', 'always'],
    'prettier/prettier': ['error'],
    'object-curly-spacing': ['warn', 'always'],
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-unused-vars': ['error'],
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    'prefer-template': 'off',
    'linebreak-style': 'off',
    'no-empty': 'error',
    'import/no-cycle': 'off',
    'prefer-destructuring': 'off',
    'no-underscore-dangle': 'off',
    'no-multiple-empty-lines': [
        'error',
        {
            max: 1,
            maxEOF: 1,
            maxBOF: 0,
        },
    ],
    'no-useless-return': 'off',
    'no-param-reassign': 'off',
};

const rulesTsNew = {
    // Unicorn //
    'unicorn/no-null': 'warn',
    'unicorn/filename-case': [
        'error',
        {
            cases: {
                kebabCase: false,
                pascalCase: true,
                camelCase: true,
            },
            // Folder names such as worktree-add follow the skill's kebab-case naming
            checkDirectories: false,
        },
    ],
    'unicorn/prevent-abbreviations': 'off',
    'unicorn/consistent-function-scoping': [
        'error',
        {
            checkArrowFunctions: false,
        },
    ],
    'unicorn/no-useless-undefined': [
        'error',
        {
            checkArrowFunctionBody: true,
        },
    ],
    'unicorn/no-object-as-default-parameter': 'warn',

    // Others //
    'consistent-return': 'off',
    'import/no-unresolved': 'error',
    'import/order': [
        'warn',
        {
            alphabetize: {
                caseInsensitive: true,
                order: 'asc',
            },
            groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
            'newlines-between': 'always-and-inside-groups',
            pathGroups: [
                {
                    group: 'internal',
                    pattern: 'generated/*',
                },
            ],
            pathGroupsExcludedImportTypes: ['builtin'],
        },
    ],
    'import/no-absolute-path': 'warn',
    'import/no-extraneous-dependencies': [
        'error',
        {
            peerDependencies: true,
        },
    ],
    'unicorn/prefer-global-this': 'off',
    '@typescript-eslint/consistent-indexed-object-style': 'off',
};

/** @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigFile} */
export default tseslint.config(
    // Global ignores: a config object with only `ignores` applies to every other object. The generated bundle lives
    // under plugins/
    {
        ignores: ['node_modules/**', 'docs.local/**', 'plugins/**', '.claude/**', '.codex/**'],
    },

    jsPlugin.configs.recommended,
    tseslint.configs.recommended,
    tseslint.configs.stylistic,
    promisePlugin.configs['flat/recommended'],

    // For all files //
    {
        // An eslint-disable comment can never suppress anything
        linterOptions: {
            noInlineConfig: true,
            reportUnusedDisableDirectives: 'error',
        },
        languageOptions: {
            parserOptions: {
                // For typescript-eslint, https://typescript-eslint.io/getting-started/typed-linting/
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
                parserServices: true,
                sourceType: 'module',
                ecmaVersion: '2022',
                allowImportExportEverywhere: true,
                ecmaFeatures: {
                    modules: true,
                },
            },

            globals: {
                ...globals.builtin,
                ...globals.node,
            },
        },
        settings: {
            // https://github.com/import-js/eslint-import-resolver-typescript
            'import/resolver': {
                typescript: {
                    alwaysTryTypes: true,
                },
            },
        },

        rules: {
            ...rulesGlobalOld,
            ...rulesGlobalNew,
        },
    },

    // Non-typed linting for JS files //
    {
        name: 'super-linter-non-typed',
        files: ['**/*.{js,mjs,cjs}'],
    },

    // Typed linting for TypeScript files //
    {
        name: 'super-linter-typed',
        files: ['**/*.ts'],

        extends: [
            tseslint.configs.recommendedTypeChecked,
            tseslint.configs.stylisticTypeChecked,
            importPlugin.flatConfigs.recommended,
            importPlugin.flatConfigs.typescript,
            unicornPlugin.configs.recommended,
        ],

        rules: {
            // Unicorn
            'unicorn/better-regex': 'warn',

            ...rulesTsNew,
            ...rulesGlobalOld,
            ...rulesGlobalNew,
        },
    },

    prettierConfigRecommended // Always should be the last one
);
