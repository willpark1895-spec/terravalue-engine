/**
 * TerraValue Engine v1.0 — Server-Side Module
 *
 * Parcel-level ecosystem services & land valuation calculator
 * Built by P&X — Phloem & Xylem
 *
 * This is the Node.js server-side version of the engine.
 * Constants are loaded from config/ JSON files instead of being inlined.
 * All calculation logic is identical to website/terravalue-engine.js.
 *
 * Usage:
 *   const TerraValueEngine = require('./lib/terravalue-engine');
 *   const result = TerraValueEngine.EcosystemServices.calculate({ ... });
 */

const {
  METHODOLOGY_VERSION,
  CANOPY_VALUE_COEFFICIENTS,
  ECOSYSTEM_SERVICE_RATES,
  SUSTAINABILITY_METRICS,
  CERTIFICATIONS,
  LAND_VALUATION_CONSTANTS,
  ECO_SERVICE_TOTAL_PER_ACRE,
} = require('../config');


// ============================================================
// PROPERTY VALUATION MODULE
// ============================================================

class PropertyValuation {
  /**
   * Cross-reference parcel value from multiple sources
   *
   * Priority: 1) Tax assessor (ArcGIS) 2) Redfin estimate 3) Pluggable API
   * Returns a confidence-weighted composite value
   */
  static async getCompositeValue(parcelData, options = {}) {
    const sources = [];

    // Source 1: Tax assessor data (from ArcGIS — already in TerraValue pipeline)
    if (parcelData.assessedValue) {
      // Tax assessed values are typically 40-100% of market value depending on jurisdiction
      // Georgia: assessed at 40% of fair market value (O.C.G.A. § 48-5-7)
      const assessmentRatio = parcelData.state === 'GA' ? 0.40 : (options.assessmentRatio || 1.0);
      const estimatedMarketValue = parcelData.assessedValue / assessmentRatio;
      sources.push({
        source: 'tax_assessor',
        value: estimatedMarketValue,
        assessedValue: parcelData.assessedValue,
        assessmentRatio,
        confidence: 0.85,
        lastUpdated: parcelData.taxYear || new Date().getFullYear(),
        note: `GA assessed at ${(assessmentRatio * 100).toFixed(0)}% of FMV per O.C.G.A. § 48-5-7`,
      });
    }

    // Source 2: Redfin estimate (free, no API key needed for basic lookup)
    if (options.enableRedfin !== false) {
      try {
        const redfinEstimate = await PropertyValuation.fetchRedfinEstimate(parcelData.address);
        if (redfinEstimate) {
          sources.push({
            source: 'redfin_estimate',
            value: redfinEstimate.value,
            confidence: redfinEstimate.confidence || 0.75,
            lastUpdated: redfinEstimate.lastUpdated,
            note: 'Redfin Automated Valuation Model (AVM)',
          });
        }
      } catch (e) {
        // Redfin unavailable — continue with other sources
      }
    }

    // Source 3: Pluggable third-party API (Zillow, CoreLogic, ATTOM, etc.)
    if (options.externalApi && typeof options.externalApi.fetchValue === 'function') {
      try {
        const externalEstimate = await options.externalApi.fetchValue(parcelData);
        if (externalEstimate) {
          sources.push({
            source: options.externalApi.name || 'external_api',
            value: externalEstimate.value,
            confidence: externalEstimate.confidence || 0.80,
            lastUpdated: externalEstimate.lastUpdated,
            note: externalEstimate.note || 'Third-party valuation API',
          });
        }
      } catch (e) {
        // External API unavailable — continue
      }
    }

    // Composite: confidence-weighted average
    if (sources.length === 0) {
      return { compositeValue: null, sources: [], error: 'No valuation sources available' };
    }

    const totalConfidence = sources.reduce((sum, s) => sum + s.confidence, 0);
    const compositeValue = Math.round(
      sources.reduce((sum, s) => sum + s.value * (s.confidence / totalConfidence), 0)
    );

    return {
      compositeValue,
      sources,
      sourceCount: sources.length,
      methodology: 'Confidence-weighted average across available valuation sources',
    };
  }

  /**
   * Redfin estimate fetcher
   * Uses Redfin's public page data (no API key required)
   * In production, this would scrape or use their embed endpoint
   */
  static async fetchRedfinEstimate(address) {
    // Interface for Redfin integration
    // In v1, returns null — ready for implementation when Redfin
    // endpoint is configured
    return null;
  }
}


// ============================================================
// ECOSYSTEM SERVICES MODULE
// ============================================================

class EcosystemServices {
  /**
   * Calculate all six ecosystem service values for a parcel
   *
   * @param {Object} parcel — { lotSizeSqFt, canopyPct, assessedValue, state }
   * @returns {Object} breakdown of all six services
   */
  static calculate(parcel) {
    const lotAcres = parcel.lotSizeSqFt / 43560;
    const canopyAcres = lotAcres * (parcel.canopyPct / 100);
    const rates = ECOSYSTEM_SERVICE_RATES;

    const carbon = Math.round(canopyAcres * rates.carbon.ratePerCanopyAcre);
    const stormwater = Math.round(canopyAcres * rates.stormwater.ratePerCanopyAcre);
    const airQuality = Math.round(canopyAcres * rates.airQuality.ratePerCanopyAcre);
    const energy = Math.round(canopyAcres * rates.energy.ratePerCanopyAcre);
    const habitat = Math.round(canopyAcres * rates.habitat.ratePerCanopyAcre);

    // Property premium — applied to market value, capped at maxPremiumPct (12%)
    const marketValue = parcel.state === 'GA'
      ? parcel.assessedValue / 0.40
      : parcel.assessedValue;
    const rawPremiumPct = rates.propertyPremium.premiumPct * (parcel.canopyPct / 30);
    const cappedPremiumPct = Math.min(rawPremiumPct, CANOPY_VALUE_COEFFICIENTS.maxPremiumPct / 100);
    const propertyPremium = Math.round(
      marketValue * cappedPremiumPct
      // Scaled linearly — 30% canopy = full 7% premium (Siriwardena optimal), capped at 12%
    );

    const totalAnnual = carbon + stormwater + airQuality + energy + habitat + propertyPremium;

    return {
      services: {
        carbon: { value: carbon, ...rates.carbon },
        stormwater: { value: stormwater, ...rates.stormwater },
        airQuality: { value: airQuality, ...rates.airQuality },
        energy: { value: energy, ...rates.energy },
        habitat: { value: habitat, ...rates.habitat },
        propertyPremium: { value: propertyPremium, ...rates.propertyPremium },
      },
      totalAnnual,
      parcelMetrics: {
        lotAcres: Math.round(lotAcres * 1000) / 1000,
        canopyAcres: Math.round(canopyAcres * 1000) / 1000,
        canopyPct: parcel.canopyPct,
        estimatedMarketValue: marketValue,
      },
      methodology: METHODOLOGY_VERSION,
    };
  }

  /**
   * Soil Score (0–100 stewardship index)
   *
   * STATUS: COMING SOON
   * Returns null until data pipeline is complete.
   */
  static calculateSoilScore(_parcel) {
    return null; // Coming soon — data sources not yet integrated
  }
}


// ============================================================
// LAND APPRECIATION MODULE
// ============================================================

