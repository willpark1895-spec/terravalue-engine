/**
 * test-validation.js — F2 input-validation behavior across every engine entrypoint.
 *
 * Defends three layers of behavior:
 *   1. validateField — the single-field rules (number coercion, range checks)
 *   2. validateBody — the whole-object multi-error collection
 *   3. Engine boundary — every public method refuses bad input by throwing
 *      ValidationError (no silent NaN, no negative service values)
 *
 * Reproduces the three audit-confirmed bad inputs that the live API used to
 * return 200s for: lotSizeSqFt "abc", canopyPct -50, canopyPct 500.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const TerraValueEngine = require('../lib');
const {
  ValidationError,
  validateField,
  validateBody,
  pickSchema,
  NUMERIC_SCHEMAS,
} = require('../lib');

// ─── validateField — single-field rules ────────────────────────────────────

describe('validateField — numeric rules', () => {
  test('accepts a clean number', () => {
    assert.equal(validateField(40, 'canopyPct', { min: 0, max: 100 }), 40);
  });

  test('accepts a clean numeric string', () => {
    assert.equal(validateField('40', 'canopyPct', { min: 0, max: 100 }), 40);
  });

  test('accepts a comma-formatted number', () => {
    assert.equal(validateField('350,000', 'assessedValue', { min: 0, max: 1e9 }), 350000);
  });

  test('rejects "abc" — no silent NaN', () => {
    assert.throws(
      () => validateField('abc', 'lotSizeSqFt', { min: 1, max: 1e7 }),
      ValidationError,
    );
  });

  test('rejects "12abc" — Number-not-parseFloat semantics', () => {
    assert.throws(
      () => validateField('12abc', 'lotSizeSqFt', { min: 1, max: 1e7 }),
      ValidationError,
    );
  });

  test('rejects negative when min is 0', () => {
    assert.throws(
      () => validateField(-50, 'canopyPct', { min: 0, max: 100 }),
      (e) => e instanceof ValidationError && e.field === 'canopyPct' && /-50/.test(e.message),
    );
  });

  test('rejects above max', () => {
    assert.throws(
      () => validateField(500, 'canopyPct', { min: 0, max: 100 }),
      (e) => e instanceof ValidationError && e.field === 'canopyPct',
    );
  });

  test('rejects NaN explicitly', () => {
    assert.throws(
      () => validateField(NaN, 'lotSizeSqFt', { min: 1, max: 1e7 }),
      ValidationError,
    );
  });

  test('rejects Infinity', () => {
    assert.throws(
      () => validateField(Infinity, 'lotSizeSqFt', { min: 1, max: 1e7 }),
      ValidationError,
    );
  });

  test('rejects boolean (no silent coercion to 1/0)', () => {
    assert.throws(
      () => validateField(true, 'lotSizeSqFt', { min: 1, max: 1e7 }),
      (e) => e instanceof ValidationError && /boolean/.test(e.message),
    );
  });

  test('rejects empty string with "is required" when required: true', () => {
    assert.throws(
      () => validateField('', 'lotSizeSqFt', { required: true, min: 1, max: 1e7 }),
      (e) => e instanceof ValidationError && /required/.test(e.message),
    );
  });

  test('returns undefined for missing optional', () => {
    assert.equal(validateField(undefined, 'optional', { min: 0, max: 100 }), undefined);
  });

  test('integer: true rejects 3.5', () => {
    assert.throws(
      () => validateField(3.5, 'year', { min: 2000, max: 2100, integer: true }),
      (e) => e instanceof ValidationError && /whole/.test(e.message),
    );
  });

  test('accepts 0 when min: 0 (vacant-lot assessedValue)', () => {
    assert.equal(validateField(0, 'assessedValue', { min: 0, max: 1e9 }), 0);
  });
});

describe('validateField — string rules', () => {
  test('accepts an allowed enum value', () => {
    assert.equal(
      validateField('singleFamily', 'propertyType', {
        type: 'string',
        allowedValues: ['singleFamily', 'multifamily'],
      }),
      'singleFamily',
    );
  });

  test('rejects an enum value not in allowedValues', () => {
    assert.throws(
      () => validateField('bogus', 'propertyType', {
        type: 'string',
        allowedValues: ['singleFamily', 'multifamily'],
      }),
      (e) => e instanceof ValidationError && /must be one of/.test(e.message),
    );
  });
});

// ─── validateBody — multi-field error collection ──────────────────────────

describe('validateBody', () => {
  test('returns coerced values on success', () => {
    const schema = pickSchema(['lotSizeSqFt', 'canopyPct', 'assessedValue']);
    const result = validateBody(
      { lotSizeSqFt: '10890', canopyPct: 40, assessedValue: '350,000' },
      schema,
    );
    assert.equal(result.lotSizeSqFt, 10890);
    assert.equal(result.canopyPct, 40);
    assert.equal(result.assessedValue, 350000);
  });

  test('collects ALL errors before throwing', () => {
    const schema = pickSchema(['lotSizeSqFt', 'canopyPct', 'assessedValue']);
    assert.throws(
      () => validateBody({ lotSizeSqFt: 'abc', canopyPct: -50, assessedValue: -1 }, schema),
      (e) => {
        return e instanceof ValidationError
          && Array.isArray(e.allErrors)
          && e.allErrors.length === 3;
      },
    );
  });

  test('required field missing triggers single error', () => {
    const schema = pickSchema(['lotSizeSqFt', 'canopyPct', 'assessedValue']);
    assert.throws(
      () => validateBody({ canopyPct: 40, assessedValue: 350000 }, schema),
      (e) => e instanceof ValidationError && /lotSizeSqFt/.test(e.message),
    );
  });
});

// ─── Engine boundary — every public method refuses bad input ──────────────

describe('Engine boundary — EcosystemServices.calculate', () => {
  const validInput = { lotSizeSqFt: 10890, canopyPct: 40, assessedValue: 350000 };

  test('valid input produces a sensible result', () => {
    const result = TerraValueEngine.EcosystemServices.calculate(validInput);
    assert.ok(result, 'returns a result');
    assert.ok(result.services, 'result has services block');
  });

  test('audit repro #1: lotSizeSqFt "abc" throws ValidationError', () => {
    assert.throws(
      () => TerraValueEngine.EcosystemServices.calculate({ ...validInput, lotSizeSqFt: 'abc' }),
      (e) => e instanceof ValidationError && e.field === 'lotSizeSqFt',
    );
  });

  test('audit repro #2: canopyPct -50 throws ValidationError', () => {
    assert.throws(
      () => TerraValueEngine.EcosystemServices.calculate({ ...validInput, canopyPct: -50 }),
      (e) => e instanceof ValidationError && e.field === 'canopyPct' && /-50/.test(e.message),
    );
  });

  test('audit repro #3: canopyPct 500 throws ValidationError', () => {
    assert.throws(
      () => TerraValueEngine.EcosystemServices.calculate({ ...validInput, canopyPct: 500 }),
      (e) => e instanceof ValidationError && e.field === 'canopyPct',
    );
  });

  test('non-object input throws ValidationError', () => {
    assert.throws(
      () => TerraValueEngine.EcosystemServices.calculate(null),
      ValidationError,
    );
    assert.throws(
      () => TerraValueEngine.EcosystemServices.calculate('not-an-object'),
      ValidationError,
    );
  });
});

describe('Engine boundary — LandAppreciation.project', () => {
  const validInput = {
    currentScore: 50,
    projectedScore: 75,
    timelineYears: 10,
    propertyValue: 350000,
    currentCanopyPct: 40,
    lotSizeSqFt: 10890,
  };

  test('valid input produces a result', () => {
    const result = TerraValueEngine.LandAppreciation.project(validInput);
    assert.ok(result);
  });

  test('rejects timelineYears > 100', () => {
    assert.throws(
      () => TerraValueEngine.LandAppreciation.project({ ...validInput, timelineYears: 200 }),
      (e) => e instanceof ValidationError && e.field === 'timelineYears',
    );
  });

  test('rejects negative currentScore', () => {
    assert.throws(
      () => TerraValueEngine.LandAppreciation.project({ ...validInput, currentScore: -10 }),
      (e) => e instanceof ValidationError && e.field === 'currentScore',
    );
  });

  test('rejects fractional timelineYears (integer required)', () => {
    assert.throws(
      () => TerraValueEngine.LandAppreciation.project({ ...validInput, timelineYears: 3.5 }),
      (e) => e instanceof ValidationError && e.field === 'timelineYears' && /whole/.test(e.message),
    );
  });
});

describe('Engine boundary — LandValuation.fullValuation', () => {
  const validInput = { lotSizeSqFt: 10890, canopyPct: 40, assessedValue: 350000 };

  test('valid input runs', () => {
    const result = TerraValueEngine.LandValuation.fullValuation(validInput);
    assert.ok(result);
  });

  test('rejects negative canopyPct', () => {
    assert.throws(
      () => TerraValueEngine.LandValuation.fullValuation({ ...validInput, canopyPct: -50 }),
      (e) => e instanceof ValidationError && e.field === 'canopyPct',
    );
  });
});

describe('Engine boundary — CertificationPathway.assess', () => {
  test('valid input runs', () => {
    const result = TerraValueEngine.CertificationPathway.assess({ canopyPct: 40 });
    assert.ok(result);
  });

  test('rejects canopyPct > 100', () => {
    assert.throws(
      () => TerraValueEngine.CertificationPathway.assess({ canopyPct: 500 }),
      (e) => e instanceof ValidationError && e.field === 'canopyPct',
    );
  });

  test('rejects null siteData', () => {
    assert.throws(
      () => TerraValueEngine.CertificationPathway.assess(null),
      ValidationError,
    );
  });
});

describe('Raw engine subpath — bypasses validation', () => {
  test('require(.../raw) returns the unwrapped engine', () => {
    const Raw = require('../lib/terravalue-engine');
    // Raw engine does NOT throw on -50 — it just produces garbage. This is
    // the documented behavior; the raw subpath is for callers that have
    // already validated upstream.
    const result = Raw.EcosystemServices.calculate({
      lotSizeSqFt: 10890,
      canopyPct: -50,
      assessedValue: 350000,
    });
    assert.ok(result, 'raw engine returns SOMETHING (garbage) for -50 — that is the point');
  });
});

describe('Named exports', () => {
  test('ValidationError is exported', () => {
    assert.equal(typeof ValidationError, 'function');
    const e = new ValidationError('foo', 'bar');
    assert.equal(e.field, 'foo');
    assert.equal(e.message, 'foo: bar');
  });

  test('SCHEMAS / NUMERIC_SCHEMAS includes lotSizeSqFt', () => {
    assert.ok(NUMERIC_SCHEMAS.lotSizeSqFt);
    assert.equal(NUMERIC_SCHEMAS.lotSizeSqFt.required, true);
  });

  test('pickSchema throws on unknown field (catches typos at dev time)', () => {
    assert.throws(() => pickSchema(['lotSizeSqFt', 'nonsenseFieldName']));
  });
});
