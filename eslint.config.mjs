import typescriptEslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['**/*.ts'],
    languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { '@typescript-eslint': typescriptEslint },
    rules: {
      curly: 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-throw-literal': 'error',
      '@typescript-eslint/naming-convention': [
        'warn',
        { selector: 'import', format: ['camelCase', 'PascalCase'] }
      ]
    }
  }
];
