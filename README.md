# @phloemxylem/terravalue-engine

Parcel-level ecosystem services and land valuation engine. Built by P&X — Phloem & Xylem.

The canonical computation layer behind [terravalue.app](https://www.terravalue.app) and the TerraValue API at `pxconsulting.io/api/*`. Pure JavaScript, zero runtime dependencies, ships with input validation baked into every public method.

## What it does

Given a parcel — lot size, canopy coverage, assessed value, and (optionally) a few hundred other fields — the engine returns:

- **Ecosystem services**: carbon sequestration, stormwater management, air quality, energy savings, habitat value, with per-service dollar amounts and methodology citations
- **Property valuation**: composite value via sales comparison, income capitalization, cost approach, and reconciliation
- **Land appreciation**: forward projection based on Soil Score delta + canopy change
- **Certification pathway**: assessment against LEED, BREEAM, WELL, Green Globes
- **Soil Score**: 0–100 composite stewardship rating (data pipeline pending)

All constants come from research-backed config files (`config/*.json`) — EPA social cost of carbon, USDA iTree rates, Georgia GSMM stormwater values, peer-reviewed property-value premium meta-analyses. Each value carries a citation.

## Install

```bash
npm install @phloemxylem/terravalue-engine
```

Requires Node 18 or later.

## Usage — Node.js

```js
const TerraValueEngine = require('@phloemxylem/terravalue-engine');

const result = TerraValueEngine.EcosystemServices.calculate({
  lotSizeSqFt: 10890,    // 0.25 acres
  canopyPct: 40,         // 40% tree canopy
  assessedValue: 350000, // $350K assessed
  state: 'GA',
});

console.log(result.services.carbon.annualValue);    // → ~$49.40
console.log(result.services.stormwater.annualValue); // → ~$66.50
```

### Full analysis (orchestrated)

```js
const engine = new TerraValueEngine();
const full = await engine.analyze({
  lotSizeSqFt: 10890,
  canopyPct: 40,
  assessedValue: 350000,
});
// full.valuation, full.ecosystemServices, full.appreciation,
// full.certifications, full.methodology, full.dataQuality
```

### Specific modules

```js
const { LandAppreciation } = TerraValueEngine;
const projection = LandAppreciation.project({
  currentScore: 50,
  projectedScore: 75,
  timelineYears: 10,
  propertyValue: 350000,
  currentCanopyPct: 40,
});
```

## Usage — Browser

The published package ships a browser-ready bundle at `dist/terravalue-engine.browser.js`. Config is inlined; no module loader required.

```html
<script src="https://www.terravalue.app/terravalue-engine.js"></script>
<script>
  const result = TerraValueEngine.EcosystemServices.calculate({
    lotSizeSqFt: 10890,
    canopyPct: 40,
    assessedValue: 350000,
  });
</script>
```

(Production frontends should copy the bundle to their own origin at deploy time rather than loading from a third-party CDN — see the `terravalue` frontend repo for the canonical pattern.)

## Input validation

Every public method validates its input against a per-method schema. Bad input throws `ValidationError` — no silent NaN, no negative service values, no out-of-range outputs.

```js
const { ValidationError } = require('@phloemxylem/terravalue-engine');

try {
  TerraValueEngine.EcosystemServices.calculate({
    lotSizeSqFt: 10890,
    canopyPct: -50,        // invalid — must be 0..100
    assessedValue: 350000,
  });
} catch (e) {
  if (e instanceof ValidationError) {
    console.log(e.field);   // 'canopyPct'
    console.log(e.message); // 'canopyPct: must be >= 0 (got -50)'
  }
}
```

Validation history is in [AUDIT-2026-05-20.md](https://github.com/willpark1895-spec/px-website/blob/main/AUDIT-2026-05-20.md#f2--api-accepts-garbage-input-and-returns-garbage-output) (finding F2). Three confirmed reproductions against the pre-fix API are now blocked at the engine boundary regardless of caller.

### Validate without calling the engine

```js
const { validateBody, pickSchema } = require('@phloemxylem/terravalue-engine');

const schema = pickSchema(['lotSizeSqFt', 'canopyPct', 'assessedValue']);
try {
  const clean = validateBody(req.body, schema);
  // clean has trimmed/coerced numbers; safe to pass to engine
} catch (e) {
  if (e instanceof ValidationError) {
    res.status(400).json({ error: e.message, allErrors: e.allErrors });
  }
}
```

## Public API

| Module | Entry point | Purpose |
|---|---|---|
| `EcosystemServices` | `.calculate(parcel)` | Per-service annual dollar values (carbon, stormwater, air, energy, habitat) |
| `EcosystemServices` | `.calculateSoilScore(parcel)` | 0–100 composite stewardship rating (pipeline pending) |
| `LandAppreciation` | `.project(params)` | Forward-looking property-value projection |
| `LandValuation` | `.fullValuation(parcel, options)` | Three-method appraisal + reconciliation |
| `LandValuation` | `.salesComparison(subject, comparables)` | Comparable-sales approach |
| `LandValuation` | `.incomeCapitalization(params)` | Income approach |
| `LandValuation` | `.costApproach(params)` | Cost approach |
| `LandValuation` | `.highestAndBestUse(parcel)` | HABU analysis |
| `CertificationPathway` | `.assess(siteData, targets)` | LEED / BREEAM / WELL / Green Globes assessment |
| `PropertyValuation` | `.getCompositeValue(parcel, options)` | Async composite property value (engine + AVM blend) |
| `Methodology` | `.generate()` | Full citation pack |
| `TerraValueEngine` (instance) | `.analyze(parcel)` | Orchestrator — runs every module + assumption disclosure |

### Constants exported

- `TerraValueEngine.CERTIFICATIONS` — full certification database
- `TerraValueEngine.ECOSYSTEM_SERVICE_RATES` — per-service rate table with citations
- `TerraValueEngine.LAND_VALUATION_CONSTANTS` — appraisal constants

### Validator exports (named)

- `ValidationError` — error class with `.field` and `.allErrors`
- `validateField(value, name, spec)` — single-field validation, throws on failure
- `validateBody(body, schema)` — whole-object validation, collects every error
- `pickSchema(fields)` — build a per-method schema from the canonical table
- `SCHEMAS` / `NUMERIC_SCHEMAS` / `STRING_SCHEMAS` — the canonical schema table

## Bypassing validation

Two subpaths are exposed for callers that have already validated their input:

```js
// Raw engine — no validation, no coercion. For internal use and tests.
const Raw = require('@phloemxylem/terravalue-engine/raw');

// Just the validator, no engine.
const { validateBody } = require('@phloemxylem/terravalue-engine/validate');
```

## Tests

```bash
npm test
```

Runs:
- `tests/golden-parity.test.js` — 17 snapshot tests covering EcosystemServices, LandAppreciation, CertificationPathway, LandValuation. Snapshots are byte-identical across runs (deterministic via frozen `Date.now()` and seeded `Math.random()`).
- `tests/test-validation.js` — F2 input-validation behavior across every entrypoint.

To regenerate snapshots after an intentional math change:

```bash
npm run snapshots:regenerate
```

## Browser bundle

```bash
npm run build:browser
```

Runs `tools/generate-browser-bundle.js`. Reads `lib/terravalue-engine.js` + `lib/validate.js` + every `config/*.json`, emits `dist/terravalue-engine.browser.js` with config inlined and a `window.TerraValueEngine` global. No esbuild, no transpilation, no minification — just deterministic text concatenation.

`prepublishOnly` runs this automatically, so the bundle is always fresh in the published tarball.

## Versioning

Semver:

- **Major** — breaking changes to public API or output shape.
- **Minor** — additive changes (new method, new field, new exported constant).
- **Patch** — bug fixes that don't change valid-input behavior. Bumped on `_version` changes inside `config/*.json` files because those are research updates, not bugs.

Every config file carries its own `_version` field, and the engine exposes `CONFIG_VERSION` (concatenation of all five) so consumers can detect rate changes independently of the package version.

## License

UNLICENSED. P&X retains all rights. Contact `willpark.1895@gmail.com` for integration partnerships.
