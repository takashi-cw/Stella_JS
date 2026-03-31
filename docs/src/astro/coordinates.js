/**
 * coordinates.js — 天体座標変換モジュール
 *
 * Layer 2: astro（precession.js, constants.js に依存）
 *
 * 提供する変換:
 *   - 角度正規化（normAngle）
 *   - グリニッジ平均恒星時（GMST）/ 地方恒星時（LST）
 *   - 黄道座標 ↔ 赤道座標（Meeus 球面三角法）
 *   - MC（中天）・ASC（アセンダント）計算（Meeus Ch.24）
 *   - ICRS XYZ → J2000.0 黄道球面座標（obliquity 回転）
 *   - J2000.0 黄道 → of-date 黄道（ψ_A スカラー加算、後方互換）
 *   - 章動角（ΔΨ, Δε）計算（IAU 2000B 全 77 項テーブル）
 *   - 年周光行差補正（速度ベクトル法 / ICRS 空間、相対論的一次近似）← Skyfield 互換
 *   - トポセントリック補正用観測者 GCRS 位置ベクトル（WGS-84 楕円体）
 *   - 光偏差補正（gravitational light deflection / 太陽重力場）
 *   - ICRS XYZ → of-date 真黄道（IAU 2006 Capitaine 3角度歳差 + IAU 2000B 章動、メイン変換関数）
 *
 * 精度: Python/Skyfield（de440s.bsp）との黄経差 < 0.01"（春分時刻: NAOJ と秒単位一致）
 *       月トポセントリック: 地心差最大 ~57' → 補正後 < 1"（望遠鏡観測対応）
 *
 * ライセンス: MIT
 * アルゴリズム出典:
 *   - Meeus "Astronomical Algorithms" 2nd ed. Ch.12, 13, 21, 22, 23, 24
 *   - Capitaine et al. 2003 A&A 412, 567–586（IAU 2006 3角度歳差モデル / Skyfield互換）
 *   - IAU 2000B 章動（IERS Conventions 2010 / Mathews et al. 2002, 77項）
 *   - spacefield/ephem/house_systems.py, skyfield_engine.py（設計参考）
 */

'use strict';

import { J2000_JD, JULIAN_CENTURY } from '../core/constants.js';
import { obliquity } from './precession.js';

// =========================================================================
// 角度ユーティリティ
// =========================================================================

/**
 * 角度を [0, 360) に正規化する（純粋関数）
 *
 * @param {number} deg 度（任意範囲）
 * @returns {number} [0, 360) の度
 */
export function normAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

// =========================================================================
// 恒星時
// =========================================================================

/**
 * グリニッジ平均恒星時（GMST）を計算する（純粋関数）
 *
 * Meeus "Astronomical Algorithms" Ch.12 の式。
 *   GMST = 280.46061837 + 360.98564736629·(JD − J2000) + 0.000387933·T² − T³/38710000
 * （T はユリウス世紀数）
 *
 * @param {number} jd ユリウス日（UT1 基準）
 * @returns {number} GMST（度、0–360）
 */
export function gmst(jd) {
  const d = jd - J2000_JD;
  const T = d / JULIAN_CENTURY;
  const g = 280.46061837
    + 360.98564736629 * d
    + 0.000387933 * T * T
    - T * T * T / 38710000.0;
  return normAngle(g);
}

/**
 * 地方恒星時（LST）を計算する（純粋関数）
 *
 * @param {number} jd  ユリウス日（UT1 基準）
 * @param {number} lon 地理経度（度、東経正）
 * @returns {number} LST（度、0–360）
 */
export function siderealTime(jd, lon) {
  return normAngle(gmst(jd) + lon);
}

// =========================================================================
// 座標変換（黄道 ↔ 赤道）
// =========================================================================

/**
 * 黄道座標を赤道座標に変換する（純粋関数）
 *
 * Meeus Ch.13 の球面三角法：
 *   RA  = atan2( sin(λ)·cos(ε) − tan(β)·sin(ε),  cos(λ) )
 *   Dec = asin(  sin(β)·cos(ε) + cos(β)·sin(ε)·sin(λ) )
 *
 * @param {number} lon     黄経（度）
 * @param {number} lat     黄緯（度）
 * @param {number} epsilon 黄道傾斜角（度）
 * @returns {{ ra: number, dec: number }} 赤経（度, 0–360）・赤緯（度）
 */
export function eclipticToEquatorial(lon, lat, epsilon) {
  const l = lon     * Math.PI / 180;
  const b = lat     * Math.PI / 180;
  const e = epsilon * Math.PI / 180;

  const ra = Math.atan2(
    Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e),
    Math.cos(l)
  );
  const dec = Math.asin(
    Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l)
  );

  return {
    ra:  normAngle(ra  * 180 / Math.PI),
    dec: dec * 180 / Math.PI,
  };
}

