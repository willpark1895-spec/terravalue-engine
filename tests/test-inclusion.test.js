/**
 * Test-inclusion guard (Session A item 6).
 *
 * THE DEFECT THIS EXISTS FOR
 * `tests/soil-score.test.js` was added 2026-06-15. The `test` script in
 * package.json names its files explicitly and was last widened 2026-06-02.
 * Result: nine tests covering Soil Score v2 — the live path behind
 * POST /api/score — never ran in `npm test` for two months, and engine 1.3.0
 * and 1.4.0 both shipped through a `prepublishOnly` gate that skipped them.
 *
 * Nothing failed. That is the problem. This guard makes that silence noisy.
 *
 * WHY THE TEST SCRIPT STILL USES AN EXPLICIT LIST
 * Both discovery forms were executed against the working tree and both are worse:
 *   node --test tests/*.test.js  -> 48 tests; silently drops test-validation.js
 *   node --test tests/           -> fails MODULE_NOT_FOUND on generate-snapshots.js
 * So the explicit list stays, and this guard is what keeps it honest.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST_SCRIPT = require('../package.json').scripts.test;

/** Every *.test.js actually present in tests/. */
const present = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

/** Every tests/*.test.js path named in the test script. */
const named = (TEST_SCRIPT.match(/tests\/[A-Za-z0-9._-]+\.test\.js/g) || [])
  .map((p) => p.replace(/^tests\//, ''))
  .sort();

describe('npm test runs every test file that exists', () => {
  it('found test files to check', () => {
    assert.ok(present.length > 0, 'no *.test.js files found in tests/ — the guard itself is broken');
    assert.ok(named.length > 0, 'package.json test script names no test files');
  });

  for (const file of present) {
    it(`tests/${file} is named in the npm test script`, () => {
      assert.ok(
        named.includes(file),
        `tests/${file} exists but npm test does not run it.\n`
        + `  Add it to the "test" script in package.json:\n`
        + `    "test": "node --test ${[...named, file].map((f) => 'tests/' + f).join(' ')}"\n`
        + `  This is the exact failure that let Soil Score v2 ship untested through two releases.`
      );
    });
  }

  for (const file of named) {
    it(`tests/${file} named in the script actually exists`, () => {
      assert.ok(
        fs.existsSync(path.join(__dirname, file)),
        `npm test names tests/${file} but that file does not exist — the run will fail or silently skip.`
      );
    });
  }

  it('prepublishOnly still gates on npm test', () => {
    const pre = require('../package.json').scripts.prepublishOnly || '';
    assert.match(
      pre, /npm test/,
      'prepublishOnly no longer runs npm test — the only publish gate in either repo would be gone (there is no CI).'
    );
  });
});
