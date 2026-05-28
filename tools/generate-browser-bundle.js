#!/usr/bin/env node
/**
 * generate-browser-bundle.js — produce dist/terravalue-engine.browser.js
 *
 * Concatenates the engine source + validator + every config JSON into a single
 * self-contained browser file. Output:
 *
 *   1. Inlined config objects (replacing the require('../config') in the engine)
 *   2. The validator module (lib/validate.js) with module.exports stripped
 *   3. The raw engine (lib/terravalue-engine.js) with require/module.exports stripped
 *   4. The validation wrapper (lib/index.js) with require/module.exports stripped
 *   5. A footer that exposes `window.TerraValueEngine` with validation built in
 *      and `window.TerraValueEngineRaw` for callers that want to bypass
 *
 * This is NOT a build step in the traditional sense — no esbuild, no Babel,
 * no transpilation, no minification, no source-map generation. Just text
 * concatenation. Auditable in 60 seconds. The output is a normal JS file
 * that a browser can `<script src="...">` directly.
 *
 * The trade-off vs. a real bundler: we can't tree-shake, can't ESM-export,
 * can't produce a minified build. Those are all "later" concerns. Today,
 * what we need is one .js file that runs in a browser. That's what this does.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const CONFIG_DIR = path.join(ROOT, 'config');
const DIST = path.join(ROOT, 'dist');

// ─── Step 1: gather all config JSON files ───────────────────────────────────
const CONFIG_FILES = [
  'canopy-value-coefficients',
  'ecosystem-service-rates',
  'sustainability-metrics',
  'certifications',
  'land-valuation-constants',
];

const configObjects = {};
for (const name of CONFIG_FILES) {
  configObjects[name] = JSON.parse(
    fs.readFileSync(path.join(CONFIG_DIR, `${name}.json`), 'utf8')
  );
}

// METHODOLOGY_VERSION is declared in config/index.js (not a JSON file)
// Keep this in sync with config/index.js manually — bump both together.
const METHODOLOGY_VERSION = '1.0.0';

// ─── Step 2: read source files ──────────────────────────────────────────────
const engineSource = fs.readFileSync(path.join(LIB, 'terravalue-engine.js'), 'utf8');
const validateSource = fs.readFileSync(path.join(LIB, 'validate.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');

// ─── Step 3: transform each source for browser use ──────────────────────────
//
// Pattern: strip `require()` calls (browser has no require), strip
// `module.exports = ...` statements (we expose via window globals at the end),
// and replace the engine's `require('../config')` destructure with an inline
// object literal containing the config we just loaded.

const KEY_BY_VAR = {
  CANOPY_VALUE_COEFFICIENTS: 'canopy-value-coefficients',
  ECOSYSTEM_SERVICE_RATES: 'ecosystem-service-rates',
  SUSTAINABILITY_METRICS: 'sustainability-metrics',
  CERTIFICATIONS: 'certifications',
  LAND_VALUATION_CONSTANTS: 'land-valuation-constants',
};

// Compute the same ECO_SERVICE_TOTAL_PER_ACRE that config/index.js does
const rates = configObjects['ecosystem-service-rates'];
const ECO_SERVICE_TOTAL_PER_ACRE =
  rates.carbon.ratePerCanopyAcre +
  rates.stormwater.ratePerCanopyAcre +
  rates.airQuality.ratePerCanopyAcre +
  rates.energy.ratePerCanopyAcre +
  rates.habitat.ratePerCanopyAcre;

// Build the inline config-destructure replacement
const inlineConfigBlock = [
  '// ─── Config (inlined by tools/generate-browser-bundle.js) ───',
  `const METHODOLOGY_VERSION = ${JSON.stringify(METHODOLOGY_VERSION)};`,
  `const ECO_SERVICE_TOTAL_PER_ACRE = ${ECO_SERVICE_TOTAL_PER_ACRE};`,
  ...Object.entries(KEY_BY_VAR).map(([varName, fileKey]) => {
    return `const ${varName} = ${JSON.stringify(configObjects[fileKey], null, 2)};`;
  }),
].join('\n');

// Replace the engine's `const { ... } = require('../config');` block.
// The block spans multiple lines, so use a regex that matches the whole thing.
const REQUIRE_CONFIG_RE = /const\s*\{[\s\S]*?\}\s*=\s*require\(['"]\.\.\/config['"]\);?/;

if (!REQUIRE_CONFIG_RE.test(engineSource)) {
  throw new Error(
    'generate-browser-bundle: could not find `require(\'../config\')` block in lib/terravalue-engine.js. ' +
    'The engine source has changed in a way that broke this generator. Update the regex or the source.'
  );
}

const engineForBrowser = engineSource
  .replace(REQUIRE_CONFIG_RE, inlineConfigBlock)
  .replace(/^module\.exports\s*=.*$/gm, '// module.exports stripped for browser bundle');

// validate.js — strip the module.exports block at the end
const validateForBrowser = validateSource.replace(
  /module\.exports\s*=\s*\{[\s\S]*?\};?\s*$/m,
  '// module.exports stripped for browser bundle',
);

// index.js — strip the `require('./terravalue-engine')` and `require('./validate')`
// since both will already be in scope from earlier in the bundle.
const indexForBrowser = indexSource
  .replace(/const\s+Engine\s*=\s*require\(['"]\.\/terravalue-engine['"]\);?/, '// Engine already in scope from inlined source')
  .replace(/const\s*\{[\s\S]*?\}\s*=\s*require\(['"]\.\/validate['"]\);?/, '// validator symbols already in scope from inlined source')
  .replace(/^module\.exports\s*=.*$/gm, '// module.exports stripped for browser bundle')
  .replace(/^module\.exports\.\w+\s*=.*$/gm, '// named export stripped for browser bundle');

// Two collision classes the raw engine and the validated wrapper share:
//
//   (1) Top-level class name. Both files end up declaring `TerraValueEngine` at
//       module scope. We rename the raw engine's class to `TerraValueEngineRaw`,
//       same as before.
//
//   (2) Nested class names. lib/terravalue-engine.js declares EcosystemServices,
//       LandAppreciation, LandValuation, PropertyValuation, CertificationPathway,
//       Methodology, SustainabilityValue as standalone top-level classes (then
//       attaches them as static members of TerraValueEngine). lib/index.js
//       independently declares `const EcosystemServices = Object.create(...)`
//       and so on, for the validated facades. In Node these live in separate
//       module scopes and never see each other. In the concatenated browser
//       bundle, both end up at the global scope and the `const` declarations
//       collide with the `class` declarations — SyntaxError on script load.
//
// Cleanest fix: wrap the raw engine source in an IIFE that captures all its
// internal symbols and exports only TerraValueEngineRaw. The nested classes
// stay reachable through `TerraValueEngineRaw.EcosystemServices` (etc.)
// because the engine already exposes them as static members. The IIFE means
// none of the inner names leak to global scope, so the validated wrapper's
// `const EcosystemServices = ...` declarations have nothing to collide with.
//
// History: v1.0.0 of the engine shipped a bundle that worked under Node
// (where each file gets its own scope) but threw "Cannot declare a const
// variable twice: 'EcosystemServices'" the first time it was loaded into a
// real browser, during Phase C of the hub-and-spoke refactor on 2026-05-26.
// The IIFE wrap below is the v1.0.1 fix.

// First, the existing rename of the top-level class. This still happens so
// that the wrapper's `extends Engine` (rewritten below) can reach the right
// thing, AND so that the engine's own `module.exports = TerraValueEngine`
// (already stripped above) didn't need touching.
const engineWithRenamedClass = engineForBrowser.replace(
  /\bclass TerraValueEngine\b/g,
  'class TerraValueEngineRaw',
);

// Now wrap the engine source in an IIFE. The IIFE returns TerraValueEngineRaw,
// and we assign that to a top-level `var` so the validated wrapper code (which
// follows in the bundle) can reach it via the existing `Engine.X` rewrite.
const engineRenamed = [
  'var TerraValueEngineRaw = (function () {',
  engineWithRenamedClass,
  '  return TerraValueEngineRaw;',
  '})();',
].join('\n');

const indexRenamed = indexForBrowser.replace(
  /\bextends Engine\b/g,
  'extends TerraValueEngineRaw',
).replace(/\bEngine\.(PropertyValuation|EcosystemServices|LandAppreciation|SustainabilityValue|CertificationPathway|Methodology|LandValuation|CERTIFICATIONS|ECOSYSTEM_SERVICE_RATES|LAND_VALUATION_CONSTANTS)\b/g,
  'TerraValueEngineRaw.$1');

// ─── Step 4: assemble the bundle ────────────────────────────────────────────
const banner = `/**
 * @phloemxylem/terravalue-engine — Browser Bundle
 *
 * Generated by tools/generate-browser-bundle.js — do not edit by hand.
 * Source of truth: lib/terravalue-engine.js + lib/validate.js + lib/index.js
 *                  + config/*.json
 *
 * Generated: ${new Date().toISOString()}
 * Engine version: ${METHODOLOGY_VERSION}
 *
 * Exposes two globals:
 *   window.TerraValueEngine     — validated engine (the default; refuses bad input)
 *   window.TerraValueEngineRaw  — raw engine (no validation, for callers that
 *                                 have already validated their input)
 *
 * Exposes the validator surface as statics on TerraValueEngine
 * (the full export list of lib/validate.js):
 *   window.TerraValueEngine.ValidationError
 *   window.TerraValueEngine.validateField
 *   window.TerraValueEngine.validateBody
 *   window.TerraValueEngine.pickSchema
 *   window.TerraValueEngine.SCHEMAS
 *   window.TerraValueEngine.NUMERIC_SCHEMAS
 *   window.TerraValueEngine.STRING_SCHEMAS
 */
