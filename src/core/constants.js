/**
 * constants.js — IAU / IERS / JPL 天文基本定数
 *
 * Layer 1: core（依存なし）
 * 出典:
 *   - IAU 2006 Resolution B1, B2, B3
 *   - Meeus "Astronomical Algorithms" 2nd ed.
 *   - Espenak & Meeus 2006 (NASA TechReport)
 *   - JPL DE440s / NAIF body codes
 *
 * ライセンス: MIT（数式・定数値は公知の科学的事実であり著作権なし）
 */

'use strict';

// =========================================================================
// 時刻・暦
// =========================================================================

/** J2000.0 エポック (2000-01-01T12:00:00 TT) のユリウス日 */
export const J2000_JD = 2451545.0;

/** 1 ユリウス世紀 = 36525 日 */
export const JULIAN_CENTURY = 36525.0;

/** 1 ユリウス年 = 365.25 日 */
export const JULIAN_YEAR = 365.25;

/** グレゴリオ暦施行日 (1582-10-15) の Julian Day Number */
export const GREGORIAN_CUTOVER_JDN = 2299161;

/** グレゴリオ暦施行年 */
export const GREGORIAN_CUTOVER_YEAR = 1582;

/** グレゴリオ暦施行月 */
export const GREGORIAN_CUTOVER_MONTH = 10;

/** グレゴリオ暦施行日 */
export const GREGORIAN_CUTOVER_DAY = 15;

// =========================================================================
// 時刻系オフセット
// =========================================================================

/**
 * TT - TAI の固定オフセット（秒）
 * IAU 1991 Resolution A.4
 */
export const TT_MINUS_TAI_SECONDS = 32.184;

/**
 * TDB - TT の最大振れ幅（秒）
 * Fairhead & Bretagnon 1990 の近似式の係数
 */
export const TDB_TT_AMPLITUDE = 0.001657;

/** TDB-TT の主要周期に関わる角速度係数（rad/日） */
export const TDB_TT_OMEGA = 628.3076;    // 地球公転の角速度（rad/cy → rad/day に変換済み）

// =========================================================================
// 物理定数
// =========================================================================

/** 天文単位 AU（m）— IAU 2012 */
export const AU_M = 149597870700;

/** 天文単位 AU（km） */
export const AU_KM = 149597870.700;

/** 光速（m/s）— IAU */
export const SPEED_OF_LIGHT_M_S = 299792458.0;

/** 光速（AU/日） */
export const SPEED_OF_LIGHT_AU_DAY = 173.14463267424034;

// =========================================================================
// 角度換算
// =========================================================================

/** π */
export const PI = Math.PI;

/** 2π */
export const TWO_PI = 2 * Math.PI;

/** 度 → ラジアン */
export const DEG_TO_RAD = Math.PI / 180.0;

/** ラジアン → 度 */
export const RAD_TO_DEG = 180.0 / Math.PI;

/** 秒角 → ラジアン */
export const ARCSEC_TO_RAD = Math.PI / (180.0 * 3600.0);

// =========================================================================
// JPL DE440s — NAIF ボディコード
// DE440s (.bsp) 内でセグメントを識別するターゲット番号
// 出典: JPL NAIF / SPICE Toolkit ユーザーガイド
// =========================================================================

export const NAIF = Object.freeze({
  /** 太陽系重心 (Solar System Barycenter) */
  SSB: 0,

  /** 水星重心 */
  MERCURY_BARYCENTER: 1,
  /** 金星重心 */
  VENUS_BARYCENTER: 2,
  /** 地球月系重心 */
  EMB: 3,
  /** 火星重心 */
  MARS_BARYCENTER: 4,
  /** 木星重心 */
  JUPITER_BARYCENTER: 5,
  /** 土星重心 */
  SATURN_BARYCENTER: 6,
  /** 天王星重心 */
  URANUS_BARYCENTER: 7,
  /** 海王星重心 */
  NEPTUNE_BARYCENTER: 8,
  /** 冥王星重心 */
  PLUTO_BARYCENTER: 9,

  /** 太陽 */
  SUN: 10,

  /** 月 */
  MOON: 301,
  /** 地球 */
  EARTH: 399,

  /** 水星（inertial center） */
  MERCURY: 199,
  /** 金星 */
  VENUS: 299,
  /** 火星 */
  MARS: 499,
});

/**
 * 占星術で使う天体の NAIF コードマッピング
 * bsp-reader.js でセグメント検索に使用
 */
export const PLANET_NAIF = Object.freeze({
  Sun:     NAIF.SUN,
  Moon:    NAIF.MOON,
  Mercury: NAIF.MERCURY_BARYCENTER,
  Venus:   NAIF.VENUS_BARYCENTER,
  Earth:   NAIF.EARTH,
  Mars:    NAIF.MARS_BARYCENTER,
  Jupiter: NAIF.JUPITER_BARYCENTER,
  Saturn:  NAIF.SATURN_BARYCENTER,
  Uranus:  NAIF.URANUS_BARYCENTER,
  Neptune: NAIF.NEPTUNE_BARYCENTER,
  Pluto:   NAIF.PLUTO_BARYCENTER,
  EMB:     NAIF.EMB,
  SSB:     NAIF.SSB,
});

// =========================================================================
// ΔT（TT − UTC）多項式近似係数
// Espenak & Meeus 2006 (NASA Technical Publication TP-2006-214141)
// 各区間は [yearFrom, yearTo, coefficients] の形式
// 係数は c0 + c1*u + c2*u^2 + ... （u は各区間の正規化変数）
// =========================================================================

