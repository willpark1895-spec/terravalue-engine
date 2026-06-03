/**
 * Source ↔ browser-bundle parity.
 *
 * The deployed frontend (terravalue.app) runs dist/terravalue-engine.browser.js,
 * generated from lib/ + config/ by tools/generate-browser-bundle.js. This test
 * asserts the generated bundle computes IDENTICALLY to the source engine, so
 * bundle-generation drift — a stripped export, a mangled inlined config, a
 * stale rebuild — can never ship silently.
 *
 * The bundle is gitignored, so this regenerates it first (cheap string concat)
 * and then loads it into an isolated VM context, exactly as a browser would.
 *
 * Run: node --test tests/bundle-parity.test.js   (or: npm test)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

// ── Determinism (matches generate-snapshots.js) ──
const FROZEN = new Date('2026-05-20T00:00:00.000Z').getTime();
const RealDate = Date;
global.Date = new Proxy(RealDate, { construct(t, a) { return a.length ? new t(...a) : new t(FROZEN); } });
global.Date.now = () => FROZEN;
function mulberry32(seed) { let s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let _rng = mulberry32(1); Math.random = () => _rng(); const reseed = (s = 1) => { _rng = mulberry32(s); };

// ── Regenerate the bundle so parity reflects the CURRENT source, then load it ──
const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'dist', 'terravalue-engine.browser.js');
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'generate-browser-bundle.js')], { stdio: 'ignore' });

const sandbox = { console, Math, Date, Intl, JSON, Object, Array, Number, String, Boolean, isNaN, isFinite, parseFloat, parseInt, Map, Set, Symbol, Error, RegExp };
sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'terravalue-engine.browser.js' });
const Bundle = sandbox.TerraValueEngineRaw || sandbox.TerraValueEngine;   // compare raw math surfaces
const Lib = require('../lib/terravalue-engine');

// The bundle runs in a separate VM realm, so its objects have different
// prototypes than the host's — deepStrictEqual would reject them on identity
// even when content is identical. Normalize both sides to plain host objects.
const norm = (x) => JSON.parse(JSON.stringify(x));

const PARCELS = [
  { lotSizeSqFt: 43560, canopyPct: 35, assessedValue: 200000, state: 'GA' },
  { lotSizeSqFt: 21780, canopyPct: 45, assessedValue: 150000, state: 'GA' },
  { lotSizeSqFt: 87120, canopyPct: 20, assessedValue: 500000, state: 'GA' },
  { lotSizeSqFt: 10000, canopyPct: 0, assessedValue: 80000, state: 'GA' },
  { lotSizeSqFt: 43560, canopyPct: 80, assessedValue: 300000, state: 'GA' },
  { lotSizeSqFt: 30000, canopyPct: 30, assessedValue: 400000, state: 'CA' },
];
const FULL = [
  { lotSizeSqFt: 15000, assessedValue: 120000, state: 'GA', canopyPct: 30, buildingSqFt: 2200, yearBuilt: 2005, propertyType: 'singleFamily' },
  { lotSizeSqFt: 43560, assessedValue: 400000, state: 'GA', canopyPct: 15, buildingSqFt: 5000, yearBuilt: 1990, propertyType: 'singleFamily', zoning: 'R-1' },
];

it('bundle exposes the engine surface', () => {
  assert.ok(Bundle && Bundle.EcosystemServices && Bundle.LandValuation, 'bundle did not expose TerraValueEngine');
});

describe('bundle parity — EcosystemServices.calculate', () => {
  for (const p of PARCELS)
    it(`matches source for ${p.canopyPct}% ${p.state} lot ${p.lotSizeSqFt}`, () => {
      reseed(1); const a = Lib.EcosystemServices.calculate(p);
      reseed(1); const b = Bundle.EcosystemServices.calculate(p);
      assert.deepEqual(norm(b), norm(a));
    });
});

describe('bundle parity — LandValuation.fullValuation', () => {
  FULL.forEach((p, i) =>
    it(`matches source for full valuation ${i + 1}`, () => {
      reseed(1); const a = Lib.LandValuation.fullValuation(p);
      reseed(1); const b = Bundle.LandValuation.fullValuation(p);
      assert.deepEqual(norm(b), norm(a));
    }));
});
