/**
 * houses.js — ハウスカスプ計算モジュール
 *
 * Layer 2: astro（coordinates.js, precession.js に依存）
 *
 * 提供するハウスシステム:
 *   - Placidus      半弧法（Newton-Raphson）— 西洋占星術で最も普及
 *   - Koch          誕生地法（閉じた式）
 *   - Equal         ASC 基準 30° 等分
 *   - Whole Sign    星座全体ハウス
 *   - Regiomontanus 赤道等分投影法
 *   - Campanus      主垂直圏 30° 等分（地心専用）
 *
 * 戻り値の構造:
 *   { cusps: number[12], angles: [ASC, MC, DESC, IC] }
 *   cusps[0] = H1（ASC）, cusps[9] = H10（MC）など 0-indexed
 *
 * ライセンス: MIT
 * アルゴリズム出典:
 *   - Jean Meeus "Astronomical Algorithms" 2nd ed. Ch.24
 *   - spacefield/ephem/house_systems.py（設計参考）
 */

'use strict';

import {
  normAngle,
  siderealTime,
  calculateMcAsc,
  equatorialToEcliptic,
} from './coordinates.js';
import { obliquity } from './precession.js';

// =========================================================================
// ハウスシステム識別子
// =========================================================================

/** @readonly */
export const HOUSE_SYSTEMS = Object.freeze({
  PLACIDUS:      'placidus',
  KOCH:          'koch',
  EQUAL:         'equal',
  WHOLE_SIGN:    'whole_sign',
  REGIOMONTANUS: 'regiomontanus',
  CAMPANUS:      'campanus',
});

// =========================================================================
// Newton-Raphson ソルバー
// =========================================================================

/**
 * Newton-Raphson 法で f(x) = 0 を解く（純粋関数）
 *
 * @param {function(number): number} func f(x) を返す関数
 * @param {number} x0                初期値
 * @param {object} [opts]
 * @param {number} [opts.tol=1e-9]   収束判定閾値（|Δx| < tol）
 * @param {number} [opts.maxIter=50] 最大反復回数
 * @param {number} [opts.h=1e-7]     数値微分ステップ幅
 * @param {number|null} [opts.maxStep=null] 1回あたりの最大ステップ幅（null で無制限）。
 *   高緯度など dsha が急変する領域で atan2 の分岐切断をまたいだ誤収束を防ぐ。
 * @returns {number} 収束した解
 * @throws {Error} 収束しなかった場合、または導関数がゼロの場合
 */
export function solveNewton(func, x0, { tol = 1e-9, maxIter = 50, h = 1e-7, maxStep = null } = {}) {
  let x = x0;
  for (let i = 0; i < maxIter; i++) {
    const fx  = func(x);
    const dfx = (func(x + h) - func(x - h)) / (2 * h);
    if (Math.abs(dfx) < 1e-15) {
      throw new Error(`solveNewton: 導関数がゼロに近い (iter=${i}, x=${x.toFixed(6)})`);
    }
    let dx = -fx / dfx;
    if (maxStep !== null) dx = Math.max(-maxStep, Math.min(maxStep, dx));
    x += dx;
    if (Math.abs(dx) < tol) return x;
  }
  throw new Error(`solveNewton: 収束しない (maxIter=${maxIter}, x=${x.toFixed(6)}, f=${func(x).toExponential(2)})`);
}

// =========================================================================
// Placidus
// =========================================================================

/**
 * Placidus ハウスシステムを計算する（純粋関数）
 *
 * Meeus 半弧法。各中間カスプを
 *   「そのカスプの RA = RAMC ± fraction × DSHA(RA)」
 * で定義し、Newton-Raphson 法で解く。
 *
 *   H11: f(θ) = RAMC + D(θ)/3  − θ = 0   （MC → ASC 方向 +1/3）
 *   H12: f(θ) = RAMC + 2D(θ)/3 − θ = 0   （MC → ASC 方向 +2/3）
 *   H8:  f(θ) = RAMC − 2D(θ)/3 − θ = 0   （DESC → MC 方向 −2/3）
 *   H9:  f(θ) = RAMC − D(θ)/3  − θ = 0   （DESC → MC 方向 −1/3）
 *   下半球 = 上半球 + 180°
 *
 * 極地方（|lat| ≧ 66° 付近）では DSHA が未定義になりうる。
 * arccos の引数をクランプして計算継続するが精度は低下する。
 *
 * @param {number} jd  ユリウス日
 * @param {number} lat 地理緯度（度）
 * @param {number} lon 地理経度（度）
 * @returns {{ cusps: number[], angles: number[] }}
 */