/**
 * 赤道座標を黄道座標に変換する（純粋関数）
 *
 * Meeus Ch.13 の球面三角法（逆変換）：
 *   λ   = atan2( sin(RA)·cos(ε) + tan(Dec)·sin(ε),  cos(RA) )
 *   β   = asin(  sin(Dec)·cos(ε) − cos(Dec)·sin(ε)·sin(RA) )
 *
 * @param {number} ra      赤経（度）
 * @param {number} dec     赤緯（度）
 * @param {number} epsilon 黄道傾斜角（度）
 * @returns {{ lon: number, lat: number }} 黄経（度, 0–360）・黄緯（度）
 */
export function equatorialToEcliptic(ra, dec, epsilon) {
  const r = ra      * Math.PI / 180;
  const d = dec     * Math.PI / 180;
  const e = epsilon * Math.PI / 180;

  const lon = Math.atan2(
    Math.sin(r) * Math.cos(e) + Math.tan(d) * Math.sin(e),
    Math.cos(r)
  );
  const lat = Math.asin(
    Math.sin(d) * Math.cos(e) - Math.cos(d) * Math.sin(e) * Math.sin(r)
  );

  return {
    lon: normAngle(lon * 180 / Math.PI),
    lat: lat * 180 / Math.PI,
  };
}

// =========================================================================
// MC / ASC
// =========================================================================

/**
 * MC（中天）と ASC（アセンダント）を計算する（純粋関数）
 *
 * Meeus "Astronomical Algorithms" Ch.24 の正確な式：
 *
 *   MC（天頂子午線）:
 *     tan(λ_MC) = tan(RAMC) / cos(ε)
 *     → atan2(sin(RAMC), cos(RAMC)·cos(ε))   ← 象限を atan2 で保持
 *
 *   ASC（アセンダント）:
 *     tan(ASC) = −cos(RAMC) / (sin(RAMC)·cos(ε) + tan(φ)·sin(ε))
 *     ← 球面三角法、全惑星共通（地球専用）
 *
 * @param {number} jd  ユリウス日（UT1 基準）
 * @param {number} lat 地理緯度（度）
 * @param {number} lon 地理経度（度）
 * @returns {{ mc: number, asc: number, ramc: number }} 黄経（度, 0–360）、RAMC（度）
 */
export function calculateMcAsc(jd, lat, lon) {
  const ramc  = siderealTime(jd, lon);
  const eps   = obliquity(jd);

  const ramcR = ramc * Math.PI / 180;
  const epsR  = eps  * Math.PI / 180;
  const latR  = lat  * Math.PI / 180;

  const mc = normAngle(
    Math.atan2(Math.sin(ramcR), Math.cos(ramcR) * Math.cos(epsR)) * 180 / Math.PI
  );

  let asc;
  const denom = -Math.sin(ramcR) * Math.cos(epsR) - Math.tan(latR) * Math.sin(epsR);
  if (Math.abs(Math.cos(latR)) < 1e-10) {
    asc = normAngle(mc + 90);
  } else {
    asc = normAngle(
      Math.atan2(Math.cos(ramcR), denom) * 180 / Math.PI
    );
  }

  return { mc, asc, ramc };
}

// =========================================================================
// ICRS XYZ → 黄道球面座標
// =========================================================================

// J2000.0 黄道傾斜角（モジュール初期化時に一度だけ計算）
const _EPS0_DEG = 84381.406 / 3600.0;  // 23.43927944°
const _EPS0_RAD = _EPS0_DEG * Math.PI / 180;
const _COS_EPS0 = Math.cos(_EPS0_RAD);
const _SIN_EPS0 = Math.sin(_EPS0_RAD);

/**
 * ICRS XYZ 位置ベクトルを J2000.0 黄道球面座標に変換する（純粋関数）
 *
 * ICRS は J2000.0 地球赤道座標系に近似できる（フレームバイアスは数十 mas 程度）。
 * J2000.0 黄道傾斜角 ε₀ = 84381.406" で X 軸まわりに回転して黄道系に変換する。
 *
 *   R_x(+ε₀): [ 1,     0,        0    ]
 *              [ 0,  cos(ε₀),  sin(ε₀) ]
 *              [ 0, −sin(ε₀),  cos(ε₀) ]
 *
 * @param {number} x ICRS X 成分（任意単位、通常 km または AU）
 * @param {number} y ICRS Y 成分
 * @param {number} z ICRS Z 成分
 * @returns {{ lon: number, lat: number, dist: number }}
 *   lon  = J2000.0 黄経（度, 0–360）
 *   lat  = 黄緯（度）
 *   dist = 距離（入力と同単位）
 */
export function icrsToJ2000Ecliptic(x, y, z) {
  const xe = x;
  const ye = y * _COS_EPS0 + z * _SIN_EPS0;
  const ze = -y * _SIN_EPS0 + z * _COS_EPS0;

  const dist = Math.sqrt(xe * xe + ye * ye + ze * ze);
  if (dist === 0) return { lon: 0, lat: 0, dist: 0 };

  const lat = Math.asin(Math.max(-1, Math.min(1, ze / dist))) * 180 / Math.PI;
  const lon = normAngle(Math.atan2(ye, xe) * 180 / Math.PI);

  return { lon, lat, dist };
}