class LandAppreciation {
  /**
   * Project land value change based on TerraValue score changes
   *
   * Methodology (sharable):
   *  1. Score change → canopy coverage change (linear: 1 score point ≈ 0.5% canopy)
   *  2. Canopy change → property value impact (Netusil et al. 2014: 0.17% per 1% canopy)
   *  3. Apply diminishing returns above 40% canopy (Cho et al. 2020)
   *  4. Add ecosystem service value delta over projection period
   *  5. Apply regional market appreciation baseline (Case-Shiller or FHFA HPI)
   */
  static project(params) {
    const {
      currentScore,
      projectedScore,
      timelineYears,
      propertyValue,
      currentCanopyPct = 25,
      lotSizeSqFt = 15000,
      baseAppreciationRate = 0.035, // 3.5% — long-term Atlanta metro average (FHFA HPI)
    } = params;

    const scoreDelta = projectedScore - currentScore;
    const canopyChangePct = scoreDelta * 0.5; // 1 score pt ≈ 0.5% canopy change
    const newCanopyPct = Math.max(0, Math.min(80, currentCanopyPct + canopyChangePct));

    // Property value impact from canopy change
    // Apply diminishing returns curve
    const canopyImpactPct = LandAppreciation._canopyValueCurve(
      currentCanopyPct,
      newCanopyPct
    );

    const greenPremiumShift = Math.round(propertyValue * canopyImpactPct);

    // Ecosystem service value change
    const lotAcres = lotSizeSqFt / 43560;
    const currentCanopyAcres = lotAcres * (currentCanopyPct / 100);
    const projectedCanopyAcres = lotAcres * (newCanopyPct / 100);
    const canopyAcreDelta = projectedCanopyAcres - currentCanopyAcres;

    const ecoServiceRate = ECO_SERVICE_TOTAL_PER_ACRE; // All non-property services = $2,004
    const annualEcoDelta = Math.round(canopyAcreDelta * ecoServiceRate);
    const cumulativeEco = annualEcoDelta * timelineYears;

    // Market appreciation baseline (compound)
    const marketAppreciation = Math.round(
      propertyValue * (Math.pow(1 + baseAppreciationRate, timelineYears) - 1)
    );

    // Total projected value change
    const totalImpact = greenPremiumShift + cumulativeEco;
    const totalWithMarket = totalImpact + marketAppreciation;

    // Sustainability value (building-level savings)
    const sustainabilityValue = SustainabilityValue.calculate({
      canopyAcreDelta,
      lotAcres,
      currentCanopyPct,
      newCanopyPct,
      timelineYears,
    });

    return {
      summary: {
        currentScore,
        projectedScore,
        scoreDelta,
        timelineYears,
        propertyValue,
      },
      canopyChange: {
        currentPct: currentCanopyPct,
        projectedPct: Math.round(newCanopyPct * 10) / 10,
        changePct: Math.round(canopyChangePct * 10) / 10,
      },
      propertyImpact: {
        greenPremiumShift,
        greenPremiumPct: Math.round(canopyImpactPct * 10000) / 100,
        marketAppreciation,
        baseAppreciationRate,
      },
      ecosystemValue: {
        annualDelta: annualEcoDelta,
        cumulativeOverPeriod: cumulativeEco,
        perServiceDelta: {
          carbon: Math.round(canopyAcreDelta * ECOSYSTEM_SERVICE_RATES.carbon.ratePerCanopyAcre),
          stormwater: Math.round(canopyAcreDelta * ECOSYSTEM_SERVICE_RATES.stormwater.ratePerCanopyAcre),
          airQuality: Math.round(canopyAcreDelta * ECOSYSTEM_SERVICE_RATES.airQuality.ratePerCanopyAcre),
          energy: Math.round(canopyAcreDelta * ECOSYSTEM_SERVICE_RATES.energy.ratePerCanopyAcre),
          habitat: Math.round(canopyAcreDelta * ECOSYSTEM_SERVICE_RATES.habitat.ratePerCanopyAcre),
        },
      },
      sustainabilityValue,
      totalImpact: {
        greenInfraOnly: totalImpact,
        withMarketAppreciation: totalWithMarket,
      },
      methodology: {
        version: METHODOLOGY_VERSION,
        canopyConversion: '1 Soil Score point ≈ 0.5% canopy coverage change',
        valueModel: 'Netusil et al. 2014 (0.17% property value per 1% canopy, 500m buffer)',
        diminishingReturns: 'Cho et al. 2020 (reduced marginal returns above 40% canopy)',
        ecoServices: `Atlanta iTree Eco 2014 + EPA SC-GHG 2023 ($190/t CO2) + peer-reviewed rates ($${ECO_SERVICE_TOTAL_PER_ACRE}/canopy-acre)`,
        marketBaseline: `FHFA HPI Atlanta metro long-term avg (${(baseAppreciationRate * 100).toFixed(1)}% annual)`,
        disclaimer: 'Projections use peer-reviewed coefficients with linear interpolation. '
          + 'Actual results depend on species, placement, maturity, soil conditions, '
          + 'microclimate, and market factors. This is a research-backed directional estimate.',
      },
    };
  }

  /**
   * Canopy value curve with diminishing returns
   *
   * Based on Cho et al. 2020 and national meta-analysis:
   *  - Linear 0.17% per 1% canopy up to 30%
   *  - Reduced marginal return 30-40%
   *  - Strongly diminished above 40%
   *
   * @returns {number} fractional property value change (e.g., 0.034 = 3.4%)
   */
  static _canopyValueCurve(fromPct, toPct) {
    const coeff = CANOPY_VALUE_COEFFICIENTS;

    function cumulativeValue(canopyPct) {
      if (canopyPct <= 0) return 0;

      let value = 0;
      const step = 0.5; // Integrate in 0.5% steps

      for (let c = step; c <= canopyPct; c += step) {
        let marginal = coeff.marginalValuePer1Pct;

        if (c > coeff.diminishingReturnsStart) {
          // Exponential decay above 40%
          const excess = c - coeff.diminishingReturnsStart;
          marginal *= Math.exp(-0.04 * excess);
        } else if (c > coeff.optimalCanopyPct) {
          // Linear taper 30-40%
          const t = (c - coeff.optimalCanopyPct) /
            (coeff.diminishingReturnsStart - coeff.optimalCanopyPct);
          marginal *= (1 - 0.3 * t);
        }

        value += marginal * step;
      }

      return Math.min(value, coeff.maxPremiumPct);
    }

    const fromValue = cumulativeValue(fromPct);
    const toValue = cumulativeValue(toPct);

    return (toValue - fromValue) / 100; // Convert to fractional
  }
}


// ============================================================
// SUSTAINABILITY VALUE MODULE
// ============================================================

class SustainabilityValue {
  /**
   * Calculate building-level sustainability value from canopy changes
   *
   * Covers:
   *  - HVAC savings (heating/cooling cost reduction)
   *  - Decreased maintenance (stormwater infrastructure, pavement)
   *  - Air quality health benefits
   *  - Peak demand / grid resilience value
   */
  static calculate(params) {
    const {
      canopyAcreDelta,
      lotAcres,
      currentCanopyPct,
      newCanopyPct,
      timelineYears = 10,
    } = params;

    const m = SUSTAINABILITY_METRICS;

    // HVAC Savings
    const annualCoolingSavingsKwh = Math.round(canopyAcreDelta * m.hvac.coolingKwhPerCanopyAcre);
    const annualCoolingSavings = Math.round(annualCoolingSavingsKwh * m.hvac.electricityRate);
    const annualHeatingSavingsTherm = Math.round(canopyAcreDelta * m.hvac.heatingThermSavingsPerAcre);
    const annualHeatingSavings = Math.round(annualHeatingSavingsTherm * m.hvac.gasRate);
    const totalHvacAnnual = annualCoolingSavings + annualHeatingSavings;

    // Maintenance savings
    const stormwaterMaintSavings = Math.round(
      lotAcres * 1200 * m.maintenance.stormwaterInfraReduction * (canopyAcreDelta > 0 ? 1 : -1)
    );
    const pavementSavings = Math.round(
      lotAcres * 800 * m.maintenance.pavementLifeExtension * (canopyAcreDelta > 0 ? 1 : -1)
    );
    const erosionControl = Math.round(Math.abs(canopyAcreDelta) * m.maintenance.erosionControlValue);
    const totalMaintenanceAnnual = stormwaterMaintSavings + pavementSavings +
      (canopyAcreDelta > 0 ? erosionControl : -erosionControl);

    // Air quality / health value
    const canopyChangePctPoints = newCanopyPct - currentCanopyPct;

    // Peak demand reduction
    const estimatedTrees = Math.max(0, Math.round(canopyAcreDelta * 40)); // ~40 trees per canopy acre
    const peakDemandReduction = Math.round(estimatedTrees * m.hvac.peakDemandReductionKw * 100) / 100;

    return {
      hvac: {
        annualCoolingSavingsKwh,
        annualCoolingSavingsDollars: annualCoolingSavings,
        annualHeatingSavingsTherm: annualHeatingSavingsTherm,
        annualHeatingSavingsDollars: annualHeatingSavings,
        totalAnnual: totalHvacAnnual,
        cumulativeSavings: totalHvacAnnual * timelineYears,
        source: 'McPherson 2003; Akbari et al. 2001; GA Power / Atlanta Gas Light rates',
      },
      maintenance: {
        stormwaterInfraSavings: stormwaterMaintSavings,
        pavementLifeSavings: pavementSavings,
        erosionControlValue: canopyAcreDelta > 0 ? erosionControl : -erosionControl,
        totalAnnual: totalMaintenanceAnnual,
        cumulativeSavings: totalMaintenanceAnnual * timelineYears,
      },
      healthBenefits: {
        peakDemandReductionKw: peakDemandReduction,
        estimatedTreesAdded: estimatedTrees,
        source: 'Nowak et al. 2014 (air quality via pollutant removal)',
      },
      totalAnnual: totalHvacAnnual + totalMaintenanceAnnual,
      totalOverPeriod: (totalHvacAnnual + totalMaintenanceAnnual) * timelineYears,
    };
  }
}


// ============================================================
// CERTIFICATION PATHWAY MODULE
// ============================================================

class CertificationPathway {
  /**
   * Assess green building certification potential for a property
   *
   * @param {Object} siteData — site characteristics
   * @param {string[]} targetCertifications — ['leed', 'breeam', 'well', 'greenGlobes']
   * @returns {Object} pathway assessment with trackable metrics
   */
  static assess(siteData, targetCertifications = ['leed', 'breeam', 'well', 'greenGlobes']) {
    const results = {};

    for (const certKey of targetCertifications) {
      const cert = CERTIFICATIONS[certKey];
      if (!cert) continue;

      const credits = cert.greenInfraCredits || [];
      const assessment = credits.map(credit => {
        const status = CertificationPathway._assessCredit(credit, siteData);
        return {
          ...credit,
          status: status.status,        // 'achieved' | 'partial' | 'gap' | 'not_applicable'
          currentValue: status.currentValue,
          targetValue: status.targetValue,
          progressPct: status.progressPct,
          actions: status.actions,
        };
      });

      const achieved = assessment.filter(c => c.status === 'achieved');
      const partial = assessment.filter(c => c.status === 'partial');
      const gaps = assessment.filter(c => c.status === 'gap');

      // Estimate achievable level
      let achievableLevel = null;
      if (certKey === 'leed') {
        const greenInfraPoints = assessment.reduce((sum, c) => {
          if (c.status === 'achieved') return sum + (c.points || 0);
          if (c.status === 'partial') return sum + Math.round((c.points || 0) * (c.progressPct / 100));
          return sum;
        }, 0);
        achievableLevel = CertificationPathway._estimateLevel(cert.levels, greenInfraPoints, 'leed');
      }

      results[certKey] = {
        certification: cert.name,
        organization: cert.organization,
        credits: assessment,
        summary: {
          totalCreditsAssessed: assessment.length,
          achieved: achieved.length,
          partial: partial.length,
          gaps: gaps.length,
        },
        achievableLevel,
        prerequisites: assessment.filter(c => c.required).map(c => ({
          name: c.name,
          met: c.status === 'achieved',
        })),
      };
    }

    return results;
  }

