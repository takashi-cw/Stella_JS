/**
 * transits.js — トランジット計算モジュール
 *
 * Layer 3: chart（計算関数を引数注入で受け取る純粋関数群）
 *
 * bsp-reader.js + icrsToEcliptic() の合成関数を `calcFn(jd)` として
 * 外部から渡すことで、Layer 2 との疎結合を維持する。
 *
 * 提供する機能:
 *   - normAngularDiff  — 符号付き最短角度差（-180〜+180）
 *   - findLongitudeCrossing — 二分探索による黄経通過 JD の検索
 *   - detectStationPoint    — 留点（逆行転換点）の検出
 *   - calculateOptimalSampleCount — 期間・惑星に応じたサンプル点数
 *   - circularMeanLongitude      — 円周角の平均黄経
 *   - calcSyzygy                 — 朔望（シジジー）計算
 *
 * ライセンス: MIT
 * アルゴリズム出典:
 *   - spacefield/tools/transits.py（Stella.me OS、MIT License）
 *   - Meeus "Astronomical Algorithms" 2nd ed.
 */

'use strict';

// =========================================================================
// 惑星平均角速度テーブル（度/日）— transits.py 準拠
// =========================================================================

/** 惑星の平均角速度（度/日）*/
export const AVG_SPEEDS = Object.freeze({
  Moon:    13.0,
  Sun:      0.9856,
  Mercury:  1.6,
  Venus:    1.2,
  Mars:     0.5,
  Jupiter:  0.08,
  Saturn:   0.03,
  Uranus:   0.01,
  Neptune:  0.006,
  Pluto:    0.004,
  Earth:    0.9856,
});

// =========================================================================
// 角度ユーティリティ
// =========================================================================

/**
 * 2 黄経の最短角度差を返す（符号付き、-180°〜+180°）
 *
 * 正値 = lon1 から lon2 への順行方向
 * 負値 = lon1 から lon2 への逆行方向
 *
 * @param {number} lon1 開始黄経（度）
 * @param {number} lon2 終了黄経（度）
 * @returns {number} 符号付き最短差（-180〜+180）
 */
