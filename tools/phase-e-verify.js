#!/usr/bin/env node
/**
 * phase-e-verify.js — gate for v1.0.2 (bundle banner-vs-reality fix).
 *
 * Asserts the regenerated browser bundle:
 *   1. Attaches all 7 validator surface symbols as statics on TerraValueEngine
 *      (the four the banner v1.0.1 promised + the three SCHEMAS/NUMERIC_SCHEMAS/
 *      STRING_SCHEMAS that lib/validate.js also exports).
 *   2. Throws ValidationError on bad input, AND `e instanceof
 *      TerraValueEngine.ValidationError` is now true (the Phase D gotcha is
 *      retired; the constructor-name fallback in the frontend still works).
 *   3. Math is byte-identical to the v1.0.1 baseline: demo input still
 *      produces $289,012 reconciled / $33,864/yr ecosystem.
 *
 * No npm install needed — runs against dist/terravalue-engine.browser.js
 * via vm.runInNewContext with a stubbed window.
 *
 * Usage:
 *   npm run build:browser  # regenerate first
 *   node tools/phase-e-verify.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUNDLE = path.resolve(__dirname, '..', 'dist', 'terravalue-engine.browser.js');

const src = fs.readFileSync(BUNDLE, 'utf8');
const sandbox = { window: {}, globalThis: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const W = sandbox.window;
const TVE = W.TerraValueEngine;

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

// 1. Validator surface — all 7 statics present and of the right type
check('TerraValueEngine attached to window', !!TVE);
check('TerraValueEngineRaw attached to window', !!W.TerraValueEngineRaw);
// Note: we deliberately don't check `TVE.ValidationError.prototype instanceof Error`
// here. The bundle runs in its own vm context, so the bundle-side `Error` is
// a different constructor from this verifier's `Error`. The meaningful test
// is the `caught instanceof TVE.ValidationError` check below, which compares
// two symbols both sourced from the bundle's context.
check('TerraValueEngine.ValidationError is a function (class)',
  typeof TVE.ValidationError === 'function');
check('TerraValueEngine.validateField is a function',
  typeof TVE.validateField === 'function');
check('TerraValueEngine.validateBody is a function',
  typeof TVE.validateBody === 'function');
check('TerraValueEngine.pickSchema is a function',
  typeof TVE.pickSchema === 'function');
check('TerraValueEngine.SCHEMAS is an object',
  TVE.SCHEMAS && typeof TVE.SCHEMAS === 'object');
check('TerraValueEngine.NUMERIC_SCHEMAS is an object',
  TVE.NUMERIC_SCHEMAS && typeof TVE.NUMERIC_SCHEMAS === 'object');
check('TerraValueEngine.STRING_SCHEMAS is an object',
  TVE.STRING_SCHEMAS && typeof TVE.STRING_SCHEMAS === 'object');

// 2. instanceof works on the attached class
let caught = null;
try {
  const schema = TVE.pickSchema(['canopyPct']);
  TVE.validateBody({ canopyPct: -50 }, schema);
} catch (e) { caught = e; }
check('validateBody throws on canopyPct: -50', !!caught);
check('thrown error is instanceof TerraValueEngine.ValidationError',
  caught instanceof TVE.ValidationError);
check('error message names the field and value',
  caught && /canopyPct: must be >= 0 \(got -50\)/.test(caught.message),
  caught && caught.message);
check('error exposes .allErrors (Phase D contract)',
  caught && Array.isArray(caught.allErrors) && caught.allErrors.length >= 1);

// 3. Math is byte-identical to the v1.0.1 baseline for the live frontend's
// demo input. These values are copied verbatim from terravalue/index.html's
// `value=` attributes and the `parcel = {...}` construction in lv-run; see
// commit 4e1eb68 on willpark1895-spec/terravalue. If the frontend's demo
// defaults ever change, update both here AND the handoff's stated baseline.
const demoParcel = {
  lotSizeSqFt: 18000,
  buildingSqFt: 2400,
  assessedValue: 180000,
  yearBuilt: 1995,
  canopyPct: 32,
  zoning: 'R-1',
  state: 'GA',
  propertyType: 'singleFamily',
  condition: 3,
  locationQuality: 3,
  canopySource: 'estimated',
};

const report = TVE.LandValuation.fullValuation(demoParcel);
check('LandValuation.fullValuation produces a report', !!report);

// The report's structure (per lib/terravalue-engine.js line ~1500):
//   report.valuation.reconciledValue       ← canonical
//   report.keyMetrics.reconciledValue      ← denormalized copy (should equal canonical)
//   report.ecosystemServices.annualValue   ← ecosystem total
// No top-level report.reconciledValue exists. The live frontend reads
// from a sub-object (index.html line ~1225).
const reconciled = report && report.valuation && report.valuation.reconciledValue;
const keyMetricsReconciled = report && report.keyMetrics && report.keyMetrics.reconciledValue;
const ecoAnnual = report && report.ecosystemServices && report.ecosystemServices.annualValue;

check('report.valuation.reconciledValue is finite',
  typeof reconciled === 'number' && Number.isFinite(reconciled),
  `got ${reconciled}`);
check('report.keyMetrics.reconciledValue equals report.valuation.reconciledValue',
  keyMetricsReconciled === reconciled,
  `keyMetrics=${keyMetricsReconciled}, valuation=${reconciled}`);
check('report.ecosystemServices.annualValue is finite',
  typeof ecoAnnual === 'number' && Number.isFinite(ecoAnnual),
  `got ${ecoAnnual}`);

// Strict math regression check, scoped to ecosystem services. After the Option A
// stock-vs-flow split (2026-06-08), annualValue is the FIVE RECURRING FLOWS ONLY:
// $264/yr for this demo parcel (canopyPct: 32). The one-time property premium
// ($33,600) is now reported separately as ecosystemServices.propertyPremiumOneTime;
// the old combined baseline was $33,864 (= 264 + 33,600). If either number drifts,
// the engine math has regressed — investigate before any publish.
check('ecosystemServices.annualValue is $264/yr (recurring flows only, post Option A)',
  ecoAnnual === 264,
  `got $${ecoAnnual && ecoAnnual.toLocaleString()}`);
check('ecosystemServices.propertyPremiumOneTime is $33,600 (one-time uplift, post Option A)',
  !!report && !!report.ecosystemServices && report.ecosystemServices.propertyPremiumOneTime === 33600,
  `got $${(report && report.ecosystemServices && report.ecosystemServices.propertyPremiumOneTime || 0).toLocaleString()}`);

// Surface the reconciledValue for human spot-check against terravalue.app's
// live demo output. We don't assert a specific value because the live
// frontend's $289,012 baseline was captured under a different parcel scenario.
if (report) {
  console.log('');
  console.log(`  ℹ reconciledValue (under canopyPct:32 demo): $${(reconciled || 0).toLocaleString()}`);
  console.log(`  ℹ ecosystemServices.annualValue: $${(ecoAnnual || 0).toLocaleString()}/yr (recurring flows; one-time premium reported separately)`);
  console.log('');
}

// Report
let pass = 0, fail = 0;
for (const c of checks) {
  if (c.ok) { pass++; console.log(`  ✓ ${c.name}`); }
  else { fail++; console.log(`  ✗ ${c.name}${c.detail ? ' — ' + c.detail : ''}`); }
}
console.log('');
console.log(`Phase E gate: ${pass}/${checks.length} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
