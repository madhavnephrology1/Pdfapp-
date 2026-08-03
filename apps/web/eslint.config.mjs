import next from 'eslint-config-next';

const config = [
  ...next,
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'tests/e2e/**'],
  },
  {
    rules: {
      // The reader's own text is never dangerous HTML; the only use is the
      // theme bootstrap script, which is a fixed string in this repo.
      'react/no-danger': 'off',
    },
  },
];

export default config;
