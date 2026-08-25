/**
 * config-fingerprint.js — shared helper for the config-hash guard (Session A item 1).
 *
 * WHY THIS EXISTS
 * Golden snapshots capture engine OUTPUTS. A constant can be edited and, if it
 * happens not to move a fixture output, nothing fails. This module fingerprints
 * the INPUTS so that editing any constant fails the suite even when no output
 * moves.
 *
 * `config/hedonic/dc-1.0.json` is included deliberately: it holds 598 numeric
 * values, is the entire Gate 1 story, and was previously covered by nothing.
 *
 * Definition of "numeric leaf": any JSON value where typeof === 'number' and
 * Number.isFinite() is true, at any depth, including inside arrays. Keys are
 * irrelevant. This definition must not change without regenerating snapshots —
 * it is part of the committed contract.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(__dirname, '..', 'config');

// Explicit list, not a glob. A new config file must be added here consciously —
// the bijection test below turns "someone added a config file" into a failure
// rather than a silence. Same principle as the test-inclusion guard.
const CONFIG_FILES = [
  'canopy-value-coefficients.json',
  'certifications.json',
  'ecosystem-service-rates.json',
  'land-valuation-constants.json',
  'soil-score.json',
  'sustainability-metrics.json',
  'hedonic/dc-1.0.json',
];

function countNumericLeaves(node) {
  if (typeof node === 'number') return Number.isFinite(node) ? 1 : 0;
  if (node === null || typeof node !== 'object') return 0;
  let n = 0;
  for (const v of Array.isArray(node) ? node : Object.values(node)) n += countNumericLeaves(v);
  return n;
}

/** Every .json actually present under config/, relative to config/. */
function discoverConfigFiles() {
  const out = [];
  (function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith('.json')) out.push(rel);
    }
  })(CONFIG_DIR, '');
  return out;
}

/** Deterministic fingerprint of every config input the engine consumes. */
function fingerprint() {
  const files = {};
  let total = 0;
  for (const rel of CONFIG_FILES) {
    const abs = path.join(CONFIG_DIR, rel);
    const raw = fs.readFileSync(abs);
    const numericLeaves = countNumericLeaves(JSON.parse(raw.toString('utf-8')));
    files[rel] = {
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      numericLeaves,
    };
    total += numericLeaves;
  }
  return { files, totalNumericLeaves: total };
}

module.exports = { fingerprint, discoverConfigFiles, countNumericLeaves, CONFIG_FILES, CONFIG_DIR };
