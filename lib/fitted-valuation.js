/**
 * TerraValue FittedValuation — per-market fitted AVM estimator (Gate 1, 2026-07-15).
 *
 * Scores a subject property against a trained coefficient artifact
 * (config/hedonic/<market>-<version>.json), produced by the market's trainer
 * (px-website/drafts/hedonic-train-dc.py for DC). Ridge hedonic on log price
 * + vertical-equity tilt + grade-band quarterly carry index.
 *
 * This module REPLACES LandValuation.salesComparison as the AVM *estimator*
 * for markets with a trained artifact. salesComparison remains the
 * explanation layer (it shows the user comps; it no longer sets the number).
 *
 * DC artifact validation (2025+ temporal holdout, IAAO ratio study):
 *   untrimmed: median 0.965 · COD 12.4 · PRD 1.039 · PRB -0.040
 *   IAAO-trimmed: median 0.964 · COD 10.5 · PRD 1.020 · PRB -0.015  (all four pass)
 *
 * The design vector here MUST stay byte-for-byte in sync with Spec.design()
 * in the trainer. Any change to either side is a METHODOLOGY change.
 */

'use strict';

const COND = { Poor: 1, Fair: 2, Average: 3, Good: 4, 'Very Good': 5, Excellent: 6 };
const GRADES = ['Low Quality', 'Fair Quality', 'Average', 'Above Average', 'Good Quality',
  'Very Good', 'Excellent', 'Superior', 'Exceptional-A', 'Exceptional-B',
  'Exceptional-C', 'Exceptional-D'];
const GIX = {};
GRADES.forEach((g, i) => { GIX[g] = i; });

function band(gix) {
  return gix <= 3 ? 0 : (gix <= 5 ? 1 : 2);
}

function quarterOf(dateStr) {
  // 'YYYY-MM-DD' (or Date) -> 'YYYYQn'
  const d = typeof dateStr === 'string' ? dateStr : dateStr.toISOString().slice(0, 10);
  const y = d.slice(0, 4);
  const m = parseInt(d.slice(5, 7), 10);
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
}

class FittedValuation {
  /**
   * @param {object} subject  Raw subject fields (CAMA-style):
   *   gba (req, sqft>0), landarea, ayb, eyb, yrRmdl, bedrooms, bathrooms,
   *   halfBaths, rooms, stories, units, ac (bool|'Y'), fireplaces,
   *   condition (string), grade (string), usecode (string), lat, lon,
   *   ward (string, e.g. 'Ward 6')
   * @param {object} artifact Parsed coefficient artifact JSON.
   * @param {object} [options]
   *   valuationDate: 'YYYY-MM-DD' (default: artifact anchor quarter)
   * @returns {{ estimate, quarter, market, artifactVersion, flags, methodology }}
   */
  static estimate(subject, artifact, options = {}) {
    if (!artifact || artifact.artifact !== 'terravalue-fitted-avm') {
      throw new Error('FittedValuation: invalid or missing coefficient artifact');
    }
    const gba = Number(subject.gba);
    if (!Number.isFinite(gba) || gba <= 0) {
      throw new Error('FittedValuation: subject.gba (gross building area, sqft) is required and must be > 0');
    }

    const flags = [];
    const V = artifact.vocab;
    const num = (v, dflt) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined)
      ? Number(v) : dflt;

    const land = num(subject.landarea, 0);
    const ayb = num(subject.ayb, 0);
    const eyb = num(subject.eyb, 0);
    const rmdl = num(subject.yrRmdl, 0);
    const bed = num(subject.bedrooms, 0);
    const bath = num(subject.bathrooms, 0);
    const hbath = num(subject.halfBaths, 0);
    const rooms = num(subject.rooms, 0);
    const stories = num(subject.stories, 0);
    const units = num(subject.units, 1);
    const ac = (subject.ac === true || subject.ac === 'Y') ? 1.0 : 0.0;
    const fp = num(subject.fireplaces, 0);

