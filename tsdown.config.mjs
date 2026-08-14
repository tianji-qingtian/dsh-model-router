/**
 * tsdown build for dsh-model-router.
 *
 * Two artifacts from one command:
 *   1. lib/index.js  — ESM Node host half (deps externalized; resolved against
 *      the profile's own @deepseek-ai/* installation at runtime).
 *   2. lib/client.js — browser client bundle in the harness ModuleLoader
 *      closure-factory format: `window.__ModuleLoader__.load({ id, factory })`.
 *      Platform modules (react, cordis, ui-slots, …) stay external and are
 *      resolved through the loader's injected `require`; everything else is
 *      inlined.
 */

const ID = 'dsh-model-router'

/** Module specifiers the harness shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** Bundles this package depends on at runtime (load-order edges in dsh.client.inject). */
const INJECTED_BUNDLES = [
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-api-remotes',
]

const CLIENT_EXTERNALS = [
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-runtime/client',
  ...INJECTED_BUNDLES,
]

export default [
  // ---- Node host half ----
  {
    name: ID,
    entry: ['src/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  // ---- Browser client bundle ----
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
