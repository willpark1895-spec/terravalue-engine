/**
 * Soil Score v2 unit tests.
 *
 * Validates TerraValueEngine.SoilScore.calculate() — the config-weighted
 * composite that turns normalized environmental sub-scores into a 0–100 index.
 * These are NEW assertions; they do not touch the golden snapshots (the legacy
 * EcosystemServices.calculateSoilScore stub and analyze() output are unchanged).
 *
 * Run: node --test tests/soil-score.test.js   (or: npm test)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const TerraValueEngine = require('../lib/terravalue-engine');
const { SoilScore } = TerraValueEngine;

// A fully-specified, high-amenity parcel (all five inputs present).
const FULL = {
  canopyPct: 40,        // → canopy sub 100 (target 40)
  annualPM25: 5,        // → air quality sub 100 (WHO guideline)
  parkAccessPct: 100,   // → park access sub 100
  walkabilityIndex: 20, // → walkability sub 100
  imperviousPct: 0,     // → impervious sub 100
};

describe('SoilScore.calculate — shape & range', () => {
  it('exposes SoilScore on the engine', () => {
    assert.equal(typeof SoilScore.calculate, 'function');
  });

  it('a perfect parcel scores 100 with high confidence', () => {
    const r = SoilScore.calculate(FULL);
    assert.equal(r.score, 100);
    assert.equal(r.confidence, 'high');
    assert.equal(r.coverage, 1);
    assert.equal(r.factorsPresent.length, 5);
    assert.equal(r.version, '2.0.0');
  });

  it('every sub-score and the composite stay within 0–100', () => {
    const parcels = [
      FULL,
      { canopyPct: 0, annualPM25: 50, parkAccessPct: 0, walkabilityIndex: 1, imperviousPct: 100 },
      { canopyPct: 18, annualPM25: 9, parkAccessPct: 42, walkabilityIndex: 11, imperviousPct: 55 },
    ];
    for (const p of parcels) {
      const r = SoilScore.calculate(p);
      assert.ok(r.score >= 0 && r.score <= 100, `composite ${r.score} out of range`);
      for (const k of Object.keys(r.subScores)) {
        const s = r.subScores[k].score;
        if (s !== null) assert.ok(s >= 0 && s <= 100, `${k} sub ${s} out of range`);
      }
    }
  });

  it('clamps out-of-range inputs (canopy 200 → 100, PM2.5 2 → 100, impervious 120 → 0)', () => {
    const r = SoilScore.calculate({ canopyPct: 200, annualPM25: 2, parkAccessPct: 100, walkabilityIndex: 20, imperviousPct: 120 });
    assert.equal(r.subScores.canopy.score, 100);
    assert.equal(r.subScores.airQuality.score, 100);
    assert.equal(r.subScores.impervious.score, 0);
  });
});

describe('SoilScore.calculate — missing inputs & confidence', () => {
  it('renormalizes weights over present factors when inputs are missing', () => {
    // Only canopy + impervious supplied (weights 0.30 + 0.15 = 0.45 of 1.0).
    const r = SoilScore.calculate({ canopyPct: 40, imperviousPct: 0 });
    assert.equal(r.subScores.canopy.score, 100);
    assert.equal(r.subScores.impervious.score, 100);
    assert.equal(r.subScores.airQuality.score, null);
    assert.equal(r.subScores.airQuality.included, false);
    assert.equal(r.score, 100); // both present factors are 100 → composite 100
    assert.equal(r.factorsPresent.length, 2);
    assert.ok(r.coverage < 0.5);
    assert.ok(['low', 'moderate'].includes(r.confidence));
  });

  it('returns null score and "none" confidence when no inputs are present', () => {
    const r = SoilScore.calculate({});
    assert.equal(r.score, null);
    assert.equal(r.confidence, 'none');
    assert.equal(r.factorsPresent.length, 0);
  });

  it('surfaces absolute metrics for cross-city comparison', () => {
    const r = SoilScore.calculate({ canopyPct: 22, annualPM25: 8 });
    assert.equal(r.absolute.canopyPct, 22);
    assert.equal(r.absolute.annualPM25, 8);
    assert.equal(r.absolute.imperviousPct, undefined);
  });
});

describe('SoilScore.calculate — definition is a config knob', () => {
  it('pure-stewardship: zeroing walkability & parkAccess weights drops them from the composite', () => {
    const weights = { canopy: 0.5, airQuality: 0.2, impervious: 0.3, walkability: 0, parkAccess: 0 };
    const r = SoilScore.calculate(FULL, { weights });
    assert.equal(r.subScores.walkability.included, false);
    assert.equal(r.subScores.parkAccess.included, false);
    assert.ok(r.factorsPresent.includes('canopy'));
    assert.ok(!r.factorsPresent.includes('walkability'));
  });

  it('is deterministic', () => {
    assert.deepEqual(SoilScore.calculate(FULL), SoilScore.calculate(FULL));
  });
});