  /**
   * Assess a single credit against site data
   */
  static _assessCredit(credit, siteData) {
    const result = {
      status: 'gap',
      currentValue: null,
      targetValue: null,
      progressPct: 0,
      actions: [],
    };

    // Canopy-based assessment
    if (credit.canopyRelevance === 'high' && siteData.canopyPct != null) {
      if (credit.id === 'SS-C5' || credit.id === 'SITE-2') {
        // Heat island / site development — canopy threshold
        const target = 50; // 50% hardscape shaded within 10yr
        const current = siteData.canopyPct;
        result.currentValue = `${current}% canopy`;
        result.targetValue = `${target}% hardscape shaded`;
        result.progressPct = Math.min(100, Math.round((current / target) * 100));
        result.status = result.progressPct >= 100 ? 'achieved' : result.progressPct >= 50 ? 'partial' : 'gap';
        if (result.status !== 'achieved') {
          result.actions.push(`Increase canopy coverage to shade ≥${target}% of hardscape`);
          result.actions.push('Consider strategic tree planting on south and west exposures');
        }
      } else if (credit.id === 'SS-C4' || credit.id === 'SITE-3') {
        // Rainwater management
        const giPresent = siteData.hasGreenInfrastructure || siteData.canopyPct > 25;
        result.currentValue = giPresent ? 'Green infrastructure present' : 'Limited GI';
        result.targetValue = 'Manage 85th percentile storm on-site';
        result.progressPct = giPresent ? 60 : 20;
        result.status = giPresent ? 'partial' : 'gap';
        if (!giPresent) {
          result.actions.push('Install bioswales, rain gardens, or permeable pavement');
          result.actions.push('Increase canopy to improve rainfall interception (35% rate)');
        }
      } else if (credit.id === 'LE-04') {
        // BREEAM Biodiversity Net Gain
        const bng = siteData.biodiversityNetGainPct || (siteData.canopyPct > 30 ? 12 : 5);
        result.currentValue = `${bng}% BNG`;
        result.targetValue = '10% Biodiversity Net Gain (minimum)';
        result.progressPct = Math.min(100, Math.round((bng / 10) * 100));
        result.status = bng >= 10 ? 'achieved' : 'partial';
        if (bng < 10) {
          result.actions.push(`Need ${10 - bng}% more biodiversity net gain`);
          result.actions.push('Add native species planting and habitat features');
        }
      } else if (credit.id === 'M07') {
        // WELL Biophilia II
        const hasPlantWall = siteData.plantWallPct >= 2;
        const hasPottedPlants = siteData.pottedPlantPct >= 1;
        result.currentValue = `Plant wall: ${siteData.plantWallPct || 0}%, Plants: ${siteData.pottedPlantPct || 0}%`;
        result.targetValue = 'Plant wall ≥2% floor area; Potted plants ≥1% floor area';
        result.progressPct = ((hasPlantWall ? 50 : 0) + (hasPottedPlants ? 50 : 0));
        result.status = hasPlantWall && hasPottedPlants ? 'achieved' : result.progressPct > 0 ? 'partial' : 'gap';
        if (!hasPlantWall) result.actions.push('Install plant wall covering ≥2% of floor area per floor');
        if (!hasPottedPlants) result.actions.push('Add potted plants covering ≥1% of floor area per floor');
      } else {
        // Generic canopy-relevant credit
        const threshold = 30;
        result.currentValue = `${siteData.canopyPct}% canopy`;
        result.targetValue = `≥${threshold}% recommended`;
        result.progressPct = Math.min(100, Math.round((siteData.canopyPct / threshold) * 100));
        result.status = result.progressPct >= 100 ? 'achieved' : result.progressPct >= 50 ? 'partial' : 'gap';
      }
    }

    // Prerequisites
    if (credit.required && credit.type === 'prerequisite') {
      if (credit.id === 'SS-P1') {
        result.currentValue = siteData.hasErosionPlan ? 'Plan in place' : 'No plan';
        result.targetValue = 'Erosion & sediment control plan required';
        result.status = siteData.hasErosionPlan ? 'achieved' : 'gap';
        result.progressPct = siteData.hasErosionPlan ? 100 : 0;
        if (!siteData.hasErosionPlan) {
          result.actions.push('Develop Construction Activity Pollution Prevention plan');
        }
      } else if (credit.id === 'M02') {
        result.currentValue = siteData.hasBiophiliaPlan ? 'Plan complete' : 'No plan';
        result.targetValue = 'Biophilia plan required for WELL certification';
        result.status = siteData.hasBiophiliaPlan ? 'achieved' : 'gap';
        result.progressPct = siteData.hasBiophiliaPlan ? 100 : 0;
        if (!siteData.hasBiophiliaPlan) {
          result.actions.push('Develop biophilia plan incorporating environmental elements');
        }
      }
    }

    return result;
  }

  /**
   * Estimate achievable certification level
   * (Green infrastructure credits are a subset — actual level depends on all categories)
   */
  static _estimateLevel(levels, greenInfraPoints, certType) {
    if (certType === 'leed') {
      // Green infra credits are roughly 8-26 of 110 total points
      // Estimate what level is reachable if other categories are moderate
      const estimatedOtherPoints = 35; // Conservative baseline from other categories
      const estimatedTotal = estimatedOtherPoints + greenInfraPoints;

      for (let i = levels.length - 1; i >= 0; i--) {
        if (estimatedTotal >= levels[i].min) {
          return {
            level: levels[i].name,
            estimatedTotal,
            greenInfraContribution: greenInfraPoints,
            note: `Estimated with ${estimatedOtherPoints} points from non-site categories (conservative)`,
          };
        }
      }
    }

    return { level: 'Below minimum', note: 'Additional credits needed across all categories' };
  }

  /**
   * Generate a trackable metrics checklist for a specific certification
   */
  static generateChecklist(certKey, siteData) {
    const cert = CERTIFICATIONS[certKey];
    if (!cert) return null;

    const assessment = CertificationPathway.assess(siteData, [certKey]);
    const credits = assessment[certKey]?.credits || [];

    return {
      certification: cert.name,
      organization: cert.organization,
      checklist: credits.map(credit => ({
        id: credit.id,
        name: credit.name,
        category: credit.category,
        status: credit.status,
        progressPct: credit.progressPct,
        required: credit.required || false,
        points: credit.points || credit.credits || 0,
        currentValue: credit.currentValue,
        targetValue: credit.targetValue,
        actions: credit.actions,
        metrics: credit.metrics,
      })),
      nextSteps: credits
        .filter(c => c.status !== 'achieved')
        .flatMap(c => c.actions)
        .filter(Boolean),
    };
  }
}


// ============================================================
// METHODOLOGY EXPORT
// ============================================================

