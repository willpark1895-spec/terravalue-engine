/**
 * TerraValue Engine — Input Validation
 *
 * The single choke point every engine input passes through. Returns the coerced
 * value on success; throws ValidationError on failure. Callers (API handlers,
 * frontend forms, batch jobs) are expected to catch the error and surface the
 * field-level message to the user.
 *
 * History — finding F2 of AUDIT-2026-05-20.md:
 *   Live `/api/ecosystem` accepted `canopyPct: -50` and returned negative
 *   service values (-$247 carbon). Three confirmed reproductions:
 *     - "lotSizeSqFt": "abc"    → 200 with all value: null
 *     - "canopyPct":   -50      → 200 with negative service values
 *     - "canopyPct":   500      → 200 with 5× the 100% canopy result
 *   The API got a per-request validator (`validateField`) in May 2026. This
 *   module is that validator promoted into the engine itself, so the math
 *   layer refuses bad input regardless of caller. Three layers of defense:
 *     1. UI field-level validation (frontend)
 *     2. Request boundary validation (API handler)
 *     3. Engine boundary validation (this module)
 *
 * Coercion rules:
 *   - Accepts numbers and clean numeric strings ("43560" → 43560)
 *   - Accepts comma-formatted numbers ("350,000" → 350000)
 *   - Rejects NaN, Infinity, mixed strings ("43560abc"), empty strings, booleans
 *   - Range-checks against {min, max}; out-of-range throws
 *   - Integer mode rejects non-integers when integer: true
 */

class ValidationError extends Error {
  /**
   * @param {string} field — name of the invalid field
   * @param {string} message — human-readable explanation
   */
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Validate and coerce a single field against a spec.
 *
 * @param {*} value — raw value (any type)
 * @param {string} name — field name (used in error messages)
 * @param {Object} spec — { min, max, required, integer, type, allowedValues }
 * @returns {number | string | undefined} — coerced value
 * @throws {ValidationError} — on any validation failure
 */
function validateField(value, name, spec = {}) {
  const {
    min,
    max,
    required = false,
    integer = false,
    type = 'number',
    allowedValues,
  } = spec;

  // Missing value handling — null, undefined, empty string all mean "not provided"
  if (value == null || value === '') {
    if (required) throw new ValidationError(name, 'is required');
    return undefined;
  }

  // String-typed fields (enums like propertyType, canopySource)
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new ValidationError(name, 'must be a string');
    }
    if (allowedValues && !allowedValues.includes(value)) {
      throw new ValidationError(name, `must be one of: ${allowedValues.join(', ')}`);
    }
    return value;
  }

  // Reject booleans before Number() coercion (Number(true) === 1 would silently pass)
  if (typeof value === 'boolean') {
    throw new ValidationError(name, 'must be a number (got boolean)');
  }

  // Numeric coercion
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    // Strip commas (so "350,000" works) and trim. Then require Number() to
    // round-trip cleanly — Number("12abc") returns NaN, which is what we want.
    // parseFloat("12abc") would silently return 12; that's the trap we avoid.
    const trimmed = value.trim().replace(/,/g, '');
    if (trimmed === '') {
      throw new ValidationError(name, 'must be a number (got empty string)');
    }
    n = Number(trimmed);
  } else {
    throw new ValidationError(name, `must be a number (got ${typeof value})`);
  }

  if (!Number.isFinite(n)) {
    throw new ValidationError(name, `must be a finite number (got ${JSON.stringify(value)})`);
  }

  if (integer && !Number.isInteger(n)) {
    throw new ValidationError(name, `must be a whole number (got ${n})`);
  }

  if (min != null && n < min) {
    throw new ValidationError(name, `must be >= ${min} (got ${n})`);
  }
  if (max != null && n > max) {
    throw new ValidationError(name, `must be <= ${max} (got ${n})`);
  }

  return n;
}

/**
 * Validate every field in `body` against a schema. Collects ALL errors before
 * throwing, so the caller surfaces every problem in one round-trip rather than
 * forcing the user to fix-resubmit-fix-resubmit.
 *
 * @param {Object} body — the input object (e.g. an API request body)
 * @param {Object} schema — { [fieldName]: spec }
 * @returns {Object} — coerced values
 * @throws {ValidationError} — with field = first failing field; .allErrors holds the full list
 */
