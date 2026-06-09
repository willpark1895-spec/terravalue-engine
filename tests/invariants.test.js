/**
 * Invariant / property tests — complements the golden snapshots.
 *
 * Golden snapshots pin EXACT outputs; these assert structural truths that must
 * hold for ANY input: conservation (totals == sum of parts), monotonicity,
 * reconciliation bounds, finiteness, and loud rejection of bad input. They
 * encode WHY the numbers are trustworthy, not just WHAT they currently are.
 *
 * Added 2026-05-31 after a stress-test pass. Includes a regression guard for
 * the /api/valuation schema bug: getCompositeValue must accept a property
 * valuation that has no lotSizeSqFt/canopyPct.
 *
 * Run: node --test tests/invariants.test.js   (or: npm test)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Determinism: freeze time + seed Math.random (matches generate-snapshots.js)
const FROZEN = new Date('2026-05-20T00:00:00.000Z').getTime();
const RealDate = Date;
global.Date = new Proxy(RealDate, { construct(t, a) { return a.length ? new t(...a) : new t(FROZEN); } });
global.Date.now = () => FROZEN;
function mulberry32(seed) { let s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let _rng = mulberry32(1); Math.random = () => _rng(); const reseed = (s = 1) => { _rng = mulberry32(s); };

const Raw = require('../lib/terravalue-engine');   // raw math
const TVE = require('../lib');                      // validated wrapper (package main)
const { ValidationError } = require('../lib/validate');

const eachNumber = (o, p, cb) => { if (o == null) return; if (typeof o === 'number') { cb(p, o); return; } if (typeof o !== 'object') return; for (const k of Object.keys(o)) eachNumber(o[k], p ? p + '.' + k : k, cb); };
const findNode = (o, pred) => { if (o && typeof o === 'object') { if (pred(o)) return o; for (const k of Object.keys(o)) { const r = findNode(o[k], pred); if (r) return r; } } return null; };
const reconOf = (o) => findNode(o, (x) => x && typeof x === 'object' && 'reconciledValue' in x && 'approachValues' in x && 'weights' in x);

describe('Ecosystem — conservation & monotonicity', () => {
  it('totalAnnual equals the sum of the five recurring flows; the one-time premium is separate', () => {
    for (const lot of [10000, 43560, 87120]) for (const av of [120000, 400000]) for (const st of ['GA', 'CA'])
      for (let c = 0; c <= 100; c += 10) {
        reseed(1);
        const r = Raw.EcosystemServices.calculate({ lotSizeSqFt: lot, canopyPct: c, assessedValue: av, state: st });
        const s = r.services;
        // totalAnnual is the recurring per-year flows ONLY (stock-vs-flow separation, Option A).
        const flows = s.carbon.value + s.stormwater.value + s.airQuality.value + s.energy.value + s.habitat.value;
        assert.equal(flows, r.totalAnnual, `Σflows != totalAnnual at lot=${lot} av=${av} ${st} c=${c}`);
        // The one-time property premium is surfaced separately and excluded from totalAnnual.
        assert.equal(s.propertyPremium.value, r.propertyPremiumOneTime, `propertyPremiumOneTime mismatch at lot=${lot} av=${av} ${st} c=${c}`);
        assert.equal(s.propertyPremium.oneTime, true, `propertyPremium not flagged one-time at lot=${lot} av=${av} ${st} c=${c}`);
      }
  });

  it('value is non-decreasing as canopy rises (other inputs fixed)', () => {
    for (const lot of [10000, 43560, 87120]) for (const av of [120000, 400000]) for (const st of ['GA', 'CA']) {
      let prev = -Infinity;
      for (let c = 0; c <= 100; c += 5) {
        reseed(1);
        const r = Raw.EcosystemServices.calculate({ lotSizeSqFt: lot, canopyPct: c, assessedValue: av, state: st });
        assert.ok(r.totalAnnual >= prev - 0.5, `non-monotonic at lot=${lot} ${st} c=${c}: ${r.totalAnnual} < ${prev}`);
        prev = r.totalAnnual;
      }
    }
  });
});

describe('Land valuation — reconciliation bounds', () => {
  const parcels = [];
  for (const lot of [15000, 43560, 87120]) for (const av of [120000, 400000, 800000])
    for (const pt of ['singleFamily', 'commercial', 'retail', 'industrial', 'multifamily']) for (const yb of [1985, 2015])
      parcels.push({ lotSizeSqFt: lot, assessedValue: av, state: 'GA', canopyPct: 30, buildingSqFt: Math.round(lot * 0.2), yearBuilt: yb, propertyType: pt, zoning: pt === 'singleFamily' ? 'R-1' : 'MU-1' });

  it('reconciledValue lies within [min,max] of the three approach values', () => {
    for (const p of parcels) {
      reseed(1);
      const n = reconOf(Raw.LandValuation.fullValuation(p));
      assert.ok(n, `no reconciliation node for ${p.propertyType}`);
      const v = [n.approachValues.salesComparison, n.approachValues.incomeCapitalization, n.approachValues.costApproach];
      assert.ok(n.reconciledValue >= Math.min(...v) - 1 && n.reconciledValue <= Math.max(...v) + 1,
        `reconciledValue ${n.reconciledValue} outside [${Math.min(...v)},${Math.max(...v)}] (${p.propertyType})`);
    }
  });

  it('reconciliation weights sum to 1', () => {
    for (const p of parcels) {
      reseed(1);
      const n = reconOf(Raw.LandValuation.fullValuation(p));
      const w = n.weights; const sum = (w.salesComparison || 0) + (w.income || 0) + (w.cost || 0);
      assert.ok(Math.abs(sum - 1) <= 0.02, `weights sum ${sum} (${p.propertyType}) ${JSON.stringify(w)}`);
    }
  });
});

describe('Robustness — finiteness under extreme inputs', () => {
  it('produces no NaN/Infinity across a fuzz sweep', () => {
    reseed(7); const rint = (a, b) => Math.floor(a + Math.random() * (b - a));
    for (let i = 0; i < 300; i++) {
      const lot = rint(1, 1e8), c = rint(0, 100), av = rint(1, 1e9);
      const p = { lotSizeSqFt: lot, canopyPct: c, assessedValue: av, state: Math.random() < 0.5 ? 'GA' : 'CA', buildingSqFt: rint(0, lot), yearBuilt: rint(1900, 2026), propertyType: ['singleFamily', 'commercial', 'retail', 'industrial', 'multifamily'][rint(0, 5)] };
      for (const out of [Raw.EcosystemServices.calculate(p), Raw.LandValuation.fullValuation(p)])
        eachNumber(out, '', (path, val) => assert.ok(Number.isFinite(val), `non-finite ${path}=${val} @ lot=${lot} c=${c} av=${av}`));
    }
  });
});

describe('Validation — refuses bad input at the engine boundary', () => {
  const bad = [
    ['canopyPct=-5', { lotSizeSqFt: 43560, canopyPct: -5, assessedValue: 200000, state: 'GA' }],
    ['canopyPct=150', { lotSizeSqFt: 43560, canopyPct: 150, assessedValue: 200000, state: 'GA' }],
    ['canopyPct=NaN', { lotSizeSqFt: 43560, canopyPct: NaN, assessedValue: 200000, state: 'GA' }],
    ['canopyPct="abc"', { lotSizeSqFt: 43560, canopyPct: 'abc', assessedValue: 200000, state: 'GA' }],
    ['lotSizeSqFt=0', { lotSizeSqFt: 0, canopyPct: 30, assessedValue: 200000, state: 'GA' }],
  ];
  for (const [label, p] of bad)
    it(`rejects ${label} with ValidationError`, () => {
      assert.throws(() => TVE.EcosystemServices.calculate(p), ValidationError);
    });
  it('accepts a valid parcel (positive control)', () => {
    const r = TVE.EcosystemServices.calculate({ lotSizeSqFt: 43560, canopyPct: 35, assessedValue: 200000, state: 'GA' });
    assert.ok(Number.isFinite(r.totalAnnual));
  });
});

describe('Regression — /api/valuation schema (getCompositeValue)', () => {
  it('accepts a property valuation with no lotSizeSqFt/canopyPct', async () => {
    // Mirrors what the API's handleValuation builds. Before the SCHEMA_VALUATION
    // fix this threw "lotSizeSqFt: is required; canopyPct: is required" and the
    // API surfaced it as a 500.
    const r = await TVE.PropertyValuation.getCompositeValue(
      { assessedValue: 200000, state: 'GA', taxYear: 2025 },
      { enableRedfin: false, assessmentRatio: 0.40 });
    assert.equal(r.compositeValue, 500000);
    assert.ok(r.sourceCount >= 1);
  });

  it('still rejects a valuation with a bad assessedValue', async () => {
    await assert.rejects(
      () => TVE.PropertyValuation.getCompositeValue({ assessedValue: -5 }, { enableRedfin: false }),
      ValidationError);
  });
});
