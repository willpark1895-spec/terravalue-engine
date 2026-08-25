/**
 * FittedValuation golden fixtures (Session A item 2).
 *
 * WHY THIS EXISTS
 * config/hedonic/dc-1.0.json holds 598 numeric values and is the entire Gate 1
 * story — the fitted ridge hedonic that passes all four IAAO standards on the
 * 2025+ DC holdout. Before this file it was covered by exactly nothing: a
 * coefficient could change and `npm test` would still report all green.
 *
 * SHARED DELIBERATELY
 * The older fixture sets (PARCELS, PROJECTIONS, SITE_DATA, FULL_VALUATIONS) are
 * copy-pasted into BOTH generate-snapshots.js and golden-parity.test.js. That
 * duplication is a drift risk: edit one copy and the generator and the test
 * silently disagree about what is being tested. New fixtures live here, in one
 * place, required by both.
 *
 * COVERAGE INTENT
 *  - every flag the scorer can emit (all five)
 *  - the three weak spots M3 is meant to attack, so a future canopy feature
 *    has a committed before-picture rather than a remembered one:
 *      >$2M tier   median ratio 0.894 untrimmed
 *      Ward 3      centers low at 0.929
 *      Wards 7-8   dispersion, COD 14.0-15.3
 */

// Coordinates chosen to land inside cells present in the artifact vocabulary
// (cell_deg = 0.008). `outsideTraining` deliberately does not.
const SUBJECTS = {
  baseline: {
    gba: 1800, landarea: 2400, ayb: 1925, eyb: 1995, yrRmdl: 2012,
    bedrooms: 3, bathrooms: 2, halfBaths: 1, rooms: 7, stories: 2, units: 1,
    ac: 'Y', fireplaces: 1, condition: 'Good', grade: 'Good Quality',
    usecode: '11.0', lat: 38.924, lon: -76.964, ward: 'Ward 6',
  },

  // Known weak spot: the >$2M tier centers low (0.894 untrimmed).
  highValueTier: {
    gba: 6200, landarea: 9000, ayb: 1910, eyb: 2015, yrRmdl: 2018,
    bedrooms: 6, bathrooms: 5, halfBaths: 1, rooms: 13, stories: 3, units: 1,
    ac: 'Y', fireplaces: 3, condition: 'Excellent', grade: 'Exceptional-A',
    usecode: '11.0', lat: 38.924, lon: -76.964, ward: 'Ward 2',
  },

  // Known weak spot: Ward 3 centers low (0.929).
  ward3: {
    gba: 2600, landarea: 5000, ayb: 1940, eyb: 2000, yrRmdl: 0,
    bedrooms: 4, bathrooms: 3, halfBaths: 0, rooms: 9, stories: 2, units: 1,
    ac: 'Y', fireplaces: 1, condition: 'Very Good', grade: 'Very Good',
    usecode: '11.0', lat: 38.924, lon: -76.964, ward: 'Ward 3',
  },

  // Known weak spot: Wards 7-8 dispersion (COD 14.0-15.3).
  ward7: {
    gba: 1200, landarea: 3200, ayb: 1950, eyb: 1985, yrRmdl: 0,
    bedrooms: 3, bathrooms: 1, halfBaths: 0, rooms: 6, stories: 2, units: 1,
    ac: 'N', fireplaces: 0, condition: 'Fair', grade: 'Average',
    usecode: '11.0', lat: 38.924, lon: -76.964, ward: 'Ward 7',
  },

  // flag: no-coordinates
  noCoordinates: {
    gba: 1600, landarea: 2000, ayb: 1930, eyb: 1990, yrRmdl: 0,
    bedrooms: 3, bathrooms: 2, halfBaths: 0, rooms: 6, stories: 2, units: 1,
    ac: 'Y', fireplaces: 0, condition: 'Average', grade: 'Average',
    usecode: '11.0', ward: 'Ward 5',
  },

  // flags: unknown-grade, unknown-condition
  unknownGradeAndCondition: {
    gba: 1700, landarea: 2200, ayb: 1928, eyb: 1992, yrRmdl: 0,
    bedrooms: 3, bathrooms: 2, halfBaths: 0, rooms: 7, stories: 2, units: 1,
    ac: 'Y', fireplaces: 0, condition: 'Pristine', grade: 'Palatial',
    usecode: '11.0', lat: 38.924, lon: -76.964, ward: 'Ward 4',
  },

  // flag: location-cell-not-in-training  (coordinates in Atlanta, not DC)
  outsideTrainingCell: {
    gba: 1900, landarea: 8000, ayb: 1995, eyb: 2005, yrRmdl: 0,
    bedrooms: 4, bathrooms: 3, halfBaths: 0, rooms: 8, stories: 2, units: 1,
    ac: 'Y', fireplaces: 1, condition: 'Good', grade: 'Good Quality',
    usecode: '11.0', lat: 33.9526, lon: -84.5499, ward: 'Ward 1',
  },
};

// flag: quarter-extrapolated — a valuation date past the artifact's carry table.
const OPTIONS = {
  quarterExtrapolated: { subject: 'baseline', options: { valuationDate: '2026-08-01' } },
  anchorQuarter:       { subject: 'baseline', options: {} },
};

module.exports = { SUBJECTS, OPTIONS };
