/**
 * Stella-JS Engine — Public API Entry Point
 *
 * Layer 1〜3 の公開APIを一元的に re-export する。
 * public/index.html は このファイル1つを import すればよい。
 *
 * BSP ファイルのパスは呼び出し側（UI）で指定する。
 * エンジン層はパスをハードコードしない（処理手順 §9 準拠）。
 */

// ── Layer 1: core ─────────────────────────────────────────────────────────────

export {
  J2000_JD,
  JULIAN_CENTURY,
  JULIAN_YEAR,
  AU_KM,
  NAIF,
  PLANET_NAIF,
  DELTA_T_TABLE,
} from './core/constants.js';

export {
  chebyshevEval,
  chebyshevEvalWithDeriv,
  chebyshevEvalWithVelocity,
  chebyshevEval3,
  chebyshevEval3WithVelocity,
  normalizeTime,
} from './core/chebyshev.js';

export {
  dateToJd,
  jdToDate,
  astroYearToHistorical,
  historicalYearToAstro,
  deltaT,
  deltaTFromJd,
  jdUtcToTt,
  jdTtToUtc,
  jdTtToTdb,
  jdUtcToTdb,
  jstToJdUtc,
  localToJdUtc,
  TDBDatetime,
  ERA,
} from './core/timescale.js';

export {
  loadBsp,
  BspFile,
  parseBsp,
} from './core/bsp-reader.js';

export {
  getCoverageJd,
  assertInCoverage,
  formatCoverageMessage,
} from './core/bsp-validator.js';

// ── Layer 2: astro ─────────────────────────────────────────────────────────────

export {
  obliquity,
  calculatePrecession,
  calculateAyanamsha,
  recommendZodiac,
} from './astro/precession.js';

export {
  normAngle,
  gmst,
  siderealTime,
  eclipticToEquatorial,
  equatorialToEcliptic,
  calculateMcAsc,
  icrsToJ2000Ecliptic,
  precessLongitude,
  icrsToEcliptic,
  applyAberration,
  annualAberration,
  nutationAngles,
  altitudeAzimuth,
  observerGCRS,
  applyLightDeflection,
} from './astro/coordinates.js';

export {
  HOUSE_SYSTEMS,
  housesPlacidus,
  housesKoch,
  housesEqual,
  housesWholeSigns,
  housesRegiomontanus,
  housesCampanus,
  effectiveHouseSystem,
  calculateHouses,
} from './astro/houses.js';

// ── Layer 3: chart ─────────────────────────────────────────────────────────────

export {
  ASPECT,
  MAJOR_ASPECTS,
  MINOR_ASPECTS,
  ALL_ASPECTS,
  PLANET,
  PLANET_ORBS,
  ASPECT_NAMES_JP,
  ASPECT_NAMES_EN,
  ASPECT_SYMBOLS,
  closestAngularDist,
  getPlanetOrb,
  analyzeAspect,
  getAllAspects,
  getAspectStats,
} from './chart/aspects.js';

export {
  AVG_SPEEDS,
  normAngularDiff,
  findLongitudeCrossing,
  detectStationPoint,
  calculateOptimalSampleCount,
  circularMeanLongitude,
  calcSyzygy,
} from './chart/transits.js';

export {
  findNewMoonsInRange,
  findZhongqiInRange,
  findDongzhi,
  buildLunarMonths,
  assignMonthNumbers,
  getLunarDate,
} from './chart/lunar-calendar.js';

export {
  DEFAULT_OPTIONS,
  lonToXY,
  buildChartData,
  renderSVG,
  renderHoroscopeSVG,
} from './chart/renderer.js';

// ── BSP パスのデフォルト設定 ───────────────────────────────────────────────────

/**
 * 開発環境と本番環境でのデフォルト BSP パス。
 * UI 側は必要に応じてオーバーライドできる。
 *
 *   開発（ローカル）: 'data/de440s.bsp'（public/data/ 内の開発用フル版）
 *   本番（GitHub Pages）: 'data/de440s-modern.bsp'（1873-01-01〜2100-12-31、23.7 MB）
 */
export const BSP_PATH_DEV  = 'data/de440s.bsp';
export const BSP_PATH_PROD = 'data/de440s-modern.bsp';