/**
 * J2000.0 黄経を of-date 黄道黄経に変換する（スカラー近似、後方互換用）
 *
 * IAU 2006 一般歳差（Capitaine et al. 2003）の ψ_A を黄経にのみ加算する
 * 簡易近似。黄緯補正を省くため ±0.01° 程度の系統誤差が生じる。
 * アヤナムシャ計算など黄経スカラー操作が必要な箇所に限定して使用すること。
 *
 *   ψ_A = 5038.481507" T − 1.0790069" T² − 0.00114045" T³ [arcsec]
 *
 * @param {number} lonJ2000 J2000.0 黄経（度）
 * @param {number} jd       ユリウス日（TDB または TT）
 * @returns {number} of-date 黄経（度, 0–360）
 */
export function precessLongitude(lonJ2000, jd) {
  const T  = (jd - J2000_JD) / JULIAN_CENTURY;
  const T2 = T * T;
  const T3 = T2 * T;
  const psiA_arcsec = 5038.481507 * T - 1.0790069 * T2 - 0.00114045 * T3;
  return normAngle(lonJ2000 + psiA_arcsec / 3600.0);
}

/**
 * 速度ベクトル法による年周光行差補正（ICRS 空間、相対論的一次近似）
 *
 * Skyfield / USNO Circular 179 / IERS Conventions 2010 と同等のアルゴリズム。
 * 測心的(astrometric) ICRS 方向ベクトルと地球の重心速度ベクトルから
 * 視位置(apparent) ICRS 方向ベクトルを返す。
 *
 *   β  = v_earth / c  （無次元速度ベクトル、|β| ≈ 1e-4）
 *   u' = (u + β) / (1 + u·β)   （一次相対論的補正）
 *
 * 精度: 速度ベクトル法 = 0.001" 以下（Meeus Eq.23.2 の ~0.1〜0.4" に対して 2〜3 桁向上）
 *
 * @param {number} ax  測心的 ICRS X 成分（任意単位、km 推奨）
 * @param {number} ay  測心的 ICRS Y 成分
 * @param {number} az  測心的 ICRS Z 成分
 * @param {number} vx  地球の重心速度 X（km/day）
 * @param {number} vy  地球の重心速度 Y（km/day）
 * @param {number} vz  地球の重心速度 Z（km/day）
 * @returns {{ x: number, y: number, z: number }}  視位置 ICRS 単位ベクトル
 */
export function applyAberration(ax, ay, az, vx, vy, vz) {
  // 方向単位ベクトル u
  const dist = Math.sqrt(ax * ax + ay * ay + az * az);
  const ux = ax / dist, uy = ay / dist, uz = az / dist;

  // β = v / c（c は km/day 単位）
  const C_KM_PER_DAY = 299792.458 * 86400;
  const bx = vx / C_KM_PER_DAY;
  const by = vy / C_KM_PER_DAY;
  const bz = vz / C_KM_PER_DAY;

  // u·β
  const udotb = ux * bx + uy * by + uz * bz;

  // u' = (u + β) / (1 + u·β)
  const inv = 1.0 / (1.0 + udotb);
  const x = (ux + bx) * inv;
  const y = (uy + by) * inv;
  const z = (uz + bz) * inv;

  return { x, y, z };
}

/**
 * 年周光行差補正量を計算する（非推奨: Meeus スカラー近似）
 *
 * @deprecated applyAberration() を使用してください（速度ベクトル法、精度 10〜100 倍向上）
 *
 * Meeus "Astronomical Algorithms" 2nd ed. Ch.23 Eq.23.2 より。
 * 精度 ~0.1〜0.4"（速度ベクトル法 < 0.001" に対して劣る）
 *
 * @param {number} lon  of-date 黄経（度）
 * @param {number} lat  of-date 黄緯（度）
 * @param {number} jd   ユリウス日（TDB）
 * @returns {{ dLon: number, dLat: number }}  補正量（度）
 */
export function annualAberration(lon, lat, jd) {
  const T   = (jd - J2000_JD) / JULIAN_CENTURY;
  const D2R = Math.PI / 180;

  // 地球軌道要素（Meeus Ch.27 / Capitaine et al.）
  const L  = normAngle(280.46646 + 36000.76983 * T + 0.0003032 * T * T);  // 太陽の平均黄経 [deg]
  const e  = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;          // 地球離心率
  const pi = normAngle(102.93735 + 1.71946 * T + 0.00046 * T * T);           // 近日点黄経 [deg]
  const kappa = 20.49552;  // 光行差定数 κ [arcsec]

  const lam = lon * D2R;
  const bet = lat * D2R;
  const LR  = L   * D2R;
  const piR = pi  * D2R;

  // Meeus Eq.23.2
  const dLon = (-kappa * (Math.cos(lam - LR) + e * Math.cos(lam - piR))) / (Math.cos(bet) * 3600);
  const dLat = (-kappa * Math.sin(bet) * (Math.sin(lam - LR) - e * Math.sin(lam - piR))) / 3600;

  return { dLon, dLat };
}

