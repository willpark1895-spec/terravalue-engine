#!/usr/bin/env node
/**
 * deployed-surface-parity.cjs — Session A item 4.
 *
 * Asserts that the engine versions actually deployed on each public surface
 * produce identical output on the golden fixtures.
 *
 *   terravalue/package.json   pins 1.1.0  -> browser bundle served on the MVP page
 *   px-website/package.json   pins 1.3.0  -> lib used by the serverless API
 *
 * Three engine versions have touched one page. Golden parity proves the engine
 * agrees with ITSELF at one version; it says nothing about two versions being
 * served side by side. This script closes that gap.
 *
 * NOT part of `npm test` — it needs network to fetch published tarballs, and
 * npm test must stay offline and fast. Run it before a release or after
 * changing either pin.
 *
 *   node tools/deployed-surface-parity.cjs                 # uses the pins below
 *   node tools/deployed-surface-parity.cjs 1.1.0 1.4.0     # compare any two
 *
 * VERIFIED 2026-08-25: 1.1.0 browser bundle === 1.3.0 lib, all four fixture
 * groups byte-identical. 1.1.0 vs 1.4.0 differs ONLY in the `methodology`
 * string (1.0.0 -> 2.0.0); every dollar value is identical. That difference is
 * the concrete reason px-website is pinned exact rather than carried on ^1.3.0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const MVP_PIN = process.argv[2] || '1.1.0';
const API_PIN = process.argv[3] || '1.3.0';
const PKG = '@phloemxylem/terravalue-engine';

const FROZEN_NOW = new Date('2026-05-20T00:00:00.000Z').getTime();
const RealDate = Date;
Date.now = () => FROZEN_NOW;
global.Date = new Proxy(RealDate, { construct(t, a) { return a.length === 0 ? new t(FROZEN_NOW) : new t(...a); } });
global.Date.now = () => FROZEN_NOW;
function mulberry32(seed) { let s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let _rng = mulberry32(1); Math.random = () => _rng(); const reset = () => { _rng = mulberry32(1); };

const { SUBJECTS } = (() => { try { return require('../tests/fitted-fixtures'); } catch { return { SUBJECTS: {} }; } })();

// Fixtures mirror tests/generate-snapshots.js. Kept literal so this script can
// run against published tarballs without the repo's test harness.
const PARCELS = { roswell: { lotSizeSqFt: 43560, canopyPct: 35, assessedValue: 200000, state: 'GA' }, mountVernon: { lotSizeSqFt: 21780, canopyPct: 45, assessedValue: 150000, state: 'GA' }, northRiver: { lotSizeSqFt: 87120, canopyPct: 20, assessedValue: 500000, state: 'GA' }, noCanopy: { lotSizeSqFt: 10000, canopyPct: 0, assessedValue: 80000, state: 'GA' }, maxCanopy: { lotSizeSqFt: 43560, canopyPct: 80, assessedValue: 300000, state: 'GA' }, nonGA: { lotSizeSqFt: 30000, canopyPct: 30, assessedValue: 400000, state: 'CA' } };
const PROJECTIONS = [{ currentScore: 45, projectedScore: 72, timelineYears: 30, propertyValue: 500000, currentCanopyPct: 25, lotSizeSqFt: 15000 }, { currentScore: 20, projectedScore: 80, timelineYears: 10, propertyValue: 300000, currentCanopyPct: 10, lotSizeSqFt: 43560 }, { currentScore: 70, projectedScore: 70, timelineYears: 5, propertyValue: 750000, currentCanopyPct: 40, lotSizeSqFt: 8000 }, { currentScore: 90, projectedScore: 95, timelineYears: 20, propertyValue: 1000000, currentCanopyPct: 60, lotSizeSqFt: 100000 }];
const SITE_DATA = { high: { canopyPct: 55, hasGreenInfrastructure: true, biodiversityNetGainPct: 15, plantWallPct: 3, pottedPlantPct: 2, hasErosionPlan: true, hasBiophiliaPlan: true }, low: { canopyPct: 10, hasGreenInfrastructure: false, biodiversityNetGainPct: 3, plantWallPct: 0, pottedPlantPct: 0, hasErosionPlan: false, hasBiophiliaPlan: false }, mid: { canopyPct: 30, hasGreenInfrastructure: true, biodiversityNetGainPct: 8, plantWallPct: 1, pottedPlantPct: 0.5, hasErosionPlan: true, hasBiophiliaPlan: false } };
const FULL_VALUATIONS = [{ lotSizeSqFt: 15000, assessedValue: 120000, state: 'GA', canopyPct: 30, buildingSqFt: 2200, yearBuilt: 2005, propertyType: 'singleFamily' }, { lotSizeSqFt: 43560, assessedValue: 400000, state: 'GA', canopyPct: 15, buildingSqFt: 5000, yearBuilt: 1990, propertyType: 'singleFamily', zoning: 'R-1' }, { lotSizeSqFt: 87120, assessedValue: 800000, state: 'GA', canopyPct: 40, buildingSqFt: 10000, yearBuilt: 2015, propertyType: 'singleFamily', zoning: 'MU-1' }];

function normalize(o) { if (o === null) return o; if (typeof o === 'number') return Object.is(o, -0) ? 0 : o; if (typeof o !== 'object') return o; if (Array.isArray(o)) return o.map(normalize); const out = {}; for (const [k, v] of Object.entries(o)) { if (k === 'generatedAt' || k === 'lastUpdated') continue; out[k] = normalize(v); } return out; }

function install(version, root) {
  const dir = path.join(root, `v${version}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `p${version.replace(/\./g, '')}`, version: '1.0.0', private: true }));
  execSync(`npm install --silent --no-audit --no-fund ${PKG}@${version}`, { cwd: dir, stdio: 'ignore' });
  return path.join(dir, 'node_modules', PKG);
}

function loadBundle(pkgDir) {
  const src = fs.readFileSync(path.join(pkgDir, 'dist', 'terravalue-engine.browser.js'), 'utf8');
  const sandbox = { window: {}, console, Math, Date, JSON, Object, Array, Number, String, Boolean, isNaN, isFinite, parseFloat, parseInt };
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  vm.createContext(sandbox); vm.runInContext(src, sandbox);
  const E = sandbox.window.TerraValueEngine || sandbox.TerraValueEngine;
  if (!E) throw new Error('browser bundle did not expose TerraValueEngine');
  return E;
}

function run(E) {
  const o = { ecosystem: {}, appreciation: [], certifications: {}, landValuation: [] };
  for (const [n, p] of Object.entries(PARCELS)) { reset(); o.ecosystem[n] = normalize(E.EcosystemServices.calculate(p)); }
  for (const p of PROJECTIONS) { reset(); o.appreciation.push(normalize(E.LandAppreciation.project(p))); }
  for (const [n, s] of Object.entries(SITE_DATA)) { reset(); o.certifications[n] = normalize(E.CertificationPathway.assess(s)); }
  for (const p of FULL_VALUATIONS) { reset(); o.landValuation.push(normalize(E.LandValuation.fullValuation(p))); }
  return o;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-parity-'));
console.log(`\nDeployed-surface parity\n  MVP browser bundle : ${MVP_PIN}\n  API lib            : ${API_PIN}\n  scratch            : ${root}\n`);

let failed = false;
try {
  const mvp = run(loadBundle(install(MVP_PIN, root)));
  const api = run(require(install(API_PIN, root)));
  for (const g of ['ecosystem', 'appreciation', 'certifications', 'landValuation']) {
    const same = JSON.stringify(mvp[g]) === JSON.stringify(api[g]);
    if (!same) failed = true;
    console.log(`  ${g.padEnd(16)} ${same ? 'identical' : 'DIFFERS'}`);
  }
  if (failed) {
    console.log('\n  First divergence on the roswell fixture:');
    const a = mvp.ecosystem.roswell, b = api.ecosystem.roswell;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log(`    ${k}: ${JSON.stringify(a[k])} (MVP) vs ${JSON.stringify(b[k])} (API)`);
    }
    console.log('\n  Two engine versions are serving one page and disagreeing. Repin before shipping.');
  } else {
    console.log('\n  Both deployed surfaces agree on every golden fixture.');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