function validateBody(body, schema) {
  const errors = [];
  const values = {};
  for (const [field, spec] of Object.entries(schema)) {
    try {
      const v = validateField(body[field], field, spec);
      if (v !== undefined) values[field] = v;
    } catch (e) {
      if (e instanceof ValidationError) {
        errors.push(e);
      } else {
        throw e;
      }
    }
  }
  if (errors.length > 0) {
    const composite = new ValidationError(
      errors[0].field,
      errors.map((e) => e.message).join('; ')
    );
    composite.allErrors = errors;
    throw composite;
  }
  return values;
}

// ─── Canonical Schemas ─────────────────────────────────────────────────────
//
// Every engine input that crosses the public-method boundary is declared here.
// Ranges sourced from:
//   - lotSizeSqFt:     1 sqft to 10M sqft (~230 acres). Larger usually unit error.
//   - canopyPct:       0–100 inclusive. No such thing as negative or >100% canopy.
//   - assessedValue:   0 to $1B. Zero is legitimate for vacant land.
//   - propertyValue:   same as assessedValue.
//   - currentScore /
//     projectedScore:  0–100 (Soil Score range).
//   - timelineYears:   1–100. Longer projections are unreliable.
//   - condition /
//     locationQuality: 1–5 (engine's 1–5 ordinal scale).
//   - yearBuilt:       1700–current+5. Older usually means data error.
//   - taxYear:         1900–current+5.
//   - assessmentRatio: 0.01–1.0.
//   - baseAppreciationRate: -50% to +50% annual (realistic envelope).
//
const NUMERIC_SCHEMAS = {
  lotSizeSqFt:           { min: 1, max: 10_000_000, required: true },
  canopyPct:             { min: 0, max: 100, required: true },
  assessedValue:         { min: 0, max: 1_000_000_000, required: true },
  propertyValue:         { min: 0, max: 1_000_000_000, required: true },
  buildingSqFt:          { min: 0, max: 1_000_000 },
  yearBuilt:             { min: 1700, max: new Date().getFullYear() + 5, integer: true },
  condition:             { min: 1, max: 5, integer: true },
  locationQuality:       { min: 1, max: 5, integer: true },
  grossPotentialIncome:  { min: 0, max: 100_000_000 },
  currentScore:          { min: 0, max: 100, required: true },
  projectedScore:        { min: 0, max: 100, required: true },
  timelineYears:         { min: 1, max: 100, required: true, integer: true },
  currentCanopyPct:      { min: 0, max: 100 },
  baseAppreciationRate:  { min: -0.5, max: 0.5 },
  taxYear:               { min: 1900, max: new Date().getFullYear() + 5, integer: true },
  assessmentRatio:       { min: 0.01, max: 1.0 },
  biodiversityNetGainPct: { min: 0, max: 100 },
  plantWallPct:          { min: 0, max: 100 },
  pottedPlantPct:        { min: 0, max: 100 },
};

const STRING_SCHEMAS = {
  state:        { type: 'string' },
  propertyType: { type: 'string', allowedValues: ['singleFamily', 'multifamily', 'retail', 'office', 'industrial', 'mixedUse', 'vacantLand'] },
  canopySource: { type: 'string', allowedValues: ['measured', 'estimated'] },
  zoning:       { type: 'string' },
};

const SCHEMAS = { ...NUMERIC_SCHEMAS, ...STRING_SCHEMAS };

/**
 * Build a per-method schema by picking fields from the canonical SCHEMAS table.
 * Lets the engine's public methods declare their schema as `pickSchema(['lotSizeSqFt', 'canopyPct', ...])`.
 */
function pickSchema(fields) {
  const out = {};
  for (const f of fields) {
    if (!SCHEMAS[f]) {
      throw new Error(`pickSchema: unknown field "${f}" — add to NUMERIC_SCHEMAS or STRING_SCHEMAS in lib/validate.js`);
    }
    out[f] = SCHEMAS[f];
  }
  return out;
}

module.exports = {
  ValidationError,
  validateField,
  validateBody,
  pickSchema,
  SCHEMAS,
  NUMERIC_SCHEMAS,
  STRING_SCHEMAS,
};