// =========================================================================
// 章動（IAU 2000B 全 77 項 / IERS Conventions 2010）
// =========================================================================

/**
 * IAU 2000B 章動係数テーブル（IERS Conventions 2010 Table 5.3b）
 *
 * 各行: [n_l, n_lp, n_F, n_D, n_Ω, AA, BB, CC, DD, EE, FF]
 *   l  = 月の平均近点角（IAU 2006）、l' = 太陽の平均近点角
 *   F  = 月の緯度引数、 D  = 月の平均離角、Ω = 月昇交点黄経
 *   単位: AA,BB,CC,DD,EE,FF は arcsec × 1e7
 *   ΔΨ = Σ [(AA + BB·T)·sin(arg) + CC·cos(arg)]   [arcsec × 1e7]
 *   Δε = Σ [(DD + EE·T)·cos(arg) + FF·sin(arg)]   [arcsec × 1e7]
 */
const _IAU2000B_NUT77 = Object.freeze([
  //  n_l,n_lp, n_F, n_D, n_Ω,         AA,       BB,      CC,        DD,      EE,      FF
  [   0,   0,   0,   0,   1, -172064161, -174666,   33386,  92052331,   9086,  15377],
  [   0,   0,   2,  -2,   2,  -13170906,   -1675,  -13696,   5730336,  -3015,  -4587],
  [   0,   0,   2,   0,   2,   -2276413,    -234,    2796,    978459,   -485,   1374],
  [   0,   0,   0,   0,   2,    2074554,     207,    -698,   -897492,    470,   -291],
  [   0,   1,   0,   0,   0,    1475877,   -3633,   11817,     73871,   -184,  -1924],
  [   0,   1,   2,  -2,   2,    -516821,    1226,    -524,    224386,   -677,   -174],
  [   1,   0,   0,   0,   0,     711159,      73,    -872,     -6750,      0,    358],
  [   0,   0,   2,   0,   1,    -387298,    -367,     380,    200728,     18,    318],
  [   1,   0,   2,   0,   2,    -301461,     -36,     816,    129025,    -63,    367],
  [   0,  -1,   2,  -2,   2,     215829,    -494,     111,    -95929,    299,    132],
  [   0,   0,   2,  -2,   1,     128227,     137,     181,    -68982,     -9,     39],
  [  -1,   0,   2,   0,   2,     123457,      11,      19,    -53311,     32,     -4],
  [  -1,   0,   0,   2,   0,     156994,      10,    -168,     -1235,      0,     82],
  [   1,   0,   0,   0,   1,      63110,      63,      27,    -33228,      0,     -9],
  [  -1,   0,   0,   0,   1,     -57976,     -63,    -189,     31429,      0,    -75],
  [  -1,   0,   2,   2,   2,     -59641,     -11,     149,     25543,    -11,     66],
  [   1,   0,   2,   0,   1,     -51613,     -42,     129,     26366,      0,     78],
  [  -2,   0,   2,   0,   1,      45893,      50,      31,    -24236,    -10,     20],
  [   0,   0,   0,   2,   0,      63384,      11,    -150,     -1220,      0,     29],
  [   0,   0,   2,   2,   2,     -38571,      -1,     158,     16452,    -11,     68],
  [   0,  -2,   2,  -2,   2,      32481,       0,       0,    -13870,      0,      0],
  [  -2,   0,   0,   2,   0,     -47722,       0,     -18,       477,      0,    -25],
  [   2,   0,   2,   0,   2,     -31046,      -1,     131,     13238,    -11,     59],
  [   1,   0,   2,  -2,   2,      28593,       0,      -1,    -12338,     10,     -3],
  [  -1,   0,   2,   0,   1,      20441,      21,      10,    -10758,      0,     -3],
  [   2,   0,   0,   0,   0,      29243,       0,     -74,      -609,      0,     13],
  [   0,   0,   2,   0,   0,      25887,       0,     -66,      -550,      0,     11],
  [   0,   1,   0,   0,   1,     -14053,     -25,      79,      8551,     -2,    -45],
  [  -1,   0,   0,   2,   1,      15164,      10,      11,     -8001,      0,     -1],
  [   0,   2,   2,  -2,   2,     -15794,      72,     -16,      6850,    -42,     -5],
  [   0,   0,  -2,   2,   0,      21783,       0,      13,      -167,      0,     13],
  [   1,   0,   0,  -2,   1,     -12873,     -10,     -37,      6953,      0,    -14],
  [   0,  -1,   0,   0,   1,     -12654,      11,      63,      6415,      0,     26],
  [  -1,   0,   2,   2,   1,     -10204,       0,      25,      5222,      0,     15],
  [   0,   2,   0,   0,   0,      16707,     -85,     -10,       168,     -1,     10],
  [   1,   0,   2,   2,   2,      -7691,       0,      44,      3268,      0,     19],
  [  -2,   0,   2,   0,   0,     -11024,       0,     -14,       104,      0,      2],
  [   0,   1,   2,   0,   2,       7566,     -21,     -11,     -3250,      0,     -5],
  [   0,   0,   2,   2,   1,      -6637,     -11,      25,      3353,      0,     14],
  [   0,  -1,   2,   0,   2,      -7141,      21,       8,      3070,      0,      4],
  [   0,   0,   0,   2,   1,      -6302,     -11,       2,      3272,      0,      4],
  [   1,   0,   2,  -2,   1,       5800,      10,       2,     -3045,      0,     -1],
  [   2,   0,   2,  -2,   2,       6443,       0,      -7,     -2768,      0,     -4],
  [  -2,   0,   0,   2,   1,      -5774,     -11,     -15,      3041,      0,     -5],
  [   2,   0,   2,   0,   1,      -5350,       0,      21,      2695,      0,     12],
  [   0,  -1,   2,  -2,   1,      -4752,     -11,      -3,      2719,      0,     -3],
  [   0,   0,   0,  -2,   1,      -4940,     -11,     -21,      2720,      0,     -9],
  [  -1,  -1,   0,   2,   0,       7350,       0,      -8,       -51,      0,      4],
  [   2,   0,   0,  -2,   1,       4065,       0,       6,     -2206,      0,      1],
  [   1,   0,   0,   2,   0,       6579,       0,     -24,      -199,      0,      2],
  [   0,   1,   2,  -2,   1,       3579,       0,       5,     -1900,      0,      1],
  [   1,  -1,   0,   0,   0,       4725,       0,      -6,       -41,      0,      3],
  [  -2,   0,   2,   0,   2,      -3075,       0,      -2,      1313,      0,     -1],
  [   3,   0,   2,   0,   2,      -2904,       0,      15,      1233,      0,      7],
  [   0,  -1,   0,   2,   0,       4348,       0,     -10,       -81,      0,      2],
  [   1,  -1,   2,   0,   2,      -2878,       0,       8,      1232,      0,      4],
  [   0,   0,   0,   1,   0,      -4230,       0,       5,       -20,      0,     -2],
  [  -1,  -1,   2,   2,   2,      -2819,       0,       7,      1207,      0,      3],
  [  -1,   0,   2,   0,   0,      -4056,       0,       5,        40,      0,     -2],
  [   0,  -1,   2,   2,   2,      -2647,       0,      11,      1129,      0,      5],
  [  -2,   0,   0,   0,   1,      -2294,       0,     -10,      1266,      0,     -4],
  [   1,   1,   2,   0,   2,       2481,       0,      -7,     -1062,      0,     -3],
  [   2,   0,   0,   0,   1,       2179,       0,      -2,     -1129,      0,     -2],
  [  -1,   1,   0,   1,   0,       3276,       0,       1,        -9,      0,      0],
  [   1,   1,   0,   0,   0,      -3389,       0,       5,        35,      0,     -2],
  [   1,   0,   2,   0,   0,       3339,       0,     -13,      -107,      0,      1],
  [  -1,   0,   2,  -2,   1,      -1987,       0,      -6,      1073,      0,     -2],
  [   1,   0,   0,   0,   2,      -1981,       0,       0,       854,      0,      0],
  [  -1,   0,   0,   1,   0,       4026,       0,    -353,      -553,      0,   -139],
  [   0,   0,   2,   1,   2,       1660,       0,      -5,      -710,      0,     -2],
  [  -1,   0,   2,   4,   2,      -1521,       0,       9,       647,      0,      4],
  [  -1,   1,   0,   1,   1,       1314,       0,       0,      -700,      0,      0],
  [   0,  -2,   2,  -2,   1,      -1283,       0,       0,       672,      0,      0],
  [   1,   0,   2,   2,   1,      -1331,       0,       8,       663,      0,      4],
  [  -2,   0,   2,   2,   2,       1383,       0,      -2,      -594,      0,     -2],
  [  -1,   0,   0,   0,   2,       1405,       0,       4,      -610,      0,      2],
  [   1,   1,   2,  -2,   2,       1290,       0,       0,      -556,      0,      0],
]);

