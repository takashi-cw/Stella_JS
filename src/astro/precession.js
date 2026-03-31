/**
 * precession.js — 歳差・章動計算モジュール
 *
 * Layer 2: astro（constants.js に依存）
 *
 * 提供する計算:
 *   - 黄道傾斜角（IAU 2006 モデル / Capitaine et al. 2003）
 *   - 春分点の一般歳差（約 50.2564"/年）
 *   - アヤナムシャ計算（Lahiri / Raman / Krishnamurti / Fagan-Bradley / Huber / Custom）
 *   - 黄道帯推奨ロジック（文化圏 × 時代対応表）
 *
 * ライセンス: MIT
 * アルゴリズム出典:
 *   - IAU 2006 Resolution B1 / Capitaine et al. 2003（黄道傾斜角）
 *   - Lieske et al. 1977（一般歳差）
 *   - spacefield/precession.py（アヤナムシャ・推奨ロジック 設計参考）
 */

'use strict';

import { J2000_JD, JULIAN_CENTURY } from '../core/constants.js';

// =========================================================================
// 定数
// =========================================================================

/** 一般歳差速度（度/年）= 50.2564 arcsec/year */
const PRECESSION_RATE = 50.2564 / 3600.0;

/** Lahiri アヤナムシャ（J2000.0 エポック値、度） */
const AYANAMSHA_LAHIRI_2000 = 23.85;

/**
 * Fagan-Bradley アヤナムシャ J2000.0 基準値（度）
 * 出典: Cyril Fagan "Zodiacs Old and New" (1950) に基づく天文測定値
 * ※ Swiss Ephemeris SE_SIDM_FAGAN_BRADLEY と同値だが、独立した公開天文値
 */
const AYANAMSHA_FAGAN_BRADLEY_J2000 = 24.042044;

/**
 * Fagan-Bradley 歳差速度（度/年）
 * 出典: IAU 一般歳差 Lieske et al. 1977
 */
const AYANAMSHA_FAGAN_BRADLEY_RATE = 50.2388475 / 3600.0;

// =========================================================================
// 黄道傾斜角（IAU 2006）
// =========================================================================

/**
 * IAU 2006 黄道傾斜角を計算する（純粋関数）
 *
 * Capitaine et al. 2003 の多項式展開（5次）。
 *   ε(T) = 84381.406 − 46.836769·T − 0.0001831·T² + 0.00200340·T³
 *           − 0.000000576·T⁴ − 0.0000000434·T⁵  [arcsec]
 *
 * @param {number} jd ユリウス日
 * @returns {number} 黄道傾斜角（度）
 */
export function obliquity(jd) {
  const T = (jd - J2000_JD) / JULIAN_CENTURY;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;
  const T5 = T4 * T;
  const arcsec = 84381.406
    - 46.836769 * T
    - 0.0001831 * T2
    + 0.00200340 * T3
    - 0.000000576 * T4
    - 0.0000000434 * T5;
  return arcsec / 3600.0;
}

// =========================================================================
// 一般歳差
// =========================================================================

/**
 * 歳差運動による春分点の移動量を計算する（純粋関数）
 *
 * @param {number} yearFrom 基準年
 * @param {number} yearTo   計算対象年
 * @returns {number} 春分点の移動量（度、西向き正）
 */
export function calculatePrecession(yearFrom, yearTo) {
  return (yearTo - yearFrom) * PRECESSION_RATE;
}

// =========================================================================
// アヤナムシャ
// =========================================================================

/**
 * アヤナムシャ（Ayanamsha）を計算する（純粋関数）
 *
 * ⚠️ サイデリアル黄経 = of-date トロピカル黄経 − アヤナムシャ
 * アヤナムシャは of-date 春分点を基準として定義されているため、
 * J2000 黄経ではなく of-date トロピカル黄経から減算する。
 *
 * @param {string}      type         'lahiri' | 'raman' | 'krishnamurti' | 'fagan_bradley' | 'huber' | 'custom'
 * @param {number}      year         計算対象年（浮動小数点可）
 * @param {number|null} [customOffset] カスタムオフセット（度）。type='custom' 時のみ有効
 * @returns {{
 *   type:        string,
 *   offsetDeg:   number,
 *   year:        number,
 *   description: string,
 *   note:        string,
 * }}
 */