export function normAngularDiff(lon1, lon2) {
  let delta = lon2 - lon1;
  if (delta > 180)  delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

// =========================================================================
// 黄経通過検索（二分探索）
// =========================================================================

/**
 * 惑星が指定黄経を通過する JD を二分探索で検索する（純粋関数）
 *
 * @param {function(jd: number): { lon: number }} calcFn
 *   JD を受け取り { lon } を返す関数（bsp-reader + icrsToEcliptic の合成）
 * @param {number} targetLon 目標黄経（度, 0–360）
 * @param {number} startJD   検索開始 JD
 * @param {number} endJD     検索終了 JD
 * @param {object} [opts]
 * @param {number} [opts.precisionHours=0.01] 検索精度（時間）
 * @param {number} [opts.maxIter=60]          最大反復回数
 * @returns {number | null} 通過時 JD（見つからない場合 null）
 *
 * 注意: 逆行により複数回通過がある場合、最初の通過のみを返す。
 */
export function findLongitudeCrossing(calcFn, targetLon, startJD, endJD, opts = {}) {
  const precisionJD = (opts.precisionHours ?? 0.01) / 24.0;
  const maxIter     = opts.maxIter ?? 60;

  /**
   * lon1 から lon2 への移動中に target を通過するか
   * delta > 0: 順行、delta < 0: 逆行
   */
  function isBetween(target, lon1, lon2) {
    const delta       = normAngularDiff(lon1, lon2);
    const targetDelta = normAngularDiff(lon1, target);
    if (delta >= 0) {
      return targetDelta >= 0 && targetDelta <= delta;
    } else {
      return targetDelta <= 0 && targetDelta >= delta;
    }
  }

  const startLon = calcFn(startJD).lon;
  const endLon   = calcFn(endJD).lon;

  if (!isBetween(targetLon, startLon, endLon)) return null;

  let lo = startJD, loLon = startLon;
  let hi = endJD;
  let iter = 0;

  while (hi - lo > precisionJD && iter < maxIter) {
    const mid    = (lo + hi) / 2;
    const midLon = calcFn(mid).lon;

    if (isBetween(targetLon, loLon, midLon)) {
      hi = mid;
    } else {
      lo    = mid;
      loLon = midLon;
    }
    iter++;
  }

  return (lo + hi) / 2;
}

// =========================================================================
// 留点検出（逆行転換点）
// =========================================================================

/**
 * 期間内の留点（黄経速度が 0 に近い瞬間）を検出する（純粋関数）
 *
 * 留点は inbound（順行→逆行）または outbound（逆行→順行）の転換点。
 * 1日刻みでスキャン後、二分探索で精密化する。
 *
 * @param {function(jd: number): { lon: number, lonspeed: number }} calcFn
 *   JD を受け取り { lon, lonspeed } を返す関数
 * @param {number} startJD 検索開始 JD
 * @param {number} endJD   検索終了 JD
 * @param {object} [opts]
 * @param {number} [opts.stepDays=1.0]       粗スキャンのステップ（日）
 * @param {number} [opts.precisionHours=0.01] 精密化の精度（時間）
 * @param {number} [opts.maxIter=60]           最大反復回数
 * @returns {{
 *   jd: number,
 *   lon: number,
 *   type: 'direct_to_retrograde' | 'retrograde_to_direct',
 *   speedBefore: number,
 *   speedAfter:  number,
 * } | null}
 */
export function detectStationPoint(calcFn, startJD, endJD, opts = {}) {
  const stepDays    = opts.stepDays    ?? 1.0;
  const precisionJD = (opts.precisionHours ?? 0.01) / 24.0;
  const maxIter     = opts.maxIter ?? 60;

  let prevJD    = startJD;
  let prevSpeed = calcFn(startJD).lonspeed;
  let jd        = startJD + stepDays;

  while (jd <= endJD) {
    const currSpeed = calcFn(jd).lonspeed;

    const signFlip =
      (prevSpeed > 0 && currSpeed < 0) ||
      (prevSpeed < 0 && currSpeed > 0);

    if (signFlip) {
      // 符号ベース二分探索で留点を精密化
      // [lo, hi] 内に速度の符号転換点が存在することを不変条件として収束させる
      let lo = prevJD, loSpd = prevSpeed;
      let hi = jd;
      let iter = 0;
      let signLo = loSpd >= 0 ? 1 : -1;

      while (hi - lo > precisionJD && iter < maxIter) {
        const mid    = (lo + hi) / 2;
        const midSpd = calcFn(mid).lonspeed;
        const signMid = midSpd >= 0 ? 1 : -1;

        if (signLo !== signMid) {
          // 符号転換は [lo, mid] 側
          hi = mid;
        } else {
          lo    = mid;
          loSpd = midSpd;
          signLo = signMid;
        }
        iter++;
      }

      const stationJD    = (lo + hi) / 2;
      const stationCalc  = calcFn(stationJD);

      return {
        jd:          stationJD,
        lon:         stationCalc.lon,
        type:        prevSpeed > 0 ? 'direct_to_retrograde' : 'retrograde_to_direct',
        speedBefore: prevSpeed,
        speedAfter:  currSpeed,
      };
    }

    prevJD    = jd;
    prevSpeed = currSpeed;
    jd       += stepDays;
  }

  return null;
}

// =========================================================================
// サンプリングユーティリティ
// =========================================================================

/**
 * 期間と惑星に応じた最適なサンプル点数を計算する（純粋関数）
 *
 * 惑星の平均角速度から期間内移動量を推定し、
 * 12° ごとに 1 サンプルを配置する方針で点数を決定する。
 *
 * @param {number} periodDays 期間（日）
 * @param {string} planetId   惑星 ID
 * @param {object} [opts]
 * @param {number} [opts.targetInterval=12] 目標サンプリング間隔（度）
 * @param {number} [opts.min=3]             最小サンプル点数
 * @param {number} [opts.max=30]            最大サンプル点数
 * @returns {number} サンプル点数
 */
export function calculateOptimalSampleCount(periodDays, planetId, opts = {}) {
  const targetInterval = opts.targetInterval ?? 12.0;
  const minSamples     = opts.min ?? 3;
  const maxSamples     = opts.max ?? 30;

  const speed        = AVG_SPEEDS[planetId] ?? 0.5;
  const totalMovement = speed * periodDays;
  let count          = Math.floor(totalMovement / targetInterval) + 1;

  return Math.max(minSamples, Math.min(maxSamples, count));
}

// =========================================================================
// 朔望（シジジー）計算
// =========================================================================

/**
 * 指定 JD より前の直近の朔（New Moon）または望（Full Moon）を返す
 *
 * 朔望 = 太陽と月の黄経差が 0°（朔）または 180°（望）になる瞬間。
 * 出生直前の朔望は占星術でシジジーと呼ばれ、
 * 伝統占星術のチャート計算に使われる。
 *
 * アルゴリズム:
 *   1. 指定 JD から最大 30 日分を 0.5 日刻みで遡り、
 *      太陽-月の黄経差（0°または 180°）のゼロ交差を探す
 *   2. ゼロ交差が見つかったら二分探索で精密化（精度 0.01 時間）
 *
 * @param {function(jd: number): { lon: number }} sunCalcFn  太陽の黄経を返す関数
 * @param {function(jd: number): { lon: number }} moonCalcFn 月の黄経を返す関数
 * @param {number} jdTdb 基準 JD（この直前の朔/望を探す）
 * @param {object} [opts]
 * @param {number} [opts.searchDays=30]      最大遡り日数
 * @param {number} [opts.stepDays=0.5]       粗スキャンのステップ（日）
 * @param {number} [opts.precisionHours=0.01] 精密化の精度（時間）
 * @returns {{
 *   jd: number,
 *   lon: number,
 *   type: 'new_moon' | 'full_moon',
 * } | null}
 */
export function calcSyzygy(sunCalcFn, moonCalcFn, jdTdb, opts = {}) {
  const searchDays   = opts.searchDays    ?? 30;
  const stepDays     = opts.stepDays      ?? 0.5;
  const precisionJD  = (opts.precisionHours ?? 0.01) / 24.0;

  /**
   * 太陽-月の黄経差（0° 付近 → 朔、180° 付近 → 望）を
   * 二値化した「朔望位相」を返す
   *   朔に向かう区間: 差を (-180, 180) に正規化して返す
   *   望に向かう区間: 差を (0, 360) に正規化して返す
   *
   * シジジー = この関数が 0 または 180 を横切る瞬間
   */
  function elongation(jd) {
    const sunLon  = sunCalcFn(jd).lon;
    const moonLon = moonCalcFn(jd).lon;
    let diff = moonLon - sunLon;
    // -180〜+180 に正規化
    diff = ((diff % 360) + 360) % 360;
    if (diff > 180) diff -= 360;
    return diff;  // 朔: 0、望: ±180
  }

  // 粗スキャン: jdTdb から遡って符号転換を探す
  let jd = jdTdb;
  let currE = elongation(jd);

  const endJd = jdTdb - searchDays;

  while (jd > endJd) {
    const prevJd = jd - stepDays;
    const prevE  = elongation(prevJd);

    // 朔のゼロ交差: elongation が 0 を正から負（または逆）に横切る
    const crossesZero = (currE > 0 && prevE <= 0) || (currE < 0 && prevE >= 0);
    // 望のゼロ交差: elongation が ±180 付近を横切る
    const crossesFull = (currE > 90 && prevE < -90) || (currE < -90 && prevE > 90);

    if (crossesZero || crossesFull) {
      // 二分探索で精密化
      let lo = prevJd, hi = jd;
      let loE = prevE;

      while (hi - lo > precisionJD) {
        const mid  = (lo + hi) / 2;
        const midE = elongation(mid);

        if (crossesFull) {
          // 望: lo と mid が「望前 (E>0) 側」かどうかで二分
          if ((loE > 0) === (midE > 0)) { lo = mid; loE = midE; } else { hi = mid; }
        } else {
          // 朔: lo と mid が「E ≤ 0 側」かどうかで二分
          // loE=0 の境界ケース（朔がちょうどステップ端に来る場合）も正しく処理される
          if ((loE <= 0) === (midE <= 0)) { lo = mid; loE = midE; } else { hi = mid; }
        }
      }

      const syzJd  = (lo + hi) / 2;
      const syzLon = sunCalcFn(syzJd).lon;  // 朔望点の黄経 = 太陽黄経
      const type   = crossesFull ? 'full_moon' : 'new_moon';

      return { jd: syzJd, lon: ((syzLon % 360) + 360) % 360, type };
    }

    jd   = prevJd;
    currE = prevE;
  }

  return null;
}

// =========================================================================
// 円周角平均
// =========================================================================

/**
 * 黄経の配列から円周角の平均を計算する（純粋関数）
 *
 * 単位円上のベクトル平均を使うことで、360°/0° 境界を正しく処理する。
 *
 * @param {number[]} longitudes 黄経の配列（度）
 * @returns {number} 平均黄経（度, 0–360）。空配列の場合は 0
 */
export function circularMeanLongitude(longitudes) {
  if (longitudes.length === 0) return 0;

  let sinSum = 0, cosSum = 0;
  for (const lon of longitudes) {
    const r = lon * Math.PI / 180;
    sinSum += Math.sin(r);
    cosSum += Math.cos(r);
  }

  const mean = Math.atan2(sinSum, cosSum) * 180 / Math.PI;
  return ((mean % 360) + 360) % 360;
}