    let cond = COND[subject.condition];
    if (cond === undefined) { cond = 3; if (subject.condition) flags.push('unknown-condition'); }
    let gix = GIX[subject.grade];
    if (gix === undefined) { gix = 2; if (subject.grade) flags.push('unknown-grade'); }

    const lat = num(subject.lat, NaN);
    const lon = num(subject.lon, NaN);
    let cell = '';
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      cell = `${Math.floor(lat / artifact.cell_deg)}:${Math.floor(lon / artifact.cell_deg)}`;
      if (!(cell in V.cells)) flags.push('location-cell-not-in-training');
    } else {
      flags.push('no-coordinates');
    }

    // --- design vector (mirror of trainer Spec.design, q_override = anchor) ---
    const lg = Math.log(gba);
    const g = gix / 11.0;
    const hi = gix >= 6 ? 1.0 : 0.0;
    const x = [1.0, lg, Math.log(land + 1), bed, bath, hbath, rooms, stories, ac, fp,
      Math.min(units, 4),
      ayb > 1800 ? (2026 - ayb) / 100 : 1.0,
      eyb > 1800 ? (2026 - eyb) / 100 : 0.5,
      rmdl >= 2010 ? 1.0 : 0.0,
      (rmdl >= 1990 && rmdl < 2010) ? 1.0 : 0.0,
      g, g * g, g * (lg - 7.0),
      (lg - 7.0) * (lg - 7.0),
      hi * Math.log(land + 1), hi * (lg - 7.0), hi * bath,
      g * (cond - 3.0)];

    const pushDummies = (vb, key) => {
      const v = new Array(Object.keys(vb).length).fill(0.0);
      if (key in vb) v[vb[key]] = 1.0;
      for (const d of v) x.push(d);
    };
    pushDummies(V.grades, String(gix));
    pushDummies(V.conds, String(cond));
    pushDummies(V.uses, String(subject.usecode));
    pushDummies(V.quarters, artifact.anchor_quarter); // predictions are made at the anchor...
    pushDummies(V.wards, String(subject.ward));
    pushDummies(V.cells, cell);

    if (x.length !== artifact.beta.length) {
      throw new Error(`FittedValuation: design length ${x.length} != beta length ${artifact.beta.length} — artifact/scorer out of sync`);
    }

    let lp = 0;
    for (let i = 0; i < x.length; i++) lp += x[i] * artifact.beta[i];

    // vertical-equity tilt (fit at training time on a temporal pseudo-holdout)
    lp = lp + artifact.tilt.gamma * (lp - artifact.tilt.center);

    // ...then carried to the valuation quarter by the grade-band index
    const q = options.valuationDate ? quarterOf(options.valuationDate) : artifact.anchor_quarter;
    const table = artifact.carry[String(band(gix))];
    const ref = table[artifact.anchor_quarter];
    let level = table[q];
    if (level === undefined) {
      // exact quarter unknown: use latest available quarter before it, else anchor
      const known = Object.keys(table).sort();
      const prior = known.filter((k) => k <= q);
      level = prior.length ? table[prior[prior.length - 1]] : ref;
      flags.push('quarter-extrapolated');
    }
    const estimate = Math.exp(lp) * (level / ref);

    return {
      estimate: Math.round(estimate),
      quarter: q,
      market: artifact.market,
      artifactVersion: artifact.version,
      trainedThrough: artifact.train_through,
      flags,
      validation: artifact.validation,
      methodology: 'Fitted ridge hedonic (log price) with vertical-equity tilt and '
        + 'grade-band quarterly carry index. Trained per market; IAAO ratio-study '
        + 'validated on a temporal holdout. Sales-comparison comps are shown as an '
        + 'explanation layer and do not set this estimate.',
    };
  }
}

module.exports = { FittedValuation, quarterOf };
