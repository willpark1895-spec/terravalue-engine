/**
 * TerraValue Configuration Loader
 *
 * Loads all research-backed constants from JSON config files.
 * Config files can be updated independently of code — rate changes
 * (e.g., EPA social cost of carbon update) are config edits, not code deploys.
 *
 * Each config file includes a _version field for auditability.
 */

const path = require('path');

const METHODOLOGY_VERSION = '1.0.0';

// Load config files relative to this directory
const configDir = __dirname;

const CANOPY_VALUE_COEFFICIENTS = require(path.join(configDir, 'canopy-value-coefficients.json'));
const ECOSYSTEM_SERVICE_RATES = require(path.join(configDir, 'ecosystem-service-rates.json'));
const SUSTAINABILITY_METRICS = require(path.join(configDir, 'sustainability-metrics.json'));
const CERTIFICATIONS = require(path.join(configDir, 'certifications.json'));
const LAND_VALUATION_CONSTANTS = require(path.join(configDir, 'land-valuation-constants.json'));
const SOIL_SCORE_CONFIG = require(path.join(configDir, 'soil-score.json'));

// Computed: sum of 5 non-property ecosystem service rates (for cross-module use)
// Validated against hardcoded 2004 in original engine: 494 + 520 + 418 + 252 + 320 = 2004
const ECO_SERVICE_TOTAL_PER_ACRE =
  ECOSYSTEM_SERVICE_RATES.carbon.ratePerCanopyAcre +
  ECOSYSTEM_SERVICE_RATES.stormwater.ratePerCanopyAcre +
  ECOSYSTEM_SERVICE_RATES.airQuality.ratePerCanopyAcre +
  ECOSYSTEM_SERVICE_RATES.energy.ratePerCanopyAcre +
  ECOSYSTEM_SERVICE_RATES.habitat.ratePerCanopyAcre;

// Config version — changes when any config file is updated
const CONFIG_VERSION = [
  CANOPY_VALUE_COEFFICIENTS._version,
  ECOSYSTEM_SERVICE_RATES._version,
  SUSTAINABILITY_METRICS._version,
  CERTIFICATIONS._version,
  LAND_VALUATION_CONSTANTS._version,
  SOIL_SCORE_CONFIG._version,
].join('+');

module.exports = {
  METHODOLOGY_VERSION,
  CONFIG_VERSION,
  CANOPY_VALUE_COEFFICIENTS,
  ECOSYSTEM_SERVICE_RATES,
  SUSTAINABILITY_METRICS,
  CERTIFICATIONS,
  LAND_VALUATION_CONSTANTS,
  SOIL_SCORE_CONFIG,
  ECO_SERVICE_TOTAL_PER_ACRE,
};