class Methodology {
  /**
   * Generate a sharable methodology document
   * Returns structured data suitable for PDF/HTML/Markdown export
   */
  static generate() {
    return {
      title: 'TerraValue Calculation Methodology',
      version: METHODOLOGY_VERSION,
      lastUpdated: new Date().toISOString().split('T')[0],
      sections: [
        {
          heading: 'Property Valuation',
          content: [
            'TerraValue cross-references property values from multiple sources using a confidence-weighted composite:',
            '1. Tax assessor data from municipal/county ArcGIS endpoints (primary source)',
            '2. Redfin Automated Valuation Model estimates (secondary)',
            '3. Pluggable third-party APIs (Zillow, CoreLogic, ATTOM — configurable)',
            '',
            'For Georgia properties, assessed values are converted to estimated market value using the statutory 40% assessment ratio (O.C.G.A. § 48-5-7).',
          ],
        },
        {
          heading: 'Ecosystem Service Calculations',
          content: [
            'Six ecosystem services are calculated per parcel based on canopy-acre coverage:',
            '',
            'Carbon Sequestration: 2.6 tonnes CO2/canopy-acre/yr (Atlanta iTree Eco 2014) × $190/tonne (EPA Social Cost of Greenhouse Gases, 2023, Table ES-1, 2% near-term discount rate) = $494/canopy-acre/yr',
            '',
            'Stormwater Management: $520/canopy-acre/yr — benefit transfer from USDA Center for Urban Forestry Research / iTree Eco urban canopy valuation literature',
            '',
            'Air Quality Improvement: $418/canopy-acre/yr — total pollutant removal value (PM2.5, O3, NO2, SO2) from Nowak et al. 2014, weighted by BenMAP-CE health valuations ($117,106/ton PM2.5 national median)',
            '',
            'Energy Savings: 1,800 kWh avoided per canopy acre per year (McPherson 2003; Atlanta iTree Eco) × $0.14/kWh (GA Power residential avg) = $252/canopy-acre/yr',
            '',
            'Habitat Value: $320/canopy-acre/yr — benefit transfer from ecosystem services valuation literature (Troy & Wilson 2006; Brander & Koetse 2011, approximate)',
            '',
            'Property Value Premium: ~7% premium for mature canopy coverage, scaled linearly to 30% optimal canopy, capped at 12% (Kovacs et al. 2022; Netusil et al. 2014)',
          ],
        },
        {
          heading: 'Land Appreciation Projections',
          content: [
            'Score-to-value conversion methodology:',
            '',
            '1. Soil Score change → canopy coverage change: 1 Soil Score point ≈ 0.5% canopy coverage',
            '2. Canopy change → property value: 0.17% property value increase per 1% canopy increase within 500m buffer (Netusil et al. 2014, national meta-analysis)',
            '3. Diminishing returns: Marginal value tapers above 30% canopy (Siriwardena et al. 2016) and decays exponentially above 40% (Cho et al. 2020)',
            '4. Market baseline: FHFA House Price Index for Atlanta metro (3.5% annual, long-term average)',
            '',
            'The model caps maximum canopy premium at 12% of property value based on empirical ceilings from meta-analyses.',
          ],
        },
        {
          heading: 'Building Sustainability Value',
          content: [
            'HVAC Savings: 1,800 kWh cooling avoided per canopy acre (McPherson 2003) × $0.14/kWh (GA Power residential avg). Heating: 12 therms saved per canopy acre from wind reduction × $1.20/therm (Atlanta Gas Light avg). Peak demand: 0.7 kW reduction per shade tree (Sacramento Municipal Utility District study).',
            '',
            'Maintenance: 15% reduction in stormwater infrastructure maintenance from canopy interception. 20% pavement life extension from shade (reduced thermal cycling). $85/acre/yr erosion control value.',
            '',
            'Health Benefits: Air quality improvements from PM2.5, O3, NO2, SO2 removal (Nowak et al. 2014). Peak demand reduction from shade trees (Sacramento Municipal Utility District study). Maintenance cost estimates are approximate industry benchmarks.',
          ],
        },
        {
          heading: 'Certification Pathways',
          content: [
            'TerraValue tracks progress toward four major green building certifications:',
            '',
            'LEED v4.1 (USGBC): 110 points total. Green infrastructure contributes to Sustainable Sites (SS) and Energy & Atmosphere (EA) credits. Levels: Certified (40+), Silver (50+), Gold (60+), Platinum (80+).',
            '',
            'BREEAM (BRE Group): Percentage-based. Land Use & Ecology category with 5 credit areas including 10% Biodiversity Net Gain requirement (UK law since Feb 2024). Levels: Pass (30%), Good (45%), Very Good (55%), Excellent (70%), Outstanding (85%).',
            '',
            'WELL v2 (IWBI): 100 points across 10 concepts. Biophilia I (qualitative) is a prerequisite. Biophilia II requires plant walls ≥2% floor area and potted plants ≥1% floor area. Levels: Bronze (40+), Silver (50+), Gold (60+), Platinum (80+).',
            '',
            'Green Globes (GBI): 1,000 points across 7 categories. Site category covers selection, ecological enhancement, and stormwater. 35% minimum for certification. Levels: 1 Globe (35%), 2 Globes (55%), 3 Globes (70%), 4 Globes (85%).',
          ],
        },
        {
          heading: 'Land Valuation (Institutional-Grade)',
          content: [
            'TerraValue includes a three-approach land valuation module drawing from institutional methodology:',
            '',
            'Sales Comparison Approach: Market-derived value from comparable transactions with paired-sales adjustments for location, size, age, condition, canopy coverage, and time. Weighting inversely proportional to total adjustment magnitude. Consistent with Berkshire Hathaway HomeServices CMA methodology.',
            '',
            'Income Capitalization Approach: Dual method — (A) Direct Capitalization using NOI/Cap Rate, and (B) Discounted Cash Flow with explicit year-by-year projection, market rent growth, expense escalation, and terminal cap reversion. Cap rate benchmarks from JLL and CBRE 2024 surveys by property type.',
            '',
            'Cost Approach: Land value (direct sales or extraction) + Replacement Cost New (RS Means 2024 Southeast) - Depreciation (physical via age-life method per Marshall Valuation Service, functional obsolescence, external/economic obsolescence). Ecosystem land premium added per Netusil/Kovacs.',
            '',
            'Highest and Best Use (HBU): Four-test analysis per Appraisal Institute standards — legally permissible, physically possible, financially feasible, maximally productive. Residual land value method for feasibility testing. Ecosystem services value capitalized and weighed against development returns.',
            '',
            'Reconciliation: Confidence-weighted average across all three approaches. Weights assigned by property type, income-producing status, and data quality — consistent with JLL Valuation Advisory practice and USPAP Standard 1-6.',
          ],
        },
        {
          heading: 'Limitations & Disclaimers',
          content: [
            'All projections use peer-reviewed coefficients with linear interpolation between data points. Actual ecosystem service values and property impacts depend on tree species, age, placement, soil conditions, microclimate, regional market dynamics, and maintenance quality.',
            '',
            'Property value projections are directional estimates based on statistical averages from large-sample hedonic studies. Individual property outcomes will vary. This tool does not constitute a property appraisal or financial advice.',
            '',
            'Certification pathway assessments cover green infrastructure-related credits only and do not represent a complete certification evaluation. Full certification requires assessment across all credit categories by an accredited assessor.',
          ],
        },
      ],
      references: [
        'Akbari, H. et al. (2001). Cool surfaces and shade trees to reduce energy use. Solar Energy, 70(3), 295-310.',
        'Cho, S.H. et al. (2020). Varying Effects of Urban Tree Canopies on Residential Property Values. Sustainability, 12(10), 4331.',
        'EPA (2023). Social Cost of Greenhouse Gases. Technical Support Document.',
        'Kovacs, K.F. et al. (2022). Tree cover and property values in the United States: A national meta-analysis. Ecological Economics, 197, 107424.',
        'McPherson, E.G. (2003). Potential energy savings in buildings by an urban tree planting programme in California. Urban Forestry & Urban Greening, 2(2), 73-86.',
        'Netusil, N.R. et al. (2014). The implicit value of tree cover in the U.S.: A meta-analysis. Ecological Economics (2016), Vol 128, 68-76. DOI: 10.1016/j.ecolecon.2016.04.018',
        'Nowak, D.J. et al. (2014). Tree and forest effects on air quality and human health in the United States. Environmental Pollution, 193, 119-129.',
        'Siriwardena, S.D. et al. (2016). Do hedonic models need canopy? Journal of Real Estate Finance and Economics, 53(2), 212-236.',
        'Troy, A. & Wilson, M.A. (2006). Mapping ecosystem services. Ecological Economics, 57(2), 203-218.',
      ],
    };
  }
}


// ============================================================
// LAND VALUATION MODULE (Institutional-Grade)
// ============================================================

class LandValuation {

