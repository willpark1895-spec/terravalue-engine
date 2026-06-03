/**
 * @phloemxylem/terravalue-engine — Public Entry Point
 *
 * Wraps the raw engine (lib/terravalue-engine.js) with input validation at
 * every public-method boundary. This is what consumers see when they
 * `require('@phloemxylem/terravalue-engine')`.
 *
 * The raw engine is still available via the subpath:
 *   const Raw = require('@phloemxylem/terravalue-engine/lib/terravalue-engine');
 * Useful for tests or for callers that have already validated their input.
 *
 * Why a wrapper instead of editing the engine in place: the engine is 1,771
 * lines and has 17 snapshot tests defending its math. Wrapping at the public
 * boundary adds the F2 guard without touching a single line of the math
 * implementation, which keeps the snapshot tests provably trustworthy.
 *
 * Validation layers (F2):
 *   - Layer 1: UI form (frontend) — instant per-field feedback
 *   - Layer 2: API request boundary — 400s with field-level errors
 *   - Layer 3: Engine boundary (this file) — ValidationError thrown
 * Even if layers 1 and 2 are bypassed (batch job, integration partner, future
 * caller), the engine itself refuses to compute on bad input.
 */

const Engine = require('./terravalue-engine');
const {
  ValidationError,
  validateField,
  validateBody,
  pickSchema,
  SCHEMAS,
  NUMERIC_SCHEMAS,
  STRING_SCHEMAS,
} = require('./validate');

// ─── Per-method schema declarations ────────────────────────────────────────
// Each entrypoint's required/optional fields. Anything not listed here is
// either pass-through (free-form metadata) or computed internally.

const SCHEMA_ECOSYSTEM = pickSchema(['lotSizeSqFt', 'canopyPct', 'assessedValue', 'state', 'canopySource']);

const SCHEMA_APPRECIATION = pickSchema([
  'currentScore', 'projectedScore', 'timelineYears', 'propertyValue',
  'currentCanopyPct', 'lotSizeSqFt', 'baseAppreciationRate',
]);

const SCHEMA_LAND_VALUATION = pickSchema([
  'lotSizeSqFt', 'canopyPct', 'assessedValue',
  'buildingSqFt', 'yearBuilt', 'condition', 'locationQuality',
  'grossPotentialIncome', 'propertyType', 'state', 'zoning',
]);

const SCHEMA_CERTIFICATIONS = pickSchema([
  'canopyPct',
  'biodiversityNetGainPct', 'plantWallPct', 'pottedPlantPct',
]);

// NOTE: PropertyValuation.getCompositeValue values a property from its assessed
// value / AVM sources (Redfin, external APIs). It does NOT read lotSizeSqFt or
// canopyPct. Requiring them here rejected every well-formed /api/valuation call
// — the engine threw "lotSizeSqFt: is required; canopyPct: is required" and the
// API surfaced it as a 500. Regression-guarded in tests/invariants.test.js.
const SCHEMA_VALUATION = pickSchema([
  'assessedValue', 'taxYear', 'assessmentRatio',
  'propertyType', 'state',
]);

// ─── Validated wrappers ────────────────────────────────────────────────────
// Each wrapper validates input → merges validated values back over original
// input (preserves any non-schema fields the underlying method uses) → calls
// the raw engine method.

function withValidation(rawFn, schema, methodLabel) {
  return function validated(input, ...rest) {
    if (input == null || typeof input !== 'object') {
      throw new ValidationError('input', `${methodLabel} expects an object, got ${typeof input}`);
    }
    const validated = validateBody(input, schema);
    // Merge: validated values replace originals; non-schema fields pass through.
    const coerced = { ...input, ...validated };
    return rawFn(coerced, ...rest);
  };
}

// Build the validated facades.
const EcosystemServices = Object.create(Engine.EcosystemServices);
EcosystemServices.calculate = withValidation(
  Engine.EcosystemServices.calculate.bind(Engine.EcosystemServices),
  SCHEMA_ECOSYSTEM,
  'EcosystemServices.calculate',
);
EcosystemServices.calculateSoilScore = Engine.EcosystemServices.calculateSoilScore.bind(Engine.EcosystemServices);