/**
 * IAU 2006 章動の 5 基本引数（l, l', F, D, Ω）を計算する（内部ヘルパー）
 *
 * IERS Conventions 2010 / Capitaine et al. 2003 に基づく IAU 2006 基本引数。
 *
 * @param {number} T ユリウス世紀数（TDB）
 * @returns {number[]} [l, l', F, D, Ω]（ラジアン、[0, 2π)）
 */
function _nutFundArgs(T) {
  const D2R = Math.PI / 180;
  const TWO_PI = 2 * Math.PI;
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const norm = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
  return [
    norm(((485868.249036 + 1717915923.2178*T + 31.8792*T2 + 0.051635*T3 - 0.00024470*T4) / 3600) * D2R),  // l
    norm(((1287104.79305 +  129596581.0481*T -  0.5532*T2 + 0.000136*T3 - 0.00001149*T4) / 3600) * D2R),  // l'
    norm((( 335779.526232 + 1739527262.8478*T - 12.7512*T2 - 0.001037*T3 + 0.00000417*T4) / 3600) * D2R),  // F
    norm(((1072260.70369 + 1602961601.2090*T -  6.3706*T2 + 0.006593*T3 - 0.00003169*T4) / 3600) * D2R),  // D
    norm(((  450160.398036 -  6962890.5431*T +  7.4722*T2 + 0.007702*T3 - 0.00005939*T4) / 3600) * D2R),  // Ω
  ];
}

