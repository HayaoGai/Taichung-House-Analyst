import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname( fileURLToPath( import.meta.url ) )
const projectRoot = resolve( __dirname, '../..' )

export default [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
        // Quasar router 用到 process.env（建置時被取代）；Worker 端的 setTimeout 等亦涵蓋於此
        ...globals.node,
      },
      parserOptions: {
        tsconfigRootDir: projectRoot,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs[ 'flat/recommended' ],
  {
    files: [ '**/*.vue' ],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        tsconfigRootDir: projectRoot,
      },
    },
  },
  {
    files: [ '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.vue' ],
    rules: {
      'vue/multi-word-component-names': 'off',

      // ─── Spacing ──────────────────────────────────────────────
      'array-bracket-spacing': [ 'error', 'always' ],
      'arrow-spacing': 'error',
      'comma-spacing': 'error',
      'space-in-parens': [ 'error', 'always' ],
      'key-spacing': 'error',
      'computed-property-spacing': [ 'error', 'always' ],
      'space-infix-ops': 'error',
      'keyword-spacing': 'error',
      'object-curly-spacing': [ 'error', 'always' ],
      'brace-style': 'error',
      'no-trailing-spaces': 'error',
      'no-multi-spaces': 'error',
      'space-before-function-paren': 'error',
      'space-before-blocks': [ 'error', 'always' ],
      'template-curly-spacing': [ 'error', 'always' ],
      'indent': [ 'error', 2, { SwitchCase: 1 } ],

      // ─── TypeScript ───────────────────────────────────────────
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/consistent-type-imports': [ 'error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' } ],

      // ─── Vue Block Order ──────────────────────────────────────
      'vue/block-order': [ 'error', { order: [ 'script', 'template', 'style' ] } ],

      // ─── Vue HTML ─────────────────────────────────────────────
      'vue/html-indent': 'error',
      'vue/first-attribute-linebreak': 'error',
      'vue/max-attributes-per-line': [
        'error',
        {
          singleline: { max: 3 },
          multiline: { max: 2 },
        },
      ],
      'vue/html-closing-bracket-newline': 'error',
      'vue/multiline-html-element-content-newline': 'error',
      'vue/html-self-closing': 'error',
      'vue/html-closing-bracket-spacing': 'error',
      'vue/array-bracket-spacing': [ 'error', 'always' ],
      'vue/arrow-spacing': 'error',
      'vue/comma-spacing': 'error',
      'vue/space-in-parens': [ 'error', 'always' ],
      'vue/key-spacing': 'error',
      'vue/space-infix-ops': 'error',
      'vue/keyword-spacing': 'error',
      'vue/object-curly-spacing': [ 'error', 'always' ],
      'vue/template-curly-spacing': [ 'error', 'always' ],
    },
  },
  {
    ignores: [ 'dist/', 'node_modules/', '.quasar/', '.wrangler/' ],
  },
]
