/**
 * timescale.js — 時刻系変換モジュール
 *
 * Layer 1: core（constants.js に依存）
 *
 * Skyfield（Python）が内部で処理していた時刻変換を JS で再実装する。
 * spacefield/timescale.py の機能をブラウザ向けに移植。
 *
 * 提供する変換:
 *   JST / ローカル時刻 → UTC → JD(UT1) → TT → TDB
 *   JD → カレンダー日時
 *   ΔT 計算（Espenak & Meeus 2006）
 *   TDB-TT 補正（Fairhead & Bretagnon 1990 近似）
 *   時代判定（ancient / medieval / premodern / modern）
 *
 * ライセンス: MIT
 * アルゴリズム出典:
 *   - Meeus "Astronomical Algorithms" 2nd ed.（暦変換、JD）
 *   - Espenak & Meeus 2006 NASA TP-2006-214141（ΔT）
 *   - Fairhead & Bretagnon 1990（TDB-TT）
 *   - spacefield/timescale.py（設計参考）
 */

'use strict';

import {
  J2000_JD,
  JULIAN_CENTURY,
  TT_MINUS_TAI_SECONDS,
  GREGORIAN_CUTOVER_JDN,
  GREGORIAN_CUTOVER_YEAR,
  GREGORIAN_CUTOVER_MONTH,
  GREGORIAN_CUTOVER_DAY,
  DELTA_T_TABLE,
  MODERN_DT,
} from './constants.js';

// =========================================================================
// JDN ↔ 暦変換（内部関数）
// Meeus "Astronomical Algorithms" Ch.7
// =========================================================================

/**
 * グレゴリオ暦 → Julian Day Number（整数部）
 * @param {number} year 天文学方式年（Year 0 あり）
 * @param {number} month
 * @param {number} day
 * @returns {number} JDN
 */