  // ─── SALES COMPARISON APPROACH ──────────────────────────────
  /**
   * Sales Comparison Approach (Market Approach)
   *
   * Primary method used by Berkshire Hathaway HomeServices CMA
   * and JLL for most residential/commercial valuations.
   *
   * USPAP Standard 1-4(a): "When applicable, the appraiser must
   * develop a sales comparison approach to value."
   */
  static salesComparison(subject, comparables = []) {
    let usingSyntheticComps = false;
    if (!comparables.length) {
      // Generate synthetic comparables from subject data (demo mode)
      comparables = LandValuation._generateSyntheticComps(subject);
      usingSyntheticComps = true;
    }

    const adjustedComps = comparables.map((comp, idx) => {
      let adjustmentPct = 0;
      const adjustments = [];
      const adj = LAND_VALUATION_CONSTANTS.comparableAdjustments;

      // Location adjustment
      if (comp.locationQuality && subject.locationQuality) {
        const locDiff = comp.locationQuality - subject.locationQuality;
        if (locDiff > 0) {
          adjustmentPct += adj.locationSuperior * Math.abs(locDiff);
          adjustments.push({ factor: 'Location (superior comp)', pct: adj.locationSuperior * locDiff });
        } else if (locDiff < 0) {
          adjustmentPct += adj.locationInferior * Math.abs(locDiff);
          adjustments.push({ factor: 'Location (inferior comp)', pct: adj.locationInferior * Math.abs(locDiff) });
        }
      }

      // Size adjustment (per 10% difference)
      if (comp.lotSizeSqFt && subject.lotSizeSqFt) {
        const sizeDiffPct = (comp.lotSizeSqFt - subject.lotSizeSqFt) / subject.lotSizeSqFt;
        const sizeAdj = sizeDiffPct > 0
          ? adj.sizeLarger10pct * (sizeDiffPct / 0.10)
          : adj.sizeSmaller10pct * (Math.abs(sizeDiffPct) / 0.10);
        adjustmentPct += sizeAdj;
        if (Math.abs(sizeAdj) > 0.005) {
          adjustments.push({ factor: 'Size', pct: sizeAdj });
        }
      }

      // Age adjustment (per 5 years)
      if (comp.yearBuilt && subject.yearBuilt) {
        const ageDiff = comp.yearBuilt - subject.yearBuilt; // positive = newer comp
        const ageAdj = ageDiff > 0
          ? adj.ageNewer5yr * (ageDiff / 5)
          : adj.ageOlder5yr * (Math.abs(ageDiff) / 5);
        adjustmentPct += ageAdj;
        if (Math.abs(ageAdj) > 0.005) {
          adjustments.push({ factor: 'Age', pct: ageAdj });
        }
      }

      // Condition adjustment
      if (comp.condition && subject.condition) {
        const condDiff = comp.condition - subject.condition; // higher = better
        if (condDiff > 0) {
          adjustmentPct += adj.conditionSuperior * condDiff;
          adjustments.push({ factor: 'Condition (superior comp)', pct: adj.conditionSuperior * condDiff });
        } else if (condDiff < 0) {
          adjustmentPct += adj.conditionInferior * Math.abs(condDiff);
          adjustments.push({ factor: 'Condition (inferior comp)', pct: adj.conditionInferior * Math.abs(condDiff) });
        }
      }

      // Canopy / ecosystem premium adjustment
      if (comp.canopyPct != null && subject.canopyPct != null) {
        const canopyDiff = comp.canopyPct - subject.canopyPct;
        const canopyAdj = adj.canopyPremiumPer10pct * (canopyDiff / 10);
        adjustmentPct += canopyAdj;
        if (Math.abs(canopyAdj) > 0.003) {
          adjustments.push({ factor: 'Canopy coverage (Netusil et al.)', pct: canopyAdj });
        }
      }

      // Time adjustment (market conditions since sale)
      let timeAdj = 0;
      if (comp.saleDate) {
        const monthsSinceSale = Math.max(0,
          (Date.now() - new Date(comp.saleDate).getTime()) / (1000 * 60 * 60 * 24 * 30.44)
        );
        const annualAppreciation = LAND_VALUATION_CONSTANTS.appreciation.atlanta['1yr'];
        timeAdj = annualAppreciation * (monthsSinceSale / 12);
        if (timeAdj > 0.005) {
          adjustments.push({ factor: 'Market conditions (time)', pct: timeAdj });
        }
      }

      const totalAdjPct = adjustmentPct + timeAdj;
      const adjustedPrice = Math.round(comp.salePrice * (1 + totalAdjPct));

      return {
        address: comp.address || `Comparable ${idx + 1}`,
        salePrice: comp.salePrice,
        saleDate: comp.saleDate,
        adjustedPrice,
        totalAdjustmentPct: Math.round(totalAdjPct * 10000) / 100,
        adjustments,
        pricePerSqFt: comp.buildingSqFt ? Math.round(comp.salePrice / comp.buildingSqFt) : null,
        adjustedPricePerSqFt: comp.buildingSqFt ? Math.round(adjustedPrice / comp.buildingSqFt) : null,
        weight: 1.0, // Will be recalculated based on similarity
        ...(comp.isSynthetic && { isSynthetic: true }),
      };
    });

    // Weight by similarity (inverse of total adjustment magnitude)
    const totalAbsAdj = adjustedComps.reduce((s, c) => s + Math.abs(c.totalAdjustmentPct), 0);
    if (totalAbsAdj > 0) {
      adjustedComps.forEach(c => {
        c.weight = Math.round((1 - Math.abs(c.totalAdjustmentPct) / (totalAbsAdj || 1)) * 100) / 100;
      });
      const totalWeight = adjustedComps.reduce((s, c) => s + c.weight, 0);
      adjustedComps.forEach(c => { c.weight = Math.round((c.weight / (totalWeight || 1)) * 100) / 100; });
    }

    // Weighted average
    const weightedValue = Math.round(
      adjustedComps.reduce((sum, c) => sum + c.adjustedPrice * c.weight, 0)
    );

    // Confidence based on adjustment spread
    const maxAdj = Math.max(...adjustedComps.map(c => Math.abs(c.totalAdjustmentPct)));
    const confidence = maxAdj < 5 ? 'high' : maxAdj < 15 ? 'moderate' : 'low';

    return {
      approach: 'Sales Comparison',
      indicatedValue: weightedValue,
      usingSyntheticComps,
      adjustedComparables: adjustedComps,
      statistics: {
        low: Math.min(...adjustedComps.map(c => c.adjustedPrice)),
        high: Math.max(...adjustedComps.map(c => c.adjustedPrice)),
        mean: Math.round(adjustedComps.reduce((s, c) => s + c.adjustedPrice, 0) / adjustedComps.length),
        median: LandValuation._median(adjustedComps.map(c => c.adjustedPrice)),
      },
      confidence: usingSyntheticComps ? 'demo' : confidence,
      methodology: 'USPAP-compliant paired sales analysis with market-derived adjustments. ' +
        'Canopy premium per Netusil et al. 2014. Time adjustments per FHFA HPI (long-term avg).',
      ...(usingSyntheticComps && {
        syntheticDisclaimer: 'Comparables were generated from subject property data for demonstration purposes. '
          + 'These are NOT real transactions. For accurate valuation, provide actual comparable sales.',
      }),
    };
  }


  // ─── INCOME CAPITALIZATION APPROACH ─────────────────────────
  /**
   * Income Capitalization Approach
   *
   * Two methods:
   *  A. Direct Capitalization — NOI / Cap Rate = Value
   *  B. Discounted Cash Flow (DCF) — PV of projected cash flows + reversion
   */
  static incomeCapitalization(params) {
    const {
      propertyType = 'singleFamily',
      grossPotentialIncome,
      vacancyRate = 0.05,
      operatingExpenses,
      operatingExpenseRatio,
      capRate: userCapRate,
      discountRate: userDiscountRate,
      holdingPeriodYears = 10,
      annualRentGrowth = 0.03,
      annualExpenseGrowth = 0.025,
      terminalCapRate,
      propertyValue,
    } = params;

    const capRateData = LAND_VALUATION_CONSTANTS.capRates[propertyType] ||
      LAND_VALUATION_CONSTANTS.capRates.singleFamily;
    const discRateData = LAND_VALUATION_CONSTANTS.discountRates[propertyType] ||
      LAND_VALUATION_CONSTANTS.discountRates.singleFamily;

    const capRate = userCapRate || capRateData.mid;
    const discountRate = userDiscountRate || discRateData.mid;
    const termCap = terminalCapRate || (capRate + 0.005); // +50bps for reversion

    // Effective Gross Income
    const egi = grossPotentialIncome * (1 - vacancyRate);

    // Operating Expenses
    const opex = operatingExpenses || (egi * (operatingExpenseRatio || 0.35));

    // Net Operating Income (Year 1)
    const noi = egi - opex;

    // ── A. Direct Capitalization ──
    const directCapValue = Math.round(noi / capRate);

    // Implied cap rate (if property value is known)
    const impliedCapRate = propertyValue ? Math.round((noi / propertyValue) * 10000) / 10000 : null;

    // ── B. DCF Analysis ──
    const cashFlows = [];
    let cumulativeNOI = 0;

    for (let yr = 1; yr <= holdingPeriodYears; yr++) {
      const yearGPI = grossPotentialIncome * Math.pow(1 + annualRentGrowth, yr - 1);
      const yearEGI = yearGPI * (1 - vacancyRate);
      const yearOpex = opex * Math.pow(1 + annualExpenseGrowth, yr - 1);
      const yearNOI = yearEGI - yearOpex;
      const pvFactor = 1 / Math.pow(1 + discountRate, yr);
      const pvCashFlow = yearNOI * pvFactor;

      cumulativeNOI += yearNOI;
      cashFlows.push({
        year: yr,
        gpi: Math.round(yearGPI),
        egi: Math.round(yearEGI),
        opex: Math.round(yearOpex),
        noi: Math.round(yearNOI),
        pvFactor: Math.round(pvFactor * 10000) / 10000,
        pvCashFlow: Math.round(pvCashFlow),
      });
    }

    // Reversion (terminal value at end of holding period)
    const terminalYearNOI = cashFlows[cashFlows.length - 1].noi * (1 + annualRentGrowth);
    const reversionValue = Math.round(terminalYearNOI / termCap);
    const pvReversion = Math.round(reversionValue / Math.pow(1 + discountRate, holdingPeriodYears));
    const pvCashFlowTotal = cashFlows.reduce((sum, cf) => sum + cf.pvCashFlow, 0);
    const dcfValue = pvCashFlowTotal + pvReversion;

    // Key ratios
    const debtCoverageRatio = noi / (propertyValue ? propertyValue * 0.065 : directCapValue * 0.065);
    const grossRentMultiplier = directCapValue / grossPotentialIncome;
    const netIncomeMultiplier = directCapValue / noi;
    const operatingExpenseRatioCalc = opex / egi;

    return {
      approach: 'Income Capitalization',
      directCapitalization: {
        indicatedValue: directCapValue,
        noi: Math.round(noi),
        capRate,
        capRateRange: capRateData,
        impliedCapRate,
      },
      dcfAnalysis: {
        indicatedValue: dcfValue,
        discountRate,
        holdingPeriodYears,
        annualRentGrowth,
        annualExpenseGrowth,
        terminalCapRate: termCap,
        pvCashFlows: pvCashFlowTotal,
        reversionValue,
        pvReversion,
        cashFlows,
      },
      incomeMetrics: {
        grossPotentialIncome: Math.round(grossPotentialIncome),
        effectiveGrossIncome: Math.round(egi),
        operatingExpenses: Math.round(opex),
        netOperatingIncome: Math.round(noi),
        operatingExpenseRatio: Math.round(operatingExpenseRatioCalc * 1000) / 1000,
        grossRentMultiplier: Math.round(grossRentMultiplier * 100) / 100,
        netIncomeMultiplier: Math.round(netIncomeMultiplier * 100) / 100,
        debtCoverageRatio: Math.round(debtCoverageRatio * 100) / 100,
      },
      methodology: 'USPAP Standards 1 & 2. Direct cap per Appraisal Institute methodology. ' +
        'DCF with explicit cash flow projection, market-derived discount rates, ' +
        'and terminal cap reversion. Cap rate benchmarks from JLL/CBRE 2024 surveys.',
    };
  }