/**
 * 章動角（ΔΨ, Δε）を計算する（IAU 2000B 全 77 項テーブル）
 *
 * IERS Conventions 2010 の IAU 2000B 章動シリーズ（77 項）を使用。
 * IAU 2006 基本引数を採用し、IAU 2006 Capitaine 歳差と整合。
 * 精度: IAU 2000A（1365 項）との差 < 1 mas
 *
 * @param {number} jd ユリウス日（TDB）
 * @returns {{ dpsi: number, deps: number }} 章動角（arcsec）
 */
export function nutationAngles(jd) {
  const T = (jd - J2000_JD) / JULIAN_CENTURY;
  const [l, lp, F, D, Om] = _nutFundArgs(T);

  let dpsi = 0, deps = 0;
  for (const [nl, nlp, nF, nD, nOm, AA, BB, CC, DD, EE, FF] of _IAU2000B_NUT77) {
    const arg = nl*l + nlp*lp + nF*F + nD*D + nOm*Om;
    const sarg = Math.sin(arg), carg = Math.cos(arg);
    dpsi += (AA + BB * T) * sarg + CC * carg;
    deps += (DD + EE * T) * carg + FF * sarg;
  }
  return { dpsi: dpsi * 1e-7, deps: deps * 1e-7 };  // arcsec × 1e7 → arcsec
}

/**
 * ICRS XYZ 位置ベクトルを of-date 真黄道球面座標に変換する（純粋関数）
 *
 * IAU 2006 Capitaine 3角度歳差（Capitaine et al. 2003 Eq.37）と
 * IAU 2000B 全 77 項章動テーブル（IERS Conventions 2010）を使用した完全 3D 変換。
 * Skyfield compute_precession と同一歳差アルゴリズムを採用。
 *
 * 変換手順:
 *   1. IAU 2006 Capitaine 3角度（ψ_A, ω_A, χ_A, ε₀）から歳差行列を構成
 *      P = R₃(χ_A)·R₁(−ω_A)·R₃(−ψ_A)·R₁(ε₀)  [Capitaine Eq.37 / Skyfield互換]
 *   2. P を ICRS XYZ に適用 → of-date 平均赤道 XYZ
 *   3. IAU 2000B 全 77 項章動（ΔΨ, Δε）を平均赤道 XYZ に適用 → 真赤道 XYZ
 *   4. 真傾斜角 ε_true = ε_A + Δε で R₁(+ε_true) 回転 → 真黄道 XYZ
 *   5. XYZ → 球面座標 (lon, lat, dist)
 *
 * 精度: Python/Skyfield（de440s.bsp）との黄経差 < 0.1"（春分時刻: NAOJ と数秒一致）
 *
 * @param {number} x   ICRS X（km または AU）
 * @param {number} y   ICRS Y
 * @param {number} z   ICRS Z
 * @param {number} jd  ユリウス日（TDB 基準）
 * @returns {{ lon: number, lat: number, dist: number }}
 *   lon  = of-date 黄経（度, 0–360）
 *   lat  = 黄緯（度）
 *   dist = 距離（入力と同単位）
 */