export function housesPlacidus(jd, lat, lon) {
  const { mc, asc, ramc } = calculateMcAsc(jd, lat, lon);
  const desc = normAngle(asc + 180);
  const ic   = normAngle(mc  + 180);
  const eps  = obliquity(jd);
  const latR = lat * Math.PI / 180;
  const epsR = eps * Math.PI / 180;

  function dsha(thetaDeg) {
    const ra  = (thetaDeg % 360) * Math.PI / 180;
    const lam = Math.atan2(Math.sin(ra), Math.cos(ra) * Math.cos(epsR));
    const sinD = Math.max(-1, Math.min(1, Math.sin(epsR) * Math.sin(lam)));
    const delta = Math.asin(sinD);
    const td    = Math.max(-1, Math.min(1, -Math.tan(latR) * Math.tan(delta)));
    return Math.acos(td) * 180 / Math.PI;
  }

  function thetaToEcliptic(thetaDeg) {
    const ra  = (thetaDeg % 360) * Math.PI / 180;
    const lam = Math.atan2(Math.sin(ra), Math.cos(ra) * Math.cos(epsR));
    return normAngle(lam * 180 / Math.PI);
  }

  function solveUpper(fraction) {
    return solveNewton(theta => ramc + fraction * dsha(theta) - theta, ramc, { maxStep: 60 });
  }

  const tH11 = solveUpper(+1 / 3);
  const tH12 = solveUpper(+2 / 3);
  const tH8  = solveUpper(-2 / 3);
  const tH9  = solveUpper(-1 / 3);

  const cusps = new Array(12).fill(0);
  cusps[0]  = asc;
  cusps[3]  = ic;
  cusps[6]  = desc;
  cusps[9]  = mc;
  cusps[10] = thetaToEcliptic(tH11);        // H11
  cusps[11] = thetaToEcliptic(tH12);        // H12
  cusps[7]  = thetaToEcliptic(tH8);         // H8
  cusps[8]  = thetaToEcliptic(tH9);         // H9
  cusps[4]  = normAngle(cusps[10] + 180);   // H5
  cusps[5]  = normAngle(cusps[11] + 180);   // H6
  cusps[1]  = normAngle(cusps[7]  + 180);   // H2
  cusps[2]  = normAngle(cusps[8]  + 180);   // H3

  return { cusps, angles: [asc, mc, desc, ic] };
}

// =========================================================================
// Koch
// =========================================================================

/**
 * Koch ハウスシステムを計算する（純粋関数）
 *
 * Meeus 誕生地法。MC の昼行半弧 D を使い閉じた式で計算する。
 *
 *   D_MC = arccos(−tan(φ)·tan(δ_MC))
 *   H11 = MC at RAMC + D/3,   H12 = MC at RAMC + 2D/3
 *   H9  = MC at RAMC − D/3,   H8  = MC at RAMC − 2D/3
 *   下半球 = 上半球 + 180°
 *
 * @param {number} jd  ユリウス日
 * @param {number} lat 地理緯度（度）
 * @param {number} lon 地理経度（度）
 * @returns {{ cusps: number[], angles: number[] }}
 */
export function housesKoch(jd, lat, lon) {
  const { mc, asc, ramc } = calculateMcAsc(jd, lat, lon);
  const desc = normAngle(asc + 180);
  const ic   = normAngle(mc  + 180);
  const eps  = obliquity(jd);
  const latR = lat * Math.PI / 180;
  const epsR = eps * Math.PI / 180;
  const mcR  = mc  * Math.PI / 180;

  const sinDmc  = Math.max(-1, Math.min(1, Math.sin(epsR) * Math.sin(mcR)));
  const deltaMc = Math.asin(sinDmc);
  const td      = Math.max(-1, Math.min(1, -Math.tan(latR) * Math.tan(deltaMc)));
  const D       = Math.acos(td) * 180 / Math.PI;

  function mcAt(raDeg) {
    const ra = (raDeg % 360) * Math.PI / 180;
    return normAngle(
      Math.atan2(Math.sin(ra), Math.cos(ra) * Math.cos(epsR)) * 180 / Math.PI
    );
  }

  const cusps = new Array(12).fill(0);
  cusps[0]  = asc;
  cusps[3]  = ic;
  cusps[6]  = desc;
  cusps[9]  = mc;
  cusps[10] = mcAt(ramc + D / 3);           // H11
  cusps[11] = mcAt(ramc + 2 * D / 3);       // H12
  cusps[8]  = mcAt(ramc - D / 3);           // H9 (MC 側)
  cusps[7]  = mcAt(ramc - 2 * D / 3);       // H8 (DESC 側)
  cusps[4]  = normAngle(cusps[10] + 180);   // H5
  cusps[5]  = normAngle(cusps[11] + 180);   // H6
  cusps[1]  = normAngle(cusps[7]  + 180);   // H2
  cusps[2]  = normAngle(cusps[8]  + 180);   // H3

  return { cusps, angles: [asc, mc, desc, ic] };
}