  // ─── COST APPROACH ──────────────────────────────────────────
  /**
   * Cost Approach (Summation Method)
   *
   * Value = Land Value + Replacement Cost New - Depreciation
   */
  static costApproach(params) {
    const {
      landValuePerSqFt,
      lotSizeSqFt,
      buildingSqFt = 0,
      propertyType = 'residential',
      constructionQuality = 'mid',
      effectiveAge = 0,
      functionalObsolescence = 'noDeficiency',
      externalObsolescence = 'none',
      siteImprovements = 0,
      assessedValue,
      state = 'GA',
      canopyPct = 0,
    } = params;

    const depr = LAND_VALUATION_CONSTANTS.depreciation;
    const costs = LAND_VALUATION_CONSTANTS.constructionCosts[propertyType] ||
      LAND_VALUATION_CONSTANTS.constructionCosts.residential;

    // Land Value
    let landValue;
    if (landValuePerSqFt) {
      landValue = Math.round(landValuePerSqFt * lotSizeSqFt);
    } else if (assessedValue && state === 'GA') {
      // Extraction: estimate land as portion of total value
      const marketValue = assessedValue / LAND_VALUATION_CONSTANTS.georgia.assessmentRatio;
      const ratios = LAND_VALUATION_CONSTANTS.landToValueRatio[
        propertyType === 'residential' ? 'singleFamily' : propertyType
      ] || LAND_VALUATION_CONSTANTS.landToValueRatio.singleFamily;
      landValue = Math.round(marketValue * ratios.mid);
    } else {
      landValue = Math.round(lotSizeSqFt * 5); // Fallback: $5/sqft default
    }

    // Replacement Cost New (RCN)
    const costPerSqFt = costs.perSqFt[constructionQuality] || costs.perSqFt.mid;
    const replacementCostNew = Math.round(buildingSqFt * costPerSqFt);

    // Physical Depreciation (age-life method)
    const schedule = depr.physical[propertyType] || depr.physical.residential;
    const physicalDepreciationPct = Math.min(
      1 - schedule.residualPct,
      effectiveAge / schedule.effectiveLife
    );
    const physicalDepreciation = Math.round(replacementCostNew * physicalDepreciationPct);

    // Functional Obsolescence
    const funcObsPct = depr.functional[functionalObsolescence] || 0;
    const functionalDepreciation = Math.round(replacementCostNew * funcObsPct);

    // External (Economic) Obsolescence
    const extObsPct = depr.external[externalObsolescence] || 0;
    const externalDepreciation = Math.round(replacementCostNew * extObsPct);

    // Total Depreciation
    const totalDepreciation = physicalDepreciation + functionalDepreciation + externalDepreciation;
    const depreciatedImprovementValue = Math.max(0, replacementCostNew - totalDepreciation);

    // Ecosystem premium on land value
    const eco = LAND_VALUATION_CONSTANTS.ecosystemPremium;
    const canopyPremiumPct = Math.min(eco.maxPremium,
      canopyPct * eco.canopyValuePer1Pct
    );
    const ecosystemLandPremium = Math.round(landValue * canopyPremiumPct);

    // Total indicated value
    const indicatedValue = landValue + depreciatedImprovementValue + siteImprovements + ecosystemLandPremium;

    return {
      approach: 'Cost',
      indicatedValue,
      landValue: {
        value: landValue,
        perSqFt: Math.round((landValue / lotSizeSqFt) * 100) / 100,
        ecosystemPremium: ecosystemLandPremium,
        ecosystemPremiumPct: Math.round(canopyPremiumPct * 10000) / 100,
        method: landValuePerSqFt ? 'Direct land sales' : 'Extraction from assessed value',
      },
      improvements: {
        replacementCostNew,
        costPerSqFt,
        buildingSqFt,
        depreciation: {
          physical: { amount: physicalDepreciation, pct: Math.round(physicalDepreciationPct * 100) },
          functional: { amount: functionalDepreciation, pct: Math.round(funcObsPct * 100), level: functionalObsolescence },
          external: { amount: externalDepreciation, pct: Math.round(extObsPct * 100), level: externalObsolescence },
          total: totalDepreciation,
          totalPct: Math.round((totalDepreciation / (replacementCostNew || 1)) * 100),
        },
        depreciatedValue: depreciatedImprovementValue,
      },
      siteImprovements,
      methodology: 'USPAP-compliant cost approach. RCN from RS Means 2024 Southeast. ' +
        'Age-life depreciation per Marshall Valuation Service. ' +
        'Ecosystem land premium per Netusil/Kovacs (P&X TerraValue methodology).',
    };
  }


  // ─── HIGHEST AND BEST USE ANALYSIS ──────────────────────────
  /**
   * Highest and Best Use (HBU) Analysis
   *
   * The four tests (Appraisal Institute):
   *  1. Legally Permissible — zoning, deed restrictions, environmental
   *  2. Physically Possible — size, shape, topography, soils, access
   *  3. Financially Feasible — will it generate positive return?
   *  4. Maximally Productive — which feasible use produces highest value?
   */
  static highestAndBestUse(parcel) {
    const {
      lotSizeSqFt,
      zoning = 'R-1',
      currentUse = 'residential',
      zoningAllowedUses = [],
      frontage = null,
      topography = 'level',
      floodZone = 'X',
      utilities = true,
      roadAccess = true,
      canopyPct = 0,
      assessedValue = 0,
      state = 'GA',
      environmentalIssues = false,
    } = parcel;

    const lotAcres = lotSizeSqFt / 43560;
    const marketValue = state === 'GA' ? assessedValue / 0.40 : assessedValue;

    // 1. Legally Permissible
    const defaultUses = LandValuation._getZoningUses(zoning);
    const permissibleUses = zoningAllowedUses.length > 0 ? zoningAllowedUses : defaultUses;
    const legalConstraints = [];
    if (environmentalIssues) legalConstraints.push('Environmental remediation may be required');
    if (floodZone !== 'X' && floodZone !== 'C') legalConstraints.push(`FEMA Flood Zone ${floodZone} — flood insurance required, development restrictions apply`);

    // 2. Physically Possible
    const physicalConstraints = [];
    let physicalScore = 100;
    if (topography === 'steep') { physicalConstraints.push('Steep topography limits development options'); physicalScore -= 30; }
    else if (topography === 'moderate') { physicalConstraints.push('Moderate slope may increase site prep costs'); physicalScore -= 10; }
    if (!utilities) { physicalConstraints.push('No municipal utilities — well/septic required'); physicalScore -= 15; }
    if (!roadAccess) { physicalConstraints.push('Limited road access'); physicalScore -= 20; }
    if (lotSizeSqFt < 5000) { physicalConstraints.push('Small lot limits building footprint'); physicalScore -= 10; }

    // 3. Financially Feasible — estimate residual land value for each permissible use
    const feasibilityAnalysis = permissibleUses.map(use => {
      const metrics = LandValuation._estimateUseFeasibility(use, lotSizeSqFt, marketValue, canopyPct);
      return {
        use,
        ...metrics,
        feasible: metrics.residualLandValue > 0,
      };
    }).sort((a, b) => b.residualLandValue - a.residualLandValue);

    // 4. Maximally Productive
    const feasibleUses = feasibilityAnalysis.filter(u => u.feasible);
    const maximallyProductive = feasibleUses.length > 0 ? feasibleUses[0] : null;

    // Ecosystem value consideration
    const ecosystemAnnualValue = Math.round(
      (lotAcres * (canopyPct / 100)) * LAND_VALUATION_CONSTANTS.ecosystemPremium.annualServicesPerCanopyAcre
    );
    const ecosystemCapitalizedValue = ecosystemAnnualValue > 0
      ? Math.round(ecosystemAnnualValue / 0.05) // Capitalize at 5%
      : 0;

    return {
      analysis: 'Highest and Best Use',
      tests: {
        legallyPermissible: {
          zoning,
          permissibleUses,
          constraints: legalConstraints,
          pass: permissibleUses.length > 0,
        },
        physicallyPossible: {
          lotSizeSqFt,
          lotAcres: Math.round(lotAcres * 1000) / 1000,
          topography,
          floodZone,
          utilities,
          roadAccess,
          constraints: physicalConstraints,
          score: physicalScore,
          pass: physicalScore >= 50,
        },
        financiallyFeasible: {
          usesAnalyzed: feasibilityAnalysis,
          feasibleCount: feasibleUses.length,
          pass: feasibleUses.length > 0,
        },
        maximallyProductive: maximallyProductive ? {
          recommendedUse: maximallyProductive.use,
          estimatedValue: maximallyProductive.residualLandValue,
          annualIncome: maximallyProductive.estimatedAnnualIncome,
          pass: true,
        } : { pass: false, note: 'No financially feasible use identified' },
      },
      ecosystemConsideration: {
        currentAnnualValue: ecosystemAnnualValue,
        capitalizedValue: ecosystemCapitalizedValue,
        canopyPct,
        note: ecosystemAnnualValue > 0
          ? `Current canopy generates ~${new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:0}).format(ecosystemAnnualValue)}/yr in ecosystem services (capitalized value: ${new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:0}).format(ecosystemCapitalizedValue)}). HBU analysis should weigh this against development returns.`
          : 'No significant ecosystem services currently generated.',
      },
      conclusion: maximallyProductive
        ? `Highest and best use as ${currentUse === maximallyProductive.use ? 'improved (current use)' : maximallyProductive.use}. ${maximallyProductive.use !== currentUse ? 'Current use may not represent HBU.' : 'Current use appears consistent with HBU.'}`
        : 'Further analysis required — no clearly feasible alternative use identified.',
      methodology: 'Four-test HBU analysis per Appraisal Institute standards. ' +
        'Residual land value method for feasibility. ' +
        'Ecosystem services capitalized at 5% discount rate (P&X methodology).',
    };
  }