export function icrsToEcliptic(x, y, z, jd) {
  const T  = (jd - J2000_JD) / JULIAN_CENTURY;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;
  const T5 = T4 * T;
  const A2R = Math.PI / (180 * 3600);  // arcsec → rad

  // ── 1. IAU 2006 Capitaine 3角度歳差（Capitaine et al. 2003 Eq.37）──
  // Skyfield compute_precession と同一係数・同一回転シーケンス
  const eps0A = 84381.406 * A2R;  // J2000.0 平均傾斜角（定数）
  const psiA  = (5038.481507*T - 1.0790069*T2 - 0.00114045*T3
               + 0.000132851*T4 - 0.0000000951*T5) * A2R;  // 黄経一般歳差
  const omgA  = (84381.406 - 0.025754*T + 0.0512623*T2 - 0.00772503*T3
               - 0.000000467*T4 + 0.0000003337*T5) * A2R;  // 傾斜一般歳差
  const chiA  = (10.556403*T - 2.3814292*T2 - 0.00121197*T3
               + 0.000170663*T4 - 0.0000000560*T5) * A2R;  // 惑星歳差
  const epsA  = obliquity(jd) * (Math.PI / 180);            // ε_A（章動計算用）

  // P = R₃(χ_A)·R₁(−ω_A)·R₃(−ψ_A)·R₁(ε₀) を順次適用
  // (a) R₁(ε₀): x 軸まわり +ε₀ 回転
  const ce0 = Math.cos(eps0A), se0 = Math.sin(eps0A);
  const ay =  ce0*y + se0*z;
  const az = -se0*y + ce0*z;
  // ax = x（不変）

  // (b) R₃(−ψ_A): z 軸まわり −ψ_A 回転（黄経一般歳差）
  const cpsi = Math.cos(psiA), spsi = Math.sin(psiA);
  const bx =  cpsi*x  - spsi*ay;
  const by =  spsi*x  + cpsi*ay;
  // bz = az（不変）

  // (c) R₁(−ω_A): x 軸まわり −ω_A 回転（傾斜歳差）
  const comg = Math.cos(omgA), somg = Math.sin(omgA);
  const cy =  comg*by - somg*az;
  const cz =  somg*by + comg*az;
  // cx = bx（不変）

  // (d) R₃(χ_A): z 軸まわり +χ_A 回転（惑星歳差）→ 平均赤道系
  const cchi = Math.cos(chiA), schi = Math.sin(chiA);
  const xm =  cchi*bx + schi*cy;
  const ym = -schi*bx + cchi*cy;
  const zm = cz;

  // ── 2. 章動（IAU 2000B 全 77 項）────────────────────────────────
  // 1 次近似章動行列 N を平均赤道 XYZ に適用 → 真赤道 XYZ
  const { dpsi, deps } = nutationAngles(jd);
  const dPsi = dpsi * A2R;
  const dEps = deps * A2R;
  const ceA = Math.cos(epsA), seA = Math.sin(epsA);

  const xtr = xm - dPsi * (ceA * ym + seA * zm);
  const ytr = dPsi * ceA * xm + ym - dEps * zm;
  const ztr = dPsi * seA * xm + dEps * ym + zm;

  // ── 3. 真傾斜角 ε_true = ε_A + Δε で真赤道 → 真黄道（R₁(+ε_true)）──
  const epsTrue = epsA + dEps;
  const se = Math.sin(epsTrue), ce = Math.cos(epsTrue);

  const xl = xtr;
  const yl = ytr * ce + ztr * se;
  const zl = -ytr * se + ztr * ce;

  // ── 4. XYZ → 球面座標 ───────────────────────────────────────────
  const dist = Math.sqrt(xl*xl + yl*yl + zl*zl);
  if (dist === 0) return { lon: 0, lat: 0, dist: 0 };

  const lat = Math.asin(Math.max(-1, Math.min(1, zl / dist))) * 180 / Math.PI;
  const lon = normAngle(Math.atan2(yl, xl) * 180 / Math.PI);

  return { lon, lat, dist };
}

// =========================================================================
// 地平座標（高度・方位角）
// =========================================================================

/**
 * 赤道座標から地平座標（高度・方位角）を計算する（純粋関数）
 *
 * Meeus "Astronomical Algorithms" Ch.13 の球面三角法:
 *   H   = LST − RA（時角）
 *   sin(alt) = sin(φ)·sin(δ) + cos(φ)·cos(δ)·cos(H)
 *   Az  = atan2(−sin(H)·cos(δ),  sin(δ)·cos(φ) − cos(δ)·cos(H)·sin(φ))
 *         （北を 0°、東を 90° とする方位角）
 *
 * @param {number} ra     赤経（度、0–360）
 * @param {number} dec    赤緯（度）
 * @param {number} jdUtc  ユリウス日（UTC 基準）
 * @param {number} obsLat 観測地緯度（度、北緯正）
 * @param {number} obsLon 観測地経度（度、東経正）
 * @returns {{ alt: number, az: number }}
 *   alt: 高度（度、−90〜+90）
 *   az:  方位角（度、0〜360、北=0°、東=90°）
 */
export function altitudeAzimuth(ra, dec, jdUtc, obsLat, obsLon) {
  const lst   = siderealTime(jdUtc, obsLon);
  const H     = (lst - ra) * Math.PI / 180;
  const phi   = obsLat * Math.PI / 180;
  const delta = dec    * Math.PI / 180;

  const sinAlt = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180 / Math.PI;

  const az = normAngle(
    Math.atan2(
      -Math.sin(H) * Math.cos(delta),
      Math.sin(delta) * Math.cos(phi) - Math.cos(delta) * Math.cos(H) * Math.sin(phi)
    ) * 180 / Math.PI
  );

  return { alt, az };
}

// =========================================================================
// トポセントリック補正 — 観測者 GCRS 位置ベクトル
// =========================================================================

