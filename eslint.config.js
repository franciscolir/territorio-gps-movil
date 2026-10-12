import js from '@eslint/js';

// Globals del navegador que app.js/lib.js usan (el HTML los define o vienen
// de los CDNs: supabase UMD y maplibre-gl).
const browser = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  alert: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  supabase: 'readonly',
  maplibregl: 'readonly',
};

// Lo que lib.js expone a app.js (script clásico, sin módulos)
const libGlobals = Object.fromEntries(
  [
    'ESTADOS', 'PIN_ICONS', 'estadoLabel',
    'escapeHtml', 'pointFromGeom', 'pointInGeometry',
    'nuevaOpCola', 'colaAgregar', 'colaQuitar', 'colaResumen', 'territorioAvance',
  ].map((k) => [k, 'readonly'])
);

const node = {
  process: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
};

const recommended = js.configs.recommended;

export default [
  { ignores: ['node_modules/**'] },

  // lib.js: API compartida del front. Se usa desde app.js (otro archivo), por
  // eso no se marca como "no usada" aquí; la verificación de uso cruza
  // archivos queda para cuando haya bundler/modules.
  {
    files: ['lib.js'],
    ...recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: browser,
    },
    rules: {
      ...recommended.rules,
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // app.js (toda la app de terreno): código del navegador
  {
    files: ['app.js'],
    ...recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browser, ...libGlobals },
    },
    rules: {
      ...recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },

  // Tests y config (ESM)
  {
    files: ['tests/**/*.js', 'eslint.config.js'],
    ...recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: node,
    },
    rules: {
      ...recommended.rules,
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
];