const LandAppreciation = Object.create(Engine.LandAppreciation);
LandAppreciation.project = withValidation(
  Engine.LandAppreciation.project.bind(Engine.LandAppreciation),
  SCHEMA_APPRECIATION,
  'LandAppreciation.project',
);

const LandValuation = Object.create(Engine.LandValuation);
LandValuation.fullValuation = withValidation(
  Engine.LandValuation.fullValuation.bind(Engine.LandValuation),
  SCHEMA_LAND_VALUATION,
  'LandValuation.fullValuation',
);
// Pass-through methods on LandValuation that take pre-computed inputs
LandValuation.salesComparison = Engine.LandValuation.salesComparison.bind(Engine.LandValuation);
LandValuation.incomeCapitalization = Engine.LandValuation.incomeCapitalization.bind(Engine.LandValuation);
LandValuation.costApproach = Engine.LandValuation.costApproach.bind(Engine.LandValuation);
LandValuation.highestAndBestUse = Engine.LandValuation.highestAndBestUse.bind(Engine.LandValuation);
LandValuation.reconcile = Engine.LandValuation.reconcile.bind(Engine.LandValuation);

const CertificationPathway = Object.create(Engine.CertificationPathway);
CertificationPathway.assess = function assessValidated(siteData, targetCertifications) {
  if (siteData == null || typeof siteData !== 'object') {
    throw new ValidationError('siteData', 'CertificationPathway.assess expects an object');
  }
  const validated = validateBody(siteData, SCHEMA_CERTIFICATIONS);
  const coerced = { ...siteData, ...validated };
  return Engine.CertificationPathway.assess.call(Engine.CertificationPathway, coerced, targetCertifications);
};
CertificationPathway.generateChecklist = Engine.CertificationPathway.generateChecklist.bind(Engine.CertificationPathway);

const PropertyValuation = Object.create(Engine.PropertyValuation);
// getCompositeValue is async — wrap accordingly. Use the canopy/lot/value schema
// since PropertyValuation.getCompositeValue reads the same primary fields.
PropertyValuation.getCompositeValue = async function getCompositeValueValidated(parcel, options) {
  if (parcel == null || typeof parcel !== 'object') {
    throw new ValidationError('parcel', 'PropertyValuation.getCompositeValue expects an object');
  }
  const validated = validateBody(parcel, SCHEMA_VALUATION);
  const coerced = { ...parcel, ...validated };
  return Engine.PropertyValuation.getCompositeValue.call(Engine.PropertyValuation, coerced, options);
};

// ─── Re-assemble the top-level TerraValueEngine with validated submodules ──

class TerraValueEngine extends Engine {
  static PropertyValuation = PropertyValuation;
  static EcosystemServices = EcosystemServices;
  static LandAppreciation = LandAppreciation;
  static LandValuation = LandValuation;
  static CertificationPathway = CertificationPathway;
  static SustainabilityValue = Engine.SustainabilityValue;
  static Methodology = Engine.Methodology;
  static CERTIFICATIONS = Engine.CERTIFICATIONS;
  static ECOSYSTEM_SERVICE_RATES = Engine.ECOSYSTEM_SERVICE_RATES;
  static LAND_VALUATION_CONSTANTS = Engine.LAND_VALUATION_CONSTANTS;
}

module.exports = TerraValueEngine;
module.exports.default = TerraValueEngine;

// Named exports for the validator utilities — callers (API, frontend) can use
// these to validate at their layer with the same rules the engine enforces.
module.exports.ValidationError = ValidationError;
module.exports.validateField = validateField;
module.exports.validateBody = validateBody;
module.exports.pickSchema = pickSchema;
module.exports.SCHEMAS = SCHEMAS;
module.exports.NUMERIC_SCHEMAS = NUMERIC_SCHEMAS;
module.exports.STRING_SCHEMAS = STRING_SCHEMAS;