// =========================================================================
// Equal
// =========================================================================

/**
 * Equal ハウスシステムを計算する（純粋関数）
 *
 * ASC を第1ハウスカスプとし、30° ずつ等分する。
 *
 * @param {number} jd  ユリウス日
 * @param {number} lat 地理緯度（度）
 * @param {number} lon 地理経度（度）
 * @returns {{ cusps: number[], angles: number[] }}
 */
export function housesEqual(jd, lat, lon) {
  const { mc, asc } = calculateMcAsc(jd, lat, lon);
  const desc = normAngle(asc + 180);
  const ic   = normAngle(mc  + 180);
  const cusps = Array.from({ length: 12 }, (_, i) => normAngle(asc + i * 30));
  return { cusps, angles: [asc, mc, desc, ic] };
}

// =========================================================================
// Whole Sign
// =========================================================================

/**
 * Whole Sign ハウスシステムを計算する（純粋関数）
 *
 * ASC が含まれる星座の 0° を第1ハウスカスプとし、
 * 星座全体（30°ブロック）をそれぞれ1ハウスに割り当てる。
 *
 * @param {number} jd  ユリウス日
 * @param {number} lat 地理緯度（度）
 * @param {number} lon 地理経度（度）
 * @returns {{ cusps: number[], angles: number[] }}
 */
export function housesWholeSigns(jd, lat, lon) {
  const { mc, asc } = calculateMcAsc(jd, lat, lon);
  const desc = normAngle(asc + 180);
  const ic   = normAngle(mc  + 180);
  const ascSignStart = Math.floor(asc / 30) * 30;
  const cusps = Array.from({ length: 12 }, (_, i) => normAngle(ascSignStart + i * 30));
  return { cusps, angles: [asc, mc, desc, ic] };
}

// =========================================================================
// Regiomontanus
// =========================================================================

/**
 * Regiomontanus ハウスシステムを計算する（純粋関数）
 *
 * 天の赤道を RAMC 起点に 30° 等分し、各分割点を
 * 地平線の北/南点を通る大円で黄道に投影する。
 *
 *   tan(λ_n) = sin(θ_n) / (cos(θ_n)·cos(ε) − sin(ε)·tan(φ))
 *   θ_n = RAMC + n × 30°
 *   n=1 → H11, n=2 → H12, n=4 → H2, n=5 → H3
 *   下半球 = 上半球 + 180°
 *
 * @param {number} jd  ユリウス日
 * @param {number} lat 地理緯度（度）
 * @param {number} lon 地理経度（度）
 * @returns {{ cusps: number[], angles: number[] }}
 */
export function housesRegiomontanus(jd, lat, lon) {
  const { mc, asc, ramc } = calculateMcAsc(jd, lat, lon);
  const desc = normAngle(asc + 180);
  const ic   = normAngle(mc  + 180);
  const eps  = obliquity(jd);
  const latR = lat * Math.PI / 180;
  const epsR = eps * Math.PI / 180;

  function regio(n) {
    const theta = ((ramc + n * 30) % 360) * Math.PI / 180;
    const numer = Math.sin(theta);
    const denom = Math.cos(theta) * Math.cos(epsR) - Math.sin(epsR) * Math.tan(latR);
    return normAngle(Math.atan2(numer, denom) * 180 / Math.PI);
  }

  const cusps = new Array(12).fill(0);
  cusps[0]  = asc;
  cusps[3]  = ic;
  cusps[6]  = desc;
  cusps[9]  = mc;
  cusps[10] = regio(1);                      // H11 θ = RAMC + 30°
  cusps[11] = regio(2);                      // H12 θ = RAMC + 60°
  cusps[1]  = regio(4);                      // H2  θ = RAMC + 120°
  cusps[2]  = regio(5);                      // H3  θ = RAMC + 150°
  cusps[4]  = normAngle(cusps[10] + 180);    // H5
  cusps[5]  = normAngle(cusps[11] + 180);    // H6
  cusps[7]  = normAngle(cusps[1]  + 180);    // H8
  cusps[8]  = normAngle(cusps[2]  + 180);    // H9

  return { cusps, angles: [asc, mc, desc, ic] };
}

// =========================================================================
// Campanus
// =========================================================================

/**
 * Campanus ハウスシステムを計算する（純粋関数）
 *
 * 主垂直圏（天頂を通る東西大円）を 30° 等分し、
 * 各分割点を赤道座標経由で黄道に投影する。
 * 地球中心専用。
 *
 * @param {number} jd  ユリウス日
 * @param {number} lat 地理緯度（度）
 * @param {number} lon 地理経度（度）
 * @returns {{ cusps: number[], angles: number[] }}
 */