  // ─── RECONCILIATION ─────────────────────────────────────────
  /**
   * Three-Approach Reconciliation
   *
   * USPAP Standard 1-6: "The appraiser must reconcile the quality
   * and quantity of data analyzed within the approaches used and
   * the applicability of the approaches to arrive at a value conclusion."
   */
  static reconcile(params) {
    const {
      salesComparison,
      incomeCapitalization,
      costApproach,
      propertyType = 'singleFamily',
      isIncomeProducing = false,
      isNewConstruction = false,
      dataQuality = 'moderate',
    } = params;

    // Default weights by property type (JLL / institutional convention)
    let weights;
    if (propertyType === 'vacantLand') {
      weights = { salesComparison: 0.70, income: 0.20, cost: 0.10 };
    } else if (isIncomeProducing) {
      weights = { salesComparison: 0.30, income: 0.50, cost: 0.20 };
    } else if (isNewConstruction) {
      weights = { salesComparison: 0.35, income: 0.20, cost: 0.45 };
    } else {
      // Standard residential (Berkshire Hathaway CMA primary method)
      weights = { salesComparison: 0.55, income: 0.20, cost: 0.25 };
    }

    // Data quality adjustments
    if (dataQuality === 'strong') {
      weights.salesComparison = Math.min(0.80, weights.salesComparison + 0.10);
    } else if (dataQuality === 'limited') {
      weights.salesComparison = Math.max(0.20, weights.salesComparison - 0.15);
      weights.cost += 0.10;
    }

    // Normalize weights
    const totalW = weights.salesComparison + weights.income + weights.cost;
    Object.keys(weights).forEach(k => { weights[k] = Math.round((weights[k] / totalW) * 100) / 100; });

    // Get indicated values
    const scValue = salesComparison?.indicatedValue || 0;
    const incValue = incomeCapitalization?.dcfAnalysis?.indicatedValue ||
      incomeCapitalization?.directCapitalization?.indicatedValue || 0;
    const costValue = costApproach?.indicatedValue || 0;

    // Weighted reconciliation
    const reconciledValue = Math.round(
      scValue * weights.salesComparison +
      incValue * weights.income +
      costValue * weights.cost
    );

    // Value range (±5% for tight reconciliation, wider if approaches diverge)
    const values = [scValue, incValue, costValue].filter(v => v > 0);
    const spread = values.length > 1
      ? (Math.max(...values) - Math.min(...values)) / reconciledValue
      : 0;
    const rangePct = Math.max(0.05, Math.min(0.15, spread * 0.5));

    return {
      reconciledValue,
      valueRange: {
        low: Math.round(reconciledValue * (1 - rangePct)),
        high: Math.round(reconciledValue * (1 + rangePct)),
        confidenceInterval: Math.round((1 - rangePct * 2) * 100) + '%',
      },
      weights,
      approachValues: {
        salesComparison: scValue,
        incomeCapitalization: incValue,
        costApproach: costValue,
      },
      spread: {
        amount: values.length > 1 ? Math.max(...values) - Math.min(...values) : 0,
        pct: Math.round(spread * 10000) / 100,
        assessment: spread < 0.10 ? 'Tight — high confidence' :
          spread < 0.20 ? 'Moderate — reasonable confidence' : 'Wide — further analysis recommended',
      },
      methodology: 'Three-approach reconciliation per USPAP Standard 1-6. ' +
        'Weights assigned by property type and data quality, consistent with ' +
        'JLL Valuation Advisory and Appraisal Institute (MAI) practice.',
      disclaimer: 'This analysis is a research-backed estimate using institutional methodology. ' +
        'It does not constitute a certified appraisal under USPAP. ' +
        'For lending, litigation, or tax purposes, engage a licensed appraiser (MAI/SRA).',
    };
  }


  // ─── FULL VALUATION REPORT ──────────────────────────────────
  /**
   * Complete land valuation analysis — runs all approaches and reconciles
   *
   * This is the primary entry point for the Land Valuation tool.
   */
  static fullValuation(parcel, options = {}) {
    const {
      lotSizeSqFt,
      assessedValue,
      state = 'GA',
      canopyPct = 0,
      buildingSqFt = 0,
      yearBuilt,
      propertyType = 'singleFamily',
      comparables = [],
      grossPotentialIncome,
      condition = 3,
      locationQuality = 3,
      zoning = 'R-1',
    } = parcel;

    const marketValue = state === 'GA'
      ? assessedValue / LAND_VALUATION_CONSTANTS.georgia.assessmentRatio
      : assessedValue;

    const currentYear = new Date().getFullYear();
    const effectiveAge = yearBuilt ? currentYear - yearBuilt : 15;

    // 1. Sales Comparison
    const hasRealComps = comparables.length > 0;
    const sc = LandValuation.salesComparison(
      { lotSizeSqFt, canopyPct, yearBuilt, condition, locationQuality, buildingSqFt },
      hasRealComps ? comparables : []
    );

    // 2. Income Capitalization
    const hasRealIncome = !!grossPotentialIncome;
    const gpi = grossPotentialIncome || Math.round(marketValue * 0.065);
    const ic = LandValuation.incomeCapitalization({
      propertyType,
      grossPotentialIncome: gpi,
      vacancyRate: 0.05,
      operatingExpenseRatio: propertyType === 'singleFamily' ? 0.30 : 0.40,
      holdingPeriodYears: 10,
    });
    if (!hasRealIncome) {
      ic.incomeEstimated = true;
      ic.incomeDisclaimer = 'Gross potential income was estimated from market value (6.5% GRM). '
        + 'For accurate income analysis, provide actual rental income data.';
    }

    // 3. Cost Approach
    const ca = LandValuation.costApproach({
      lotSizeSqFt,
      buildingSqFt,
      propertyType: propertyType === 'singleFamily' ? 'residential' : propertyType,
      constructionQuality: 'mid',
      effectiveAge,
      assessedValue,
      state,
      canopyPct,
    });

    // 4. Highest and Best Use
    const hbu = LandValuation.highestAndBestUse({
      lotSizeSqFt,
      zoning,
      currentUse: propertyType,
      canopyPct,
      assessedValue,
      state,
    });

    // 5. Reconciliation
    const reconciled = LandValuation.reconcile({
      salesComparison: sc,
      incomeCapitalization: ic,
      costApproach: ca,
      propertyType,
      isIncomeProducing: !!grossPotentialIncome,
      isNewConstruction: effectiveAge < 3,
    });

    // 6. Ecosystem services overlay (cross-class dependency — preserved)
    const ecoServices = EcosystemServices.calculate({
      lotSizeSqFt,
      canopyPct,
      assessedValue,
      state,
    });

    // Key institutional metrics
    const lotAcres = lotSizeSqFt / 43560;
    const pricePerSqFt = Math.round((reconciled.reconciledValue / lotSizeSqFt) * 100) / 100;
    const pricePerAcre = Math.round(reconciled.reconciledValue / lotAcres);

    // Data quality assessment
    const dataQuality = {
      hasRealComparables: hasRealComps,
      hasRealIncome: hasRealIncome,
      syntheticDataUsed: !hasRealComps || !hasRealIncome,
      warnings: [
        ...(!hasRealComps ? ['Sales Comparison uses synthetic comparables — not real transactions'] : []),
        ...(!hasRealIncome ? ['Income approach uses estimated GPI (6.5% of market value) — not actual rental data'] : []),
      ],
    };

    return {
      report: 'P&X Land Valuation Report',
      version: METHODOLOGY_VERSION,
      generatedAt: new Date().toISOString(),
      dataQuality,
      subject: {
        lotSizeSqFt,
        lotAcres: Math.round(lotAcres * 1000) / 1000,
        buildingSqFt,
        yearBuilt,
        effectiveAge,
        propertyType,
        zoning,
        canopyPct,
        assessedValue,
        estimatedMarketValue: marketValue,
      },
      valuation: reconciled,
      approaches: {
        salesComparison: sc,
        incomeCapitalization: ic,
        costApproach: ca,
      },
      highestAndBestUse: hbu,
      ecosystemServices: {
        annualValue: ecoServices.totalAnnual,
        services: ecoServices.services,
        capitalizedValue: Math.round(ecoServices.totalAnnual / 0.05),
        valueAddPct: Math.round((ecoServices.totalAnnual / (reconciled.reconciledValue || 1)) * 10000) / 100,
      },
      keyMetrics: {
        reconciledValue: reconciled.reconciledValue,
        valueRange: reconciled.valueRange,
        pricePerSqFt,
        pricePerAcre,
        pricePerBuildingSqFt: buildingSqFt ? Math.round(reconciled.reconciledValue / buildingSqFt) : null,
        capRate: ic.directCapitalization.capRate,
        grossRentMultiplier: ic.incomeMetrics.grossRentMultiplier,
        ecosystemAnnualValue: ecoServices.totalAnnual,
        ecosystemPremiumPct: Math.round(
          Math.min(LAND_VALUATION_CONSTANTS.ecosystemPremium.maxPremium,
            canopyPct * LAND_VALUATION_CONSTANTS.ecosystemPremium.canopyValuePer1Pct) * 10000
        ) / 100,
      },
      methodology: {
        framework: 'Three-approach USPAP-compliant valuation with ecosystem overlay',
        approaches: ['Sales Comparison (Berkshire Hathaway CMA style)', 'Income Capitalization (JLL DCF methodology)', 'Cost Approach (Marshall/RS Means)'],
        ecosystemIntegration: 'P&X TerraValue engine — peer-reviewed canopy premium coefficients',
        sources: [
          'Appraisal Institute — The Appraisal of Real Estate, 15th Ed.',
          'USPAP 2024-2025 Edition (The Appraisal Foundation)',
          'JLL Valuation Advisory — Cap Rate Survey 2024',
          'CBRE North America Cap Rate Survey H2 2024',
          'RS Means Building Construction Cost Data 2024 (Southeast)',
          'Marshall Valuation Service — Depreciation Tables',
          'FHFA House Price Index — Atlanta-Sandy Springs-Roswell MSA',
          'Netusil et al. 2014 — Implicit value of tree cover (meta-analysis). DOI: 10.1016/j.ecolecon.2016.04.018',
          'Kovacs et al. 2022 — Tree cover and property values (national)',
        ],
        disclaimer: reconciled.disclaimer,
      },
    };
  }