export function calculateAyanamsha(type, year, customOffset = null) {
  const note = 'サイデリアル座標計算時は of-date 黄経を使用してください';

  if (type === 'custom' && customOffset !== null) {
    return {
      type: 'custom',
      offsetDeg: customOffset,
      year,
      description: `カスタムアヤナムシャ: ${customOffset.toFixed(4)}度`,
      note,
    };
  }

  const precession = calculatePrecession(2000, year);

  switch (type) {
    case 'lahiri': {
      const val = AYANAMSHA_LAHIRI_2000 + precession;
      return {
        type: 'lahiri',
        offsetDeg: val,
        year,
        description: `Lahiri（インド政府公式）: ${val.toFixed(4)}度`,
        note,
      };
    }
    case 'raman': {
      const val = (AYANAMSHA_LAHIRI_2000 - 0.2) + precession;
      return {
        type: 'raman',
        offsetDeg: val,
        year,
        description: `Raman: ${val.toFixed(4)}度`,
        note,
      };
    }
    case 'krishnamurti': {
      const val = (AYANAMSHA_LAHIRI_2000 + 0.7) + precession;
      return {
        type: 'krishnamurti',
        offsetDeg: val,
        year,
        description: `Krishnamurti: ${val.toFixed(4)}度`,
        note,
      };
    }
    case 'fagan_bradley': {
      const val = AYANAMSHA_FAGAN_BRADLEY_J2000 + (year - 2000) * AYANAMSHA_FAGAN_BRADLEY_RATE;
      return {
        type: 'fagan_bradley',
        offsetDeg: val,
        year,
        description: `Fagan-Bradley（バビロニア基準）: ${val.toFixed(4)}度`,
        note,
      };
    }
    case 'huber': {
      const val = 24.74 + (year - 2000) * AYANAMSHA_FAGAN_BRADLEY_RATE;
      return {
        type: 'huber',
        offsetDeg: val,
        year,
        description: `Huber（η Psc 基準）: ${val.toFixed(4)}度`,
        note,
      };
    }
    default:
      return calculateAyanamsha('lahiri', year, null);
  }
}

// =========================================================================
// 黄道帯推奨ロジック（文化圏 × 時代）
// spacefield/precession.py CULTURE_ZODIAC_TABLE の移植
// =========================================================================

/**
 * [yearMin, yearMax, culture, zodiac, ayanamsha|null, confidence, source]
 * @type {ReadonlyArray<Readonly<[number,number,string,string,string|null,string,string]>>}
 */
const _CULTURE_ZODIAC_TABLE = Object.freeze([
  [-700,  -100, 'mesopotamia', 'sidereal',   'fagan_bradley', 'high',
   'バビロニア天文学（MUL.APIN, VAT 4956 等）'],
  [-700,  -100, 'mesopotamia', 'sidereal',   'huber',         'high',
   'Huber η Psc 基準（バビロニア恒星基準の変種）'],
  [ 100,  9999, 'western',     'tropical',    null,            'high',
   'プトレマイオス以降の西洋占星術'],
  [-9999, 9999, 'indian',      'sidereal',   'lahiri',         'high',
   'ヴェーダ占星術（ICAR 公式値）'],
  [-9999, 9999, 'indian',      'sidereal',   'raman',          'medium',
   'Raman 式（南インドの一部で使用）'],
  [-9999, 9999, 'chinese',     'equatorial',  null,            'high',
   '赤道座標系（二十八宿）— 黄道座標系とは体系が異なる'],
  [-100,   200, 'hellenistic', 'disputed',    null,            'low',
   'ヘレニズム/エジプト — トロピカル移行期（学術的に未決）'],
]);

const _CULTURE_LABELS = Object.freeze({
  mesopotamia: 'メソポタミア',
  western:     '西洋',
  indian:      'インド',
  chinese:     '中国',
  hellenistic: 'ヘレニズム/エジプト',
});

/** [latMin, latMax, lonMin, lonMax, yearMax, culture] */
const _GEO_CULTURE_RULES = Object.freeze([
  [ 28,  40,  38,  50,    0, 'mesopotamia'],
  [  5,  38,  65, 100, 9999, 'indian'],
  [ 20,  55, 100, 145, 9999, 'chinese'],
  [ 25,  45,  20,  38,  200, 'hellenistic'],
]);

const _CONFIDENCE_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });

/**
 * 日付・文化圏から適切な黄道帯とアヤナムシャを推奨する（純粋関数）
 *
 * @param {number}      year         天文学方式の年（BC 410 = −409）
 * @param {string|null} [culture]    'mesopotamia' | 'western' | 'indian' | 'chinese' | 'hellenistic' | null
 * @param {number|null} [lon]        経度（culture=null のとき地理推定用）
 * @param {number|null} [lat]        緯度（culture=null のとき地理推定用）
 * @returns {{
 *   zodiac:       string,
 *   ayanamsha:    string|null,
 *   culture:      string,
 *   cultureLabel: string,
 *   confidence:   string,
 *   source:       string,
 *   alternatives: Array<{zodiac:string, ayanamsha:string|null, confidence:string, source:string}>,
 *   message:      string,
 * }}
 */