export function housesCampanus(jd, lat, lon) {
  const { mc, asc, ramc } = calculateMcAsc(jd, lat, lon);
  const desc = normAngle(asc + 180);
  const ic   = normAngle(mc  + 180);
  const eps  = obliquity(jd);
  const latR = lat * Math.PI / 180;

  const cusps = new Array(12).fill(0);
  cusps[0] = asc;
  cusps[3] = ic;
  cusps[6] = desc;
  cusps[9] = mc;

  for (let i = 1; i < 12; i++) {
    if (i % 3 === 0) continue;  // H4, H7, H10 はカーディナル（算出済み）
    const pvRad = i * 30 * Math.PI / 180;
    const decR  = Math.atan(Math.cos(pvRad) * Math.tan(latR));
    const cosD  = Math.cos(decR);
    let hR;
    if (Math.abs(cosD) > 1e-4) {
      let sinH = Math.sin(pvRad) * Math.cos(latR) / cosD;
      sinH = Math.max(-1, Math.min(1, sinH));
      hR   = Math.asin(sinH);
      // pvAngle が 90° < pv < 270° の象限では時角の符号を反転
      if (pvRad > Math.PI / 2 && pvRad < 3 * Math.PI / 2) {
        hR = hR > 0 ? Math.PI - hR : -Math.PI - hR;
      }
    } else {
      hR = 0;
    }
    const raForCusp    = normAngle(ramc - hR * 180 / Math.PI);
    const { lon: ecl } = equatorialToEcliptic(raForCusp, decR * 180 / Math.PI, eps);
    cusps[i] = ecl;
  }

  return { cusps, angles: [asc, mc, desc, ic] };
}

// =========================================================================
// ファサード
// =========================================================================

// =========================================================================
// 極地フォールバック
// =========================================================================

/**
 * フォールバック後の実効ハウスシステムと理由を返す（純粋関数）
 *
 * |lat| > 90° − obliquity(jd) の緯度では一部の黄経で DSHA が未定義となり、
 * Placidus / Koch は天文学的に無意味な値を返す。Equal へ切り替える。
 *
 * @param {number} jd    ユリウス日
 * @param {number} lat   地理緯度（度）
 * @param {string} hsys  HOUSE_SYSTEMS 定数
 * @returns {{ hsys: string, fallback: string|null }}
 *   fallback は変更なし=null、極地='polar_latitude'
 */
export function effectiveHouseSystem(jd, lat, hsys) {
  const _polarSensitive = new Set([
    HOUSE_SYSTEMS.PLACIDUS,
    HOUSE_SYSTEMS.KOCH,
  ]);
  if (!_polarSensitive.has(hsys)) return { hsys, fallback: null };

  const eps = obliquity(jd);
  if (Math.abs(lat) > 90 - eps) {
    return { hsys: HOUSE_SYSTEMS.EQUAL, fallback: 'polar_latitude' };
  }
  return { hsys, fallback: null };
}

// =========================================================================
// ファサード
// =========================================================================

/**
 * 指定されたハウスシステムでカスプを計算する（純粋関数）
 *
 * 極地緯度（|lat| > 90° − obliquity）では Placidus/Koch を Equal へ
 * 自動フォールバックし、戻り値の `fallback` フィールドに理由を返す。
 *
 * @param {number} jd         ユリウス日
 * @param {number} lat        地理緯度（度）
 * @param {number} lon        地理経度（度）
 * @param {string} [hsys]     HOUSE_SYSTEMS 定数（デフォルト: 'placidus'）
 * @returns {{ cusps: number[], angles: number[], fallback: string|null }}
 */
export function calculateHouses(jd, lat, lon, hsys = HOUSE_SYSTEMS.PLACIDUS) {
  const { hsys: effectiveHsys, fallback } = effectiveHouseSystem(jd, lat, hsys);
  let result;
  switch (effectiveHsys) {
    case HOUSE_SYSTEMS.PLACIDUS:      result = housesPlacidus(jd, lat, lon);      break;
    case HOUSE_SYSTEMS.KOCH:          result = housesKoch(jd, lat, lon);           break;
    case HOUSE_SYSTEMS.EQUAL:         result = housesEqual(jd, lat, lon);          break;
    case HOUSE_SYSTEMS.WHOLE_SIGN:    result = housesWholeSigns(jd, lat, lon);     break;
    case HOUSE_SYSTEMS.REGIOMONTANUS: result = housesRegiomontanus(jd, lat, lon);  break;
    case HOUSE_SYSTEMS.CAMPANUS:      result = housesCampanus(jd, lat, lon);       break;
    default:                          result = housesPlacidus(jd, lat, lon);       break;
  }
  return { ...result, fallback };
}