  // ─── INTERNAL HELPERS ───────────────────────────────────────

  static _generateSyntheticComps(subject) {
    const baseValue = subject.assessedValue && subject.state === 'GA'
      ? subject.assessedValue / 0.40
      : subject.assessedValue || (subject.lotSizeSqFt * 15);

    const variations = [
      { priceMult: 0.92, sizeMult: 1.08, ageDelta: -3, canopyDelta: -5, label: 'Larger lot, slightly less canopy' },
      { priceMult: 1.05, sizeMult: 0.95, ageDelta: 2, canopyDelta: 3, label: 'Smaller lot, newer, more canopy' },
      { priceMult: 0.98, sizeMult: 1.02, ageDelta: -1, canopyDelta: 0, label: 'Similar property, slight size difference' },
      { priceMult: 1.08, sizeMult: 0.88, ageDelta: 5, canopyDelta: 8, label: 'Smaller lot, newer build, premium canopy' },
      { priceMult: 0.95, sizeMult: 1.12, ageDelta: -5, canopyDelta: -3, label: 'Larger lot, older build' },
    ];

    const now = Date.now();
    return variations.map((v, i) => ({
      address: `Comparable ${i + 1} — ${v.label}`,
      salePrice: Math.round(baseValue * v.priceMult),
      saleDate: new Date(now - (90 + i * 60) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      lotSizeSqFt: Math.round((subject.lotSizeSqFt || 15000) * v.sizeMult),
      buildingSqFt: subject.buildingSqFt ? Math.round(subject.buildingSqFt * (0.9 + Math.random() * 0.2)) : null,
      yearBuilt: subject.yearBuilt ? subject.yearBuilt + v.ageDelta : null,
      canopyPct: Math.max(0, Math.min(80, (subject.canopyPct || 25) + v.canopyDelta)),
      condition: subject.condition || 3,
      locationQuality: subject.locationQuality || 3,
      isSynthetic: true,
    }));
  }

  static _estimateUseFeasibility(use, lotSizeSqFt, currentMarketValue, canopyPct) {
    const lotAcres = lotSizeSqFt / 43560;
    const estimates = {
      'single-family residential': {
        buildableRatio: 0.35,
        revenuePerSqFt: 200,
        costPerSqFt: 175,
        annualIncomeFactor: 0.055,
      },
      'multi-family residential': {
        buildableRatio: 0.50,
        revenuePerSqFt: 250,
        costPerSqFt: 185,
        annualIncomeFactor: 0.065,
      },
      'commercial/retail': {
        buildableRatio: 0.40,
        revenuePerSqFt: 275,
        costPerSqFt: 225,
        annualIncomeFactor: 0.070,
      },
      'office': {
        buildableRatio: 0.45,
        revenuePerSqFt: 300,
        costPerSqFt: 250,
        annualIncomeFactor: 0.065,
      },
      'conservation/open space': {
        buildableRatio: 0,
        revenuePerSqFt: 0,
        costPerSqFt: 0,
        annualIncomeFactor: 0,
      },
    };

    const est = estimates[use] || estimates['single-family residential'];

    if (use === 'conservation/open space') {
      const ecoValue = Math.round(lotAcres * (canopyPct / 100) *
        LAND_VALUATION_CONSTANTS.ecosystemPremium.annualServicesPerCanopyAcre);
      return {
        estimatedDevelopmentValue: 0,
        estimatedDevelopmentCost: 0,
        residualLandValue: Math.round(ecoValue / 0.05),
        estimatedAnnualIncome: ecoValue,
        note: 'Value derived from capitalized ecosystem services',
      };
    }

    const buildableSqFt = Math.round(lotSizeSqFt * est.buildableRatio);
    const grossRevenue = buildableSqFt * est.revenuePerSqFt;
    const developmentCost = buildableSqFt * est.costPerSqFt;
    const residualLandValue = Math.round(grossRevenue - developmentCost);
    const estimatedAnnualIncome = Math.round(grossRevenue * est.annualIncomeFactor);

    return {
      estimatedDevelopmentValue: grossRevenue,
      estimatedDevelopmentCost: developmentCost,
      residualLandValue,
      estimatedAnnualIncome,
      buildableSqFt,
    };
  }

  static _getZoningUses(zoning) {
    const z = (zoning || '').toUpperCase();
    if (z.startsWith('R-1') || z.startsWith('RS') || z === 'AG') {
      return ['single-family residential', 'conservation/open space'];
    }
    if (z.startsWith('R-2') || z.startsWith('RM') || z.startsWith('R-M')) {
      return ['single-family residential', 'multi-family residential', 'conservation/open space'];
    }
    if (z.startsWith('C') || z.startsWith('BUS') || z.startsWith('NS')) {
      return ['commercial/retail', 'office', 'multi-family residential', 'conservation/open space'];
    }
    if (z.startsWith('M') || z.startsWith('I') || z.startsWith('LI') || z.startsWith('HI')) {
      return ['commercial/retail', 'office', 'conservation/open space'];
    }
    if (z.startsWith('MU') || z.startsWith('MX') || z.startsWith('TOD')) {
      return ['single-family residential', 'multi-family residential', 'commercial/retail', 'office', 'conservation/open space'];
    }
    return ['single-family residential', 'conservation/open space'];
  }

  static _median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
}


// ============================================================
// MAIN ENGINE CLASS
// ============================================================

class TerraValueEngine {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Full analysis — runs all modules for a parcel
   */
  async analyze(parcelData) {
    // Track every input the orchestrator synthesizes so the response can disclose them.
    // The math is the same as before; the difference is honesty about what the user supplied
    // vs. what the engine guessed on their behalf.
    const assumptionsApplied = [];

    // 1. Property valuation
    const valuation = await PropertyValuation.getCompositeValue(parcelData, this.options);

    // 2. Ecosystem services
    const ecosystemServices = EcosystemServices.calculate(parcelData);

    // 3. Soil Score (coming soon — returns null until data pipeline is complete)
    const soilScore = EcosystemServices.calculateSoilScore(parcelData);

    // 4. Land appreciation projection (default: canopy-based estimate)
    const canopyBasedScore = Math.round(Math.min(100, (parcelData.canopyPct / 40) * 100));
    assumptionsApplied.push(
      `appreciation.currentScore = canopyPct ÷ 40 × 100 = ${canopyBasedScore}`,
      `appreciation.projectedScore = currentScore + 10 (assumed improvement)`,
      `appreciation.timelineYears = 10 (default horizon)`
    );
    const appreciation = LandAppreciation.project({
      currentScore: canopyBasedScore,
      projectedScore: Math.min(100, canopyBasedScore + 10),
      timelineYears: 10,
      propertyValue: valuation.compositeValue || (parcelData.assessedValue / 0.40),
      currentCanopyPct: parcelData.canopyPct,
      lotSizeSqFt: parcelData.lotSizeSqFt,
    });

    // 5. Certification pathways — only synthesize fields the caller didn't supply
    const cd = parcelData.certificationData || {};
    if (cd.hasGreenInfrastructure == null) {
      assumptionsApplied.push(`certifications.hasGreenInfrastructure = canopyPct > 25 (proxy)`);
    }
    if (cd.biodiversityNetGainPct == null) {
      assumptionsApplied.push(`certifications.biodiversityNetGainPct = canopyPct > 30 ? 12 : 5 (proxy)`);
    }
    const certifications = CertificationPathway.assess({
      canopyPct: parcelData.canopyPct,
      hasGreenInfrastructure: parcelData.canopyPct > 25,
      biodiversityNetGainPct: parcelData.canopyPct > 30 ? 12 : 5,
      plantWallPct: 0,
      pottedPlantPct: 0,
      hasErosionPlan: false,
      hasBiophiliaPlan: false,
      ...cd,
    });

    return {
      parcel: parcelData,
      valuation,
      ecosystemServices,
      soilScore,
      appreciation,
      certifications,
      methodology: Methodology.generate(),
      generatedAt: new Date().toISOString(),
      engineVersion: METHODOLOGY_VERSION,
      // Top-level disclosure of every value the orchestrator filled in.
      // The API layer reads this and includes it in the dataQuality block.
      dataQuality: {
        syntheticDataUsed: assumptionsApplied.length > 0,
        assumptionsApplied,
        note: assumptionsApplied.length > 0
          ? 'Orchestrator synthesized one or more inputs from canopyPct — see assumptionsApplied'
          : 'All inputs supplied by caller',
      },
    };
  }

  // Static access to sub-modules
  static PropertyValuation = PropertyValuation;
  static EcosystemServices = EcosystemServices;
  static LandAppreciation = LandAppreciation;
  static SustainabilityValue = SustainabilityValue;
  static CertificationPathway = CertificationPathway;
  static LandValuation = LandValuation;
  static Methodology = Methodology;
  static CERTIFICATIONS = CERTIFICATIONS;
  static ECOSYSTEM_SERVICE_RATES = ECOSYSTEM_SERVICE_RATES;
  static LAND_VALUATION_CONSTANTS = LAND_VALUATION_CONSTANTS;
}

// Server-side export only (no window.TerraValueEngine)
module.exports = TerraValueEngine;
