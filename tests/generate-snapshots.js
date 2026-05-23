#!/usr/bin/env node
/**
 * Generate golden snapshots for the engine.
 *
 * Runs lib/terravalue-engine.js across the same fixtures used by
 * golden-parity.test.js and writes the outputs to tests/golden-snapshots.json.
 *
 * The committed snapshot file becomes the source of truth for what the engine
 * should produce. Future test runs assert against it. When you INTENTIONALLY
 * change engine math, re-run this script and commit the updated snapshots
 * alongside the engine change — the diff in PR review shows reviewers exactly
 * which outputs moved.
 *
 * Usage:
 *   node tests/generate-snapshots.js
 *
 * REVIEW the resulting JSON before committing. These numbers are about to
 * become regression-test truth.
 */

const fs = require('fs');
const path = require('path');

// Freeze time so every date-dependent engine path (synthetic comp saleDate,
// time-since-sale adjustments, currentYear effective-age calculation) is
// deterministic. The test runner does the same thing, so generator and tests
// see identical clock values. Pinned to a date well after the engine's
// reference data so all sale dates land in the past.
const FROZEN_ISO = '2026-05-20T00:00:00.000Z';
const FROZEN_NOW = new Date(FROZEN_ISO).getTime();
const RealDate = Date;
Date.now = () => FROZEN_NOW;
// Wrap the Date constructor so `new Date()` (no args) also sees the frozen time.
// All other Date forms (with args) pass through untouched.
global.Date = new Proxy(RealDate, {
  construct(target, args) {
    if (args.length === 0) return new target(FROZEN_NOW);
    return new target(...args);
  },
});
global.Date.now = () => FROZEN_NOW;

// Replace Math.random with a deterministic PRNG so engine code that perturbs
// values (e.g., _generateSyntheticComps' buildingSqFt jitter) produces
// reproducible output. Uses mulberry32 — small, well-distributed, seedable.
// The PRNG state is reset before each top-level fixture in the loop below
// so fixtures are independent of each other.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let _rng = mulberry32(1);
Math.random = () => _rng();
function resetRng(seed = 1) { _rng = mulberry32(seed); }

const Lib = require('../lib/terravalue-engine');

// ─── Fixtures (kept identical to golden-parity.test.js) ──────

const PARCELS = {
  roswell:     { lotSizeSqFt: 43560, canopyPct: 35, assessedValue: 200000, state: 'GA' },
  mountVernon: { lotSizeSqFt: 21780, canopyPct: 45, assessedValue: 150000, state: 'GA' },
  northRiver:  { lotSizeSqFt: 87120, canopyPct: 20, assessedValue: 500000, state: 'GA' },
  noCanopy:    { lotSizeSqFt: 10000, canopyPct: 0,  assessedValue: 80000,  state: 'GA' },
  maxCanopy:   { lotSizeSqFt: 43560, canopyPct: 80, assessedValue: 300000, state: 'GA' },
  nonGA:       { lotSizeSqFt: 30000, canopyPct: 30, assessedValue: 400000, state: 'CA' },
};

const PROJECTIONS = [
  { currentScore: 45, projectedScore: 72, timelineYears: 30, propertyValue: 500000,  currentCanopyPct: 25, lotSizeSqFt: 15000 },
  { currentScore: 20, projectedScore: 80, timelineYears: 10, propertyValue: 300000,  currentCanopyPct: 10, lotSizeSqFt: 43560 },
  { currentScore: 70, projectedScore: 70, timelineYears: 5,  propertyValue: 750000,  currentCanopyPct: 40, lotSizeSqFt: 8000 },
  { currentScore: 90, projectedScore: 95, timelineYears: 20, propertyValue: 1000000, currentCanopyPct: 60, lotSizeSqFt: 100000 },
];