function _jdnGregorian(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y
       + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

/**
 * ユリウス暦 → Julian Day Number（整数部）
 * @param {number} year 天文学方式年
 * @param {number} month
 * @param {number} day
 * @returns {number} JDN
 */
function _jdnJulian(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
}

/**
 * JDN → グレゴリオ暦 [year, month, day]
 * @param {number} jdn
 * @returns {[number, number, number]}
 */
function _dateGregorian(jdn) {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor(146097 * b / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor(1461 * d / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day   = e + 1 - Math.floor((153 * m + 2) / 5);
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year  = 100 * b + d - 4800 + Math.floor(m / 10);
  return [year, month, day];
}

/**
 * JDN → ユリウス暦 [year, month, day]（天文学方式）
 * @param {number} jdn
 * @returns {[number, number, number]}
 */
function _dateJulian(jdn) {
  const c = jdn + 32082;
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor(1461 * d / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day   = e + 1 - Math.floor((153 * m + 2) / 5);
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year  = d - 4800 + Math.floor(m / 10);
  return [year, month, day];
}

/**
 * 1582-10-05〜10-14 の欠番日かどうか
 * @param {number} year @param {number} month @param {number} day
 * @returns {boolean}
 */
function _isGregorianGap(year, month, day) {
  return year === 1582 && month === 10 && day >= 5 && day <= 14;
}

// =========================================================================
// 公開 API: JD ↔ 日付変換
// =========================================================================

/**
 * 日付・時刻 → ユリウス日（JD）
 *
 * @param {number} year  天文学方式年（Year 0 あり。BC 1 = 0, BC 2 = -1）
 * @param {number} month
 * @param {number} day
 * @param {number} [hour=0]
 * @param {number} [minute=0]
 * @param {number} [second=0]
 * @param {'auto'|'gregorian'|'julian'} [calendar='auto']
 *   'auto' — 1582-10-15 を境界に自動切り替え
 *   'gregorian' — グレゴリオ暦を強制（先行グレゴリオ暦を含む）
 *   'julian' — ユリウス暦を強制
 * @returns {number} JD（UTC基準）
 * @throws {Error} 1582 年グレゴリオ改暦の欠番日を 'gregorian' 強制で指定した場合
 */
export function dateToJd(year, month, day, hour = 0, minute = 0, second = 0, calendar = 'auto') {
  if (_isGregorianGap(year, month, day) && calendar === 'gregorian') {
    throw new Error(
      `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} は` +
      `グレゴリオ暦に存在しない日付です（1582年の改暦で欠番）。` +
      `calendar='julian' を指定してください。`
    );
  }

  let jdn;
  if (calendar === 'gregorian') {
    jdn = _jdnGregorian(year, month, day);
  } else if (calendar === 'julian') {
    jdn = _jdnJulian(year, month, day);
  } else {
    // auto: 1582-10-15 以降はグレゴリオ、それ以前はユリウス
    const isGreg = year > GREGORIAN_CUTOVER_YEAR ||
      (year === GREGORIAN_CUTOVER_YEAR && month > GREGORIAN_CUTOVER_MONTH) ||
      (year === GREGORIAN_CUTOVER_YEAR && month === GREGORIAN_CUTOVER_MONTH && day >= GREGORIAN_CUTOVER_DAY);
    jdn = isGreg ? _jdnGregorian(year, month, day) : _jdnJulian(year, month, day);
  }

  const timeFrac = (hour + minute / 60 + second / 3600) / 24;
  return jdn - 0.5 + timeFrac;  // JD = JDN - 0.5（JD はUT正午起点）
}

/**
 * ユリウス日（JD）→ 日付・時刻
 *
 * @param {number} jd
 * @param {'auto'|'gregorian'|'julian'} [calendar='auto']
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 *   year: 天文学方式（Year 0 あり）
 */
export function jdToDate(jd, calendar = 'auto') {
  // JD は UT 正午起点。JDN は JD + 0.5 の整数部
  const jd05 = jd + 0.5;
  const jdn = Math.floor(jd05);
  const frac = jd05 - jdn;

  let year, month, day;
  if (calendar === 'gregorian') {
    [year, month, day] = _dateGregorian(jdn);
  } else if (calendar === 'julian') {
    [year, month, day] = _dateJulian(jdn);
  } else {
    [year, month, day] = jdn >= GREGORIAN_CUTOVER_JDN
      ? _dateGregorian(jdn)
      : _dateJulian(jdn);
  }

  // ミリ秒単位に丸めて浮動小数点誤差を抑制する
  // （例: 68459.9999... → 68460 ms → minute=1 が正しく得られる）
  const totalMs = Math.round(frac * 86400000);
  const hour   = Math.floor(totalMs / 3600000);
  const minute = Math.floor((totalMs % 3600000) / 60000);
  const second = (totalMs % 60000) / 1000;

  return { year, month, day, hour, minute, second };
}

// =========================================================================
// 年号変換（天文学方式 ↔ 歴史学方式）
// =========================================================================

/**
 * 天文学方式年 → 歴史学方式 (BC/AD)
 * @param {number} year 天文学方式（Year 0 あり）
 * @returns {{ absYear: number, era: 'BC'|'AD' }}
 */
export function astroYearToHistorical(year) {
  if (year <= 0) return { absYear: 1 - year, era: 'BC' };
  return { absYear: year, era: 'AD' };
}

/**
 * 歴史学方式 → 天文学方式年
 * @param {number} absYear 年の絶対値（正整数）
 * @param {'BC'|'AD'} [era='AD']
 * @returns {number} 天文学方式年
 */
export function historicalYearToAstro(absYear, era = 'AD') {
  return era.toUpperCase() === 'BC' ? 1 - absYear : absYear;
}

// =========================================================================
// ΔT 計算（Espenak & Meeus 2006）
// =========================================================================

/**
 * ΔT = TT − UT1（秒）を計算する
 *
 * 2016年以降: MODERN_DT テーブルから線形補間（IERS 実測値ベース）
 *   - TT − UTC = 69.184 秒固定（2017-01-01 以降、ΔAT = 37 秒）
 *   - ΔT = 69.184 − ΔUT1（ΔUT1 = UT1 − UTC、IERS が管理）
 *
 * 2016年未満: Espenak & Meeus 2006, NASA TP-2006-214141 多項式
 *
 * @param {number} year 年（小数可。例: 2026.25 = 2026年3月末頃）
 * @returns {number} ΔT（秒）
 */
export function deltaT(year) {
  // 2017年以降: IERS 実測値テーブルで線形補間
  // （Espenak & Meeus 多項式は 2017 年以降に +5〜6 秒の系統誤差があるため）
  const modernStart = MODERN_DT[0][0];
  if (year >= modernStart) {
    return _linearInterpDt(MODERN_DT, year);
  }

  // 歴史的日付: Espenak & Meeus 多項式
  for (const entry of DELTA_T_TABLE) {
    if (year >= entry.from && year < entry.to) {
      const u = (year - entry.u_base) / entry.u_scale;
      return _polyEval(entry.coeffs, u);
    }
  }
  // フォールバック（テーブル外: 起こらないはずだが念のため）
  const u = (year - 1820) / 100;
  return -20 + 32 * u * u;
}

/**
 * MODERN_DT テーブルから線形補間で ΔT を返す（内部用）
 *
 * テーブル末尾を超えた場合は最後の2点で外挿する。
 * @param {ReadonlyArray<[number, number]>} table  [[year, dt], ...]
 * @param {number} year
 * @returns {number}
 */
function _linearInterpDt(table, year) {
  // テーブル末尾を超えた場合: 最後の2点で線形外挿
  const last = table[table.length - 1];
  if (year >= last[0]) {
    const prev = table[table.length - 2];
    const slope = (last[1] - prev[1]) / (last[0] - prev[0]);
    return last[1] + slope * (year - last[0]);
  }
  // テーブル内: 線形補間
  for (let i = 0; i < table.length - 1; i++) {
    const [y0, dt0] = table[i];
    const [y1, dt1] = table[i + 1];
    if (year >= y0 && year < y1) {
      return dt0 + (dt1 - dt0) * (year - y0) / (y1 - y0);
    }
  }
  return table[0][1];
}

/**
 * 多項式を評価する（内部用）
 * p(u) = c[0] + c[1]*u + c[2]*u^2 + ...
 * @param {number[]} coeffs
 * @param {number} u
 * @returns {number}
 */
function _polyEval(coeffs, u) {
  let result = 0;
  let upow = 1;
  for (const c of coeffs) {
    result += c * upow;
    upow *= u;
  }
  return result;
}

/**
 * JD(UTC) から ΔT を計算する
 * JD から年（小数）を求めてから deltaT() を呼ぶ。
 * @param {number} jd JD (UTC)
 * @returns {number} ΔT（秒）
 */
export function deltaTFromJd(jd) {
  const year = 2000 + (jd - J2000_JD) / 365.25;
  return deltaT(year);
}

// =========================================================================
// 時刻系変換: UTC → TT → TDB
// =========================================================================

/**
 * JD(UTC) → JD(TT)（地球時）
 *
 * TT = UTC + ΔT
 * ΔT = TT − UTC（秒）
 *
 * @param {number} jdUtc JD（UTC基準）
 * @returns {number} JD（TT基準）
 */
export function jdUtcToTt(jdUtc) {
  const dt = deltaTFromJd(jdUtc);   // 秒
  return jdUtc + dt / 86400;
}

/**
 * JD(TT) → JD(UTC)
 * @param {number} jdTt JD（TT基準）
 * @returns {number} JD（UTC基準）
 */
export function jdTtToUtc(jdTt) {
  // 近似: jdTt ≈ jdUtc なので ΔT は jdTt から求めて逆算
  const dt = deltaTFromJd(jdTt);
  return jdTt - dt / 86400;
}

/**
 * JD(TT) → JD(TDB)（太陽系力学時）
 *
 * TDB - TT = 0.001657 * sin(M + 0.01671 * sin(M)) [秒]
 * M = 6.24006 + 628.302 * T  (T: J2000.0 からのユリウス世紀)
 *
 * 出典: Fairhead & Bretagnon 1990（0.1ms 精度の近似式）
 *
 * @param {number} jdTt JD（TT基準）
 * @returns {number} JD（TDB基準）
 */
export function jdTtToTdb(jdTt) {
  const T = (jdTt - J2000_JD) / JULIAN_CENTURY;
  const M = 6.24006 + 628.302 * T;           // 地球の平均近点角（rad）
  const tdbMinusTt = 0.001657 * Math.sin(M + 0.01671 * Math.sin(M));  // 秒
  return jdTt + tdbMinusTt / 86400;
}

/**
 * JD(UTC) → JD(TDB)（天体暦に渡す基準時刻）
 *
 * 変換パイプライン: UTC → TT → TDB
 *
 * @param {number} jdUtc JD（UTC基準）
 * @returns {number} JD（TDB基準）
 */
export function jdUtcToTdb(jdUtc) {
  return jdTtToTdb(jdUtcToTt(jdUtc));
}

// =========================================================================
// JST / ローカル時刻 → JD 変換
// =========================================================================

/**
 * JST（日本標準時）→ JD(UTC)
 *
 * @param {number} year @param {number} month @param {number} day
 * @param {number} [hour=0] @param {number} [minute=0] @param {number} [second=0]
 * @param {'auto'|'gregorian'|'julian'} [calendar='auto']
 * @returns {number} JD（UTC）
 */
export function jstToJdUtc(year, month, day, hour = 0, minute = 0, second = 0, calendar = 'auto') {
  const jdJst = dateToJd(year, month, day, hour, minute, second, calendar);
  return jdJst - 9 / 24;   // JST = UTC + 9h → UTC = JST - 9h
}

/**
 * UTC オフセット付きローカル時刻 → JD(UTC)
 *
 * @param {number} year @param {number} month @param {number} day
 * @param {number} hour @param {number} minute @param {number} second
 * @param {number} utcOffsetHours  UTC との差（時間）。例: 日本=9, NY冬=-5
 * @param {'auto'|'gregorian'|'julian'} [calendar='auto']
 * @returns {number} JD（UTC）
 */
export function localToJdUtc(year, month, day, hour, minute, second, utcOffsetHours, calendar = 'auto') {
  const jdLocal = dateToJd(year, month, day, hour, minute, second, calendar);
  return jdLocal - utcOffsetHours / 24;
}

// =========================================================================
// JD(UTC) → 地方太陽時（経度ベース、古代観測地用）
// =========================================================================

/**
 * JD(UTC) → 地方平均太陽時（経度ベース）
 *
 * タイムゾーンが存在しない古代において観測地の地方時を推定する。
 * 地方太陽時 = UTC + (経度 / 15) 時間。
 *
 * @param {number} jdUt  JD（UT基準）
 * @param {number} longitudeDeg  東経（度）。西経は負。バビロン ≈ 44.4
 * @returns {{ jdLocal: number, offsetHours: number,
 *             year: number, month: number, day: number,
 *             hour: number, minute: number, second: number }}
 */
export function jdToLocalSolarTime(jdUt, longitudeDeg) {
  const offsetHours = longitudeDeg / 15;
  const jdLocal = jdUt + offsetHours / 24;
  const { year, month, day, hour, minute, second } = jdToDate(jdLocal);
  return { jdLocal, offsetHours, year, month, day, hour, minute, second };
}

// =========================================================================
// 時代区分（ERA）
// =========================================================================

export const ERA = Object.freeze({
  MODERN:    'modern',     // 1888〜: 標準時制定後
  PREMODERN: 'premodern',  // 1582〜1887: グレゴリオ暦後・標準時制定前
  MEDIEVAL:  'medieval',   // AD 1〜1581: ユリウス暦時代
  ANCIENT:   'ancient',    // BC: 古代
});

/**
 * 年（天文学方式）から時代区分メタデータを返す
 *
 * @param {number} year 天文学方式年
 * @param {number} [dtSeconds] ΔT（秒）。省略時は deltaT(year) を使用
 * @returns {{
 *   era: string,
 *   year: number,
 *   timezoneValid: boolean,
 *   timePrecision: string,
 *   ascMcNote: string|null,
 *   deltaT: number,
 *   deltaTHours: number
 * }}
 */
export function classifyEra(year, dtSeconds) {
  const dt = dtSeconds !== undefined ? dtSeconds : deltaT(year);
  const dtHours = Math.abs(dt) / 3600;

  if (year >= 1888) {
    return { era: ERA.MODERN, year, timezoneValid: true,
             timePrecision: 'high', ascMcNote: null, deltaT: dt, deltaTHours: dtHours };
  }
  if (year >= 1582) {
    return { era: ERA.PREMODERN, year, timezoneValid: false,
             timePrecision: 'medium',
             ascMcNote: '標準時未制定。地方太陽時（経度ベース）が正確',
             deltaT: dt, deltaTHours: dtHours };
  }
  if (year >= 1) {
    return { era: ERA.MEDIEVAL, year, timezoneValid: false,
             timePrecision: 'low',
             ascMcNote: 'ΔT不確実性 ±数分〜数十分。ASC/MC に数度の誤差',
             deltaT: dt, deltaTHours: dtHours };
  }
  return { era: ERA.ANCIENT, year, timezoneValid: false,
           timePrecision: 'very_low',
           ascMcNote: 'ΔT不確実性 ±数時間。ASC/MC は参考値（±数十度の誤差）',
           deltaT: dt, deltaTHours: dtHours };
}

// =========================================================================
// TDBDatetime クラス
// =========================================================================

/**
 * TDB（太陽系重心力学時）ベースの日時クラス
 *
 * 内部的に JD(TDB) を保持し、各時刻系への変換を提供する。
 * .bsp ファイルの計算に直接渡せる JD(TDB) が主役。
 *
 * 例:
 *   const dt = TDBDatetime.fromJst(2025, 11, 10, 4, 1);
 *   dt.tdb       // → JD(TDB)
 *   dt.toUtc()   // → { year, month, day, hour, minute, second }
 *   dt.era       // → 'modern'
 */
export class TDBDatetime {
  /**
   * @param {number} jdTdb JD（TDB基準）
   * @param {number} jdUtc JD（UTC基準）— 時代区分・表示に使用
   */
  constructor(jdTdb, jdUtc) {
    this._jdTdb = jdTdb;
    this._jdUtc = jdUtc;
  }

  /** JD(TDB)。天体暦 (.bsp) の計算に渡す値 */
  get tdb() { return this._jdTdb; }

  /** JD(UTC) */
  get utc() { return this._jdUtc; }

  /** JD(TT) */
  get tt() { return jdUtcToTt(this._jdUtc); }

  /** UTC の日時オブジェクト */
  toUtc() { return jdToDate(this._jdUtc); }

  /** TT の日時オブジェクト */
  toTt() { return jdToDate(this.tt); }

  /** JST の日時オブジェクト */
  toJst() { return jdToDate(this._jdUtc + 9 / 24); }

  /** ΔT（秒） */
  get deltaT() { return deltaTFromJd(this._jdUtc); }

  /** 時代区分メタデータ */
  get era() {
    const { year } = this.toUtc();
    return classifyEra(year, this.deltaT).era;
  }

  /** 時代区分メタデータ（詳細） */
  get eraInfo() {
    const { year } = this.toUtc();
    return classifyEra(year, this.deltaT);
  }

  // -----------------------------------------------------------------------
  // ファクトリーメソッド
  // -----------------------------------------------------------------------

  /**
   * UTC から生成
   * @param {number} year @param {number} month @param {number} day
   * @param {number} [hour=0] @param {number} [minute=0] @param {number} [second=0]
   * @param {'auto'|'gregorian'|'julian'} [calendar='auto']
   * @returns {TDBDatetime}
   */
  static fromUtc(year, month, day, hour = 0, minute = 0, second = 0, calendar = 'auto') {
    const jdUtc = dateToJd(year, month, day, hour, minute, second, calendar);
    const jdTdb = jdUtcToTdb(jdUtc);
    return new TDBDatetime(jdTdb, jdUtc);
  }

  /**
   * JST から生成
   * @param {number} year @param {number} month @param {number} day
   * @param {number} [hour=0] @param {number} [minute=0] @param {number} [second=0]
   * @param {'auto'|'gregorian'|'julian'} [calendar='auto']
   * @returns {TDBDatetime}
   */
  static fromJst(year, month, day, hour = 0, minute = 0, second = 0, calendar = 'auto') {
    const jdUtc = jstToJdUtc(year, month, day, hour, minute, second, calendar);
    const jdTdb = jdUtcToTdb(jdUtc);
    return new TDBDatetime(jdTdb, jdUtc);
  }

  /**
   * UTC オフセット付きローカル時刻から生成
   * @param {number} year @param {number} month @param {number} day
   * @param {number} hour @param {number} minute @param {number} second
   * @param {number} utcOffsetHours  例: 9 (JST), -5 (EST), 5.5 (IST)
   * @param {'auto'|'gregorian'|'julian'} [calendar='auto']
   * @returns {TDBDatetime}
   */
  static fromLocal(year, month, day, hour, minute, second, utcOffsetHours, calendar = 'auto') {
    const jdUtc = localToJdUtc(year, month, day, hour, minute, second, utcOffsetHours, calendar);
    const jdTdb = jdUtcToTdb(jdUtc);
    return new TDBDatetime(jdTdb, jdUtc);
  }

  /**
   * JD(UTC) から生成
   * @param {number} jdUtc
   * @returns {TDBDatetime}
   */
  static fromJdUtc(jdUtc) {
    return new TDBDatetime(jdUtcToTdb(jdUtc), jdUtc);
  }

  /**
   * JD(TDB) から直接生成（TDB が既知の場合）
   * @param {number} jdTdb
   * @returns {TDBDatetime}
   */
  static fromJdTdb(jdTdb) {
    // UTC の近似: ΔT≈64秒（現代）で逆算。精度要求がある場合は反復法を使用
    const jdUtc = jdTtToUtc(jdTdb);   // TDB ≈ TT の近似
    return new TDBDatetime(jdTdb, jdUtc);
  }
}