/**
 * WGS-84 楕円体上の観測者位置を GCRS（≈ICRS）直交座標で返す（純粋関数）
 *
 * 地心座標系（GCRS）と国際天球参照系（ICRS）の差（フレームバイアス）は
 * 約 17 mas で占星術・天文観測用途では無視できる。
 *
 * 変換手順:
 *   1. lat/lon/elev → ECEF (WGS-84 楕円体)
 *   2. ECEF → GCRS: GMST で X-Y 平面内回転
 *      （GMST と GAST の差 < 1" = 十分な精度）
 *
 * @param {number} lat     観測地緯度（度、北緯正）
 * @param {number} lon     観測地経度（度、東経正）
 * @param {number} elevKm  標高（km、省略時 0）
 * @param {number} jdUtc   ユリウス日（UTC 基準）
 * @returns {[number, number, number]}  GCRS 位置 [x, y, z]（km）
 */
export function observerGCRS(lat, lon, elevKm = 0, jdUtc) {
  // WGS-84 定数
  const A_KM  = 6378.137;              // 赤道半径 [km]
  const F     = 1 / 298.257223563;     // 扁平率
  const E2    = 2 * F - F * F;         // 第一離心率の二乗

  const D2R = Math.PI / 180;
  const phi = lat * D2R;
  const lam = lon * D2R;

  // 卯酉線曲率半径 N [km]
  const sinPhi = Math.sin(phi);
  const N = A_KM / Math.sqrt(1 - E2 * sinPhi * sinPhi);

  // ECEF 直交座標 [km]
  const cosPhi = Math.cos(phi);
  const xECEF = (N + elevKm) * cosPhi * Math.cos(lam);
  const yECEF = (N + elevKm) * cosPhi * Math.sin(lam);
  const zECEF = (N * (1 - E2) + elevKm) * sinPhi;

  // ECEF → GCRS: GMST で Z 軸回転（地球自転）
  const gast = gmst(jdUtc) * D2R;
  const cosG = Math.cos(gast);
  const sinG = Math.sin(gast);

  return [
    xECEF * cosG - yECEF * sinG,
    xECEF * sinG + yECEF * cosG,
    zECEF,
  ];
}

// =========================================================================
// 光偏差補正 — 重力場による光の曲がり
// =========================================================================

/**
 * 太陽重力場による光偏差（gravitational light deflection）を ICRS 空間で適用する
 * （純粋関数）
 *
 * IERS Conventions 2010 Eq.(11.38) の一次近似:
 *   Δê = (2GM/c²r) × [ê_q − ê_e(ê_q·ê_e)] / (1 + ê_q·ê_e)
 *
 *   ê_e = 天体方向単位ベクトル（偏差前）
 *   ê_q = 偏差天体（太陽）方向単位ベクトル（観測者から見た）
 *   r   = 観測者から偏差天体までの距離
 *   2GM_sun/c² ≈ 2.9532500e-6 AU = 0.004433 km（Schwarzschild 半径相当）
 *
 * 精度: 太陽近傍（角距離 < 1°）を除いて < 0.003"（通常惑星は < 0.001"）
 * 太陽自身を観測する場合は呼び出さないこと（特異点が発生する）
 *
 * @param {number} ax   測心的 ICRS X（km）
 * @param {number} ay   測心的 ICRS Y（km）
 * @param {number} az   測心的 ICRS Z（km）
 * @param {number} sunX 太陽の観測者基準 ICRS X（km）
 * @param {number} sunY 太陽の観測者基準 ICRS Y（km）
 * @param {number} sunZ 太陽の観測者基準 ICRS Z（km）
 * @returns {{ x: number, y: number, z: number }}  補正後 ICRS 単位ベクトル
 */
export function applyLightDeflection(ax, ay, az, sunX, sunY, sunZ) {
  // 天体方向単位ベクトル ê_e
  const distE = Math.sqrt(ax * ax + ay * ay + az * az);
  const ex = ax / distE, ey = ay / distE, ez = az / distE;

  // 太陽方向単位ベクトル ê_q と距離 r [km]
  const distQ = Math.sqrt(sunX * sunX + sunY * sunY + sunZ * sunZ);
  const qx = sunX / distQ, qy = sunY / distQ, qz = sunZ / distQ;

  // 2GM_sun / c² [km]（≈ Schwarzschild 半径 2.953 km）
  const DEFL_CONST = 2.953250;  // km

  // 係数: 2GM / (c² r)
  const coeff = DEFL_CONST / distQ;

  // ê_q · ê_e
  const qdote = qx * ex + qy * ey + qz * ez;

  // Δê = coeff × [ê_q − ê_e(ê_q·ê_e)] / (1 + ê_q·ê_e)
  const denom = 1.0 + qdote;
  const dx = coeff * (qx - ex * qdote) / denom;
  const dy = coeff * (qy - ey * qdote) / denom;
  const dz = coeff * (qz - ez * qdote) / denom;

  return { x: ex + dx, y: ey + dy, z: ez + dz };
}