export function recommendZodiac(year, culture = null, lon = null, lat = null) {
  let resolved = culture;

  if (resolved === null && lat !== null && lon !== null) {
    for (const [latMin, latMax, lonMin, lonMax, yearMax, c] of _GEO_CULTURE_RULES) {
      if (lat >= latMin && lat <= latMax
          && lon >= lonMin && lon <= lonMax
          && year <= yearMax) {
        resolved = c;
        break;
      }
    }
  }

  if (resolved === null) resolved = 'western';

  const matches = _CULTURE_ZODIAC_TABLE.filter(
    row => row[2] === resolved && year >= row[0] && year <= row[1]
  );

  const cultureLabel = _CULTURE_LABELS[resolved] ?? resolved;

  if (matches.length === 0) {
    return {
      zodiac: 'tropical',
      ayanamsha: null,
      culture: resolved,
      cultureLabel,
      confidence: 'low',
      source: 'ルールテーブルに該当なし — トロピカルをデフォルト適用',
      alternatives: [],
      message: `${resolved}: 該当ルールなし。トロピカルをデフォルト適用。`,
    };
  }

  const primary = matches.reduce((best, row) =>
    _CONFIDENCE_RANK[row[5]] > _CONFIDENCE_RANK[best[5]] ? row : best
  );
  const alternatives = matches
    .filter(row => row !== primary)
    .map(row => ({ zodiac: row[3], ayanamsha: row[4], confidence: row[5], source: row[6] }));

  const yearDisplay = year <= 0 ? `BC ${Math.abs(year)}` : `AD ${year}`;
  let msgSuffix;
  if      (primary[3] === 'sidereal')   msgSuffix = `サイデリアル(${primary[4]})を推奨`;
  else if (primary[3] === 'tropical')   msgSuffix = 'トロピカルを推奨';
  else if (primary[3] === 'equatorial') msgSuffix = '赤道座標系（二十八宿）— 黄道座標系とは体系が異なります';
  else                                  msgSuffix = '座標系は学術的に未決（トロピカル移行期）';

  return {
    zodiac:       primary[3],
    ayanamsha:    primary[4],
    culture:      resolved,
    cultureLabel,
    confidence:   primary[5],
    source:       primary[6],
    alternatives,
    message:      `${yearDisplay} ${cultureLabel}: ${msgSuffix}`,
  };
}

/**
 * 現在の座標系が推奨と一致しない場合に console.warn を発行する
 *
 * @param {number}      year              天文学方式の年
 * @param {string|null} [culture]         文化圏
 * @param {string}      [currentZodiac]   現在使用中の座標系
 * @param {string|null} [currentAyanamsha] 現在のアヤナムシャ名
 * @param {number|null} [lon]             経度
 * @param {number|null} [lat]             緯度
 * @returns {object} recommendZodiac() の戻り値に warningIssued を追加
 */
export function warnZodiacMismatch(
  year,
  culture         = null,
  currentZodiac   = 'tropical',
  currentAyanamsha = null,
  lon             = null,
  lat             = null,
) {
  const rec = recommendZodiac(year, culture, lon, lat);
  rec.warningIssued = false;

  if (rec.zodiac === 'disputed') return rec;

  if (currentZodiac !== rec.zodiac) {
    console.warn(
      `座標系の不一致: 現在=${currentZodiac}, 推奨=${rec.zodiac}（${rec.cultureLabel}）。${rec.source}`
    );
    rec.warningIssued = true;
    return rec;
  }

  if (
    rec.zodiac === 'sidereal'
    && rec.ayanamsha !== null
    && currentAyanamsha !== null
    && currentAyanamsha !== rec.ayanamsha
  ) {
    const refYear = year > -9999 ? year : 2000;
    const recVal  = calculateAyanamsha(rec.ayanamsha, refYear);
    const curVal  = calculateAyanamsha(currentAyanamsha, refYear);
    const diff    = Math.abs(recVal.offsetDeg - curVal.offsetDeg);
    console.warn(
      `アヤナムシャの不一致: 選択=${currentAyanamsha}, 推奨=${rec.ayanamsha}（${rec.cultureLabel}）。差 ${diff.toFixed(2)}°`
    );
    rec.warningIssued = true;
  }

  return rec;
}