const SITE_DATA = {
  high: { canopyPct: 55, hasGreenInfrastructure: true,  biodiversityNetGainPct: 15, plantWallPct: 3,   pottedPlantPct: 2,   hasErosionPlan: true,  hasBiophiliaPlan: true  },
  low:  { canopyPct: 10, hasGreenInfrastructure: false, biodiversityNetGainPct: 3,  plantWallPct: 0,   pottedPlantPct: 0,   hasErosionPlan: false, hasBiophiliaPlan: false },
  mid:  { canopyPct: 30, hasGreenInfrastructure: true,  biodiversityNetGainPct: 8,  plantWallPct: 1,   pottedPlantPct: 0.5, hasErosionPlan: true,  hasBiophiliaPlan: false },
};

const FULL_VALUATIONS = [
  { lotSizeSqFt: 15000, assessedValue: 120000, state: 'GA', canopyPct: 30, buildingSqFt: 2200,  yearBuilt: 2005, propertyType: 'singleFamily' },
  { lotSizeSqFt: 43560, assessedValue: 400000, state: 'GA', canopyPct: 15, buildingSqFt: 5000,  yearBuilt: 1990, propertyType: 'singleFamily', zoning: 'R-1' },
  { lotSizeSqFt: 87120, assessedValue: 800000, state: 'GA', canopyPct: 40, buildingSqFt: 10000, yearBuilt: 2015, propertyType: 'singleFamily', zoning: 'MU-1' },
];

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Strip non-deterministic fields (timestamps) from any deeply-nested object
 * so the snapshot is stable across runs. Pure-math outputs don't include
 * these, but LandValuation.fullValuation emits `generatedAt`.
 */
function normalize(obj) {
  if (obj === null) return obj;
  if (typeof obj === 'number') {
    // Normalize negative zero to positive zero (IEEE-754 -0 === 0 but deepEqual
    // treats them as different). Comes up where the engine does
    // `canopyAcreDelta > 0 ? x : -x` when the delta is zero.
    return Object.is(obj, -0) ? 0 : obj;
  }
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(normalize);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'generatedAt' || k === 'lastUpdated') continue;
    out[k] = normalize(v);
  }
  return out;
}
// Alias for backward compatibility within this file.
const stripDates = normalize;

// ─── Generate ────────────────────────────────────────────────

const snapshots = {
  _meta: {
    generatedAt: new Date().toISOString(),
    engineVersion: '1.0.0',
    note: 'Frozen outputs of lib/terravalue-engine.js across the test fixtures. '
        + 'Future runs assert against these. When intentionally changing engine math, '
        + 're-run generate-snapshots.js and commit the updated file alongside the change.',
  },
  ecosystem: {},
  appreciation: [],
  certifications: {},
  landValuation: [],
};

for (const [name, parcel] of Object.entries(PARCELS)) {
  resetRng(1);
  snapshots.ecosystem[name] = stripDates(Lib.EcosystemServices.calculate(parcel));
}

for (const params of PROJECTIONS) {
  resetRng(1);
  snapshots.appreciation.push({
    input: params,
    output: stripDates(Lib.LandAppreciation.project(params)),
  });
}

for (const [name, siteData] of Object.entries(SITE_DATA)) {
  resetRng(1);
  snapshots.certifications[name] = stripDates(Lib.CertificationPathway.assess(siteData));
}

for (const parcel of FULL_VALUATIONS) {
  resetRng(1);
  snapshots.landValuation.push({
    input: parcel,
    output: stripDates(Lib.LandValuation.fullValuation(parcel)),
  });
}

const outPath = path.join(__dirname, 'golden-snapshots.json');
fs.writeFileSync(outPath, JSON.stringify(snapshots, null, 2));

console.log(`Snapshots written to ${outPath}`);
console.log('');
console.log(`  Ecosystem fixtures:        ${Object.keys(snapshots.ecosystem).length}`);
console.log(`  Appreciation fixtures:     ${snapshots.appreciation.length}`);
console.log(`  Certification fixtures:    ${Object.keys(snapshots.certifications).length}`);
console.log(`  LandValuation fixtures:    ${snapshots.landValuation.length}`);
console.log('');
console.log('Review the JSON before committing. These numbers become regression-test truth.');
