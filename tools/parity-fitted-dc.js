#!/usr/bin/env node
/**
 * Python<->JS parity check for FittedValuation (DC artifact).
 * Scores every 2025+ holdout sale through lib/fitted-valuation.js and compares
 * to the trainer's predictions CSV. Gate: max relative diff < 1e-5.
 *
 * Usage: node tools/parity-fitted-dc.js <sales_csv> <python_pred_csv>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { FittedValuation } = require('../lib/fitted-valuation');

const artifact = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'hedonic', 'dc-1.0.json'), 'utf8'));

function parseCsv(text) {
  // The DC pull is comma-safe except the quoted address column.
  // Both CSVs are CRLF (python csv.writer default) — split tolerantly or the
  // last column silently becomes 'ward\r' and every ward dummy drops.
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { parts.push(cur); cur = ''; }
      else cur += ch;
    }
    parts.push(cur);
    const r = {};
    header.forEach((h, j) => { r[h] = parts[j]; });
    rows.push(r);
  }
  return rows;
}

const [salesCsv, predCsv] = process.argv.slice(2);
const sales = parseCsv(fs.readFileSync(salesCsv, 'utf8'));
const preds = parseCsv(fs.readFileSync(predCsv, 'utf8'));

// queue-index sales by (ssl|sale_date|sale_price) to tolerate duplicates
const bykey = new Map();
for (const r of sales) {
  const k = `${r.ssl}|${r.sale_date}|${Number(r.sale_price).toFixed(0)}`;
  if (!bykey.has(k)) bykey.set(k, []);
  bykey.get(k).push(r);
}

let n = 0, maxRel = 0, worst = null, missing = 0;
for (const p of preds) {
  const k = `${p.ssl}|${p.sale_date}|${Number(p.sale_price).toFixed(0)}`;
  const q = bykey.get(k);
  if (!q || !q.length) { missing++; continue; }
  const s = q.shift();
  const subject = {
    gba: s.gba, landarea: s.landarea, ayb: s.ayb, eyb: s.eyb, yrRmdl: s.yr_rmdl,
    bedrooms: s.bedrm, bathrooms: s.bathrm, halfBaths: s.hf_bathrm, rooms: s.rooms,
    stories: s.stories, units: s.num_units, ac: s.ac, fireplaces: s.fireplaces,
    condition: s.condition, grade: s.grade, usecode: s.usecode,
    lat: s.lat, lon: s.lon, ward: s.ward,
  };
  const out = FittedValuation.estimate(subject, artifact, { valuationDate: s.sale_date });
  const py = Number(p.predicted);
  const rel = Math.abs(out.estimate - py) / py;
  if (rel > maxRel) { maxRel = rel; worst = { ssl: p.ssl, js: out.estimate, py }; }
  n++;
}

console.log(`compared n=${n.toLocaleString()}  missing=${missing}`);
console.log(`max relative diff: ${(maxRel * 100).toFixed(5)}%  worst:`, worst);
if (maxRel > 1e-5 + 5e-4) { // rounding: JS rounds to $, artifact carry to 4dp
  console.error('PARITY FAIL');
  process.exit(1);
}
console.log('PARITY OK (within artifact rounding tolerance)');