/**
 * ΔT 近似テーブル（Espenak & Meeus 2006）
 * 各エントリ: { from, to, u_base, u_scale, coeffs }
 *   - u = (year - u_base) / u_scale
 *   - ΔT = coeffs[0] + coeffs[1]*u + coeffs[2]*u^2 + ...（単位: 秒）
 */
export const DELTA_T_TABLE = Object.freeze([
  // Before -500
  { from: -Infinity, to: -500,
    u_base: -1820, u_scale: 100,
    coeffs: [-20, 0, 32] },

  // -500 to +500
  { from: -500, to: 500,
    u_base: 0, u_scale: 100,
    coeffs: [10583.6, -1014.41, 33.78311, -5.952053, -0.1798452, 0.022174192, 0.0090316521] },

  // +500 to +1600
  { from: 500, to: 1600,
    u_base: 1000, u_scale: 100,
    coeffs: [1574.2, -556.01, 71.23472, 0.319781, -0.8503463, -0.005050998, 0.0083572073] },

  // 1600 to 1700
  { from: 1600, to: 1700,
    u_base: 1600, u_scale: 1,
    coeffs: [120, -0.9808, -0.01532, 1.0 / 7129] },

  // 1700 to 1800
  { from: 1700, to: 1800,
    u_base: 1700, u_scale: 1,
    coeffs: [8.83, 0.1603, -0.0059285, 0.00013336, -1.0 / 1174000] },

  // 1800 to 1860
  { from: 1800, to: 1860,
    u_base: 1800, u_scale: 1,
    coeffs: [13.72, -0.332447, 0.0068612, 0.0041116, -0.00037436,
             0.0000121272, -0.0000001699, 0.000000000875] },

  // 1860 to 1900
  { from: 1860, to: 1900,
    u_base: 1860, u_scale: 1,
    coeffs: [7.62, 0.5737, -0.251754, 0.01680668, -0.0004473624,
             1.0 / 233174] },

  // 1900 to 1920
  { from: 1900, to: 1920,
    u_base: 1900, u_scale: 1,
    coeffs: [-2.79, 1.494119, -0.0598939, 0.0061966, -0.000197] },

  // 1920 to 1941
  { from: 1920, to: 1941,
    u_base: 1920, u_scale: 1,
    coeffs: [21.20, 0.84493, -0.076100, 0.0020936] },

  // 1941 to 1961
  { from: 1941, to: 1961,
    u_base: 1950, u_scale: 1,
    coeffs: [29.07, 0.407, -1.0 / 233, 1.0 / 2547] },

  // 1961 to 1986
  { from: 1961, to: 1986,
    u_base: 1975, u_scale: 1,
    coeffs: [45.45, 1.067, -1.0 / 260, -1.0 / 718] },

  // 1986 to 2005
  { from: 1986, to: 2005,
    u_base: 2000, u_scale: 1,
    coeffs: [63.86, 0.3345, -0.060374, 0.0017275, 0.000651814, 0.00002373599] },

  // 2005 to 2050
  { from: 2005, to: 2050,
    u_base: 2000, u_scale: 1,
    coeffs: [62.92, 0.32217, 0.005589] },

  // 2050 to 2150
  { from: 2050, to: 2150,
    u_base: 1820, u_scale: 100,
    coeffs: [-205.72, 56.28, 32] },

  // 2150 and beyond
  { from: 2150, to: Infinity,
    u_base: 1820, u_scale: 100,
    coeffs: [-20, 0, 32] },
]);

/**
 * 現代暦 ΔT テーブル（2016〜2030）
 *
 * Espenak & Meeus 2006 多項式は 2016 年以降に大きく乖離するため、
 * IERS 実測値（Bulletin A / Final values）で上書きする。
 *
 * 背景:
 *   2017-01-01 以降、うるう秒の追加はない（ΔAT = 37 秒で固定）。
 *   TT − UTC = 37 + 32.184 = 69.184 秒（定数）
 *   ΔT = TT − UT1 = 69.184 − ΔUT1  （ΔUT1 = UT1 − UTC ∈ [−0.9, +0.9]）
 *
 * 各行: [年初値（小数年）, ΔT（秒）]
 * 年の間は線形補間。2028 以降は外挿（±1 秒程度の精度）。
 *
 * 出典: IERS Bulletin A / USNO (2026-03-26 時点での最終確認値)
 * 2025.0 以降は IERS 予測値に基づく推定。
 */
export const MODERN_DT = Object.freeze([
  //  [year,   ΔT(s)]
  // 2017-01-01: うるう秒追加（ΔAT = 37）→ TT−UTC = 69.184s 固定
  // ΔT = TT − UT1 = 69.184 − ΔUT1（IERS Bulletin A 実測値）
  [ 2017.0,  68.97 ],
  [ 2018.0,  69.22 ],
  [ 2019.0,  69.29 ],
  [ 2020.0,  69.36 ],
  [ 2021.0,  69.36 ],
  [ 2022.0,  69.18 ],
  [ 2023.0,  69.06 ],
  [ 2024.0,  68.97 ],
  [ 2025.0,  69.10 ],  // IERS 予測
  [ 2026.0,  69.22 ],  // IERS 予測
  [ 2027.0,  69.36 ],  // 推定
  [ 2028.0,  69.50 ],  // 推定（以降は線形外挿）
  [ 2030.0,  69.80 ],  // 推定
]);