`;

const footer = `
// ─── Browser globals ─────────────────────────────────────────────────────────
// The IIFE pattern keeps the inlined source's internal variables (class names,
// helpers) out of the global namespace. Only the two top-level engines and the
// validator surface are exposed.
//
// The validator's full export list (lib/validate.js's module.exports) is
// attached as statics on TerraValueEngine so the bundle matches the banner's
// contract and so browser callers can write \`TerraValueEngine.validateBody(...)\`
// (and \`instanceof TerraValueEngine.ValidationError\`) the same way Node callers
// reach the same symbols via \`require('@phloemxylem/terravalue-engine/lib/validate')\`.
(function attachGlobals() {
  TerraValueEngine.ValidationError = ValidationError;
  TerraValueEngine.validateField = validateField;
  TerraValueEngine.validateBody = validateBody;
  TerraValueEngine.pickSchema = pickSchema;
  TerraValueEngine.SCHEMAS = SCHEMAS;
  TerraValueEngine.NUMERIC_SCHEMAS = NUMERIC_SCHEMAS;
  TerraValueEngine.STRING_SCHEMAS = STRING_SCHEMAS;

  if (typeof window !== 'undefined') {
    window.TerraValueEngine = TerraValueEngine;
    window.TerraValueEngineRaw = TerraValueEngineRaw;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.TerraValueEngine = TerraValueEngine;
    globalThis.TerraValueEngineRaw = TerraValueEngineRaw;
  }
})();
`;

const bundle = [
  banner,
  '// ═══════════════════════════════════════════════════════════════════════',
  '// 1. VALIDATOR (lib/validate.js)',
  '// ═══════════════════════════════════════════════════════════════════════',
  validateForBrowser,
  '',
  '// ═══════════════════════════════════════════════════════════════════════',
  '// 2. RAW ENGINE (lib/terravalue-engine.js, renamed to TerraValueEngineRaw)',
  '// ═══════════════════════════════════════════════════════════════════════',
  engineRenamed,
  '',
  '// ═══════════════════════════════════════════════════════════════════════',
  '// 3. VALIDATION WRAPPER (lib/index.js, exposes as TerraValueEngine)',
  '// ═══════════════════════════════════════════════════════════════════════',
  indexRenamed,
  '',
  footer,
].join('\n');

// ─── Step 5: write to dist/ ─────────────────────────────────────────────────
if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
const outPath = path.join(DIST, 'terravalue-engine.browser.js');
fs.writeFileSync(outPath, bundle);

const sizeKB = (bundle.length / 1024).toFixed(1);
console.log(`✓ Wrote ${outPath}`);
console.log(`  Size: ${sizeKB} KB (${bundle.length.toLocaleString()} bytes)`);
console.log(`  Engine version: ${METHODOLOGY_VERSION}`);
