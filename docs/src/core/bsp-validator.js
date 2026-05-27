/**
 * bsp-validator.js — BSP 天体暦のカバー範囲検証
 *
 * BSP ファイルは SPK フォーマットに従い、セグメントの時刻範囲を
 * 「J2000.0 からの秒数」で格納している。
 * このモジュールはその値を JD（ユリウス日）に変換し、
 * 入力日時が天体暦のカバー範囲内かを検証する。
 *
 * 使い方:
 *   import { assertInCoverage } from './bsp-validator.js';
 *   assertInCoverage(jdTdb, bspFile);  // 範囲外なら RangeError を throw
 *
 * NAIF ターゲット 10（太陽）のセグメントをカバー範囲の代表値として使用する。
 * 太陽は全惑星の中で最広カバーを持つため、他天体の範囲もこれに包含される。
 */

import { J2000_JD } from './constants.js';

const S_PER_DAY = 86400.0;
const NAIF_SUN  = 10;

/**
 * BSP ファイルのカバー範囲を JD で返す
 *
 * セグメントの startSec / endSec は「J2000.0 からの秒数」で格納されているため
 * JD に変換して返す。
 *
 * @param {import('./bsp-reader.js').BspFile} bspFile
 * @param {number} [naifTarget=10]  代表天体の NAIF コード（デフォルト: 太陽）
 * @returns {{ startJd: number, endJd: number }}
 */
export function getCoverageJd(bspFile, naifTarget = NAIF_SUN) {
  // 指定天体のセグメントを全て収集
  const segs = bspFile.segments.filter(s => s.target === naifTarget);

  if (segs.length === 0) {
    // フォールバック: 全セグメントから推定
    const all = bspFile.segments;
    const minSec = Math.min(...all.map(s => s.startSec));
    const maxSec = Math.max(...all.map(s => s.endSec));
    return {
      startJd: J2000_JD + minSec / S_PER_DAY,
      endJd:   J2000_JD + maxSec / S_PER_DAY,
    };
  }

  // 秒 → JD 変換
  const minSec = Math.min(...segs.map(s => s.startSec));
  const maxSec = Math.max(...segs.map(s => s.endSec));
  return {
    startJd: J2000_JD + minSec / S_PER_DAY,
    endJd:   J2000_JD + maxSec / S_PER_DAY,
  };
}

/**
 * カバー範囲を人間が読める文字列で返す
 *
 * @param {{ startJd: number, endJd: number }} coverage
 * @returns {string}  例: "AD1850〜AD2150"（de440s.bsp の場合）
 */
export function formatCoverageMessage(coverage) {
  const startYear = _jdToYear(coverage.startJd);
  const endYear   = _jdToYear(coverage.endJd);
  const start = startYear < 0
    ? `BC${Math.abs(Math.ceil(startYear))}`
    : `AD${Math.floor(startYear)}`;
  const end = `AD${Math.floor(endYear)}`;
  return `${start}〜${end}`;
}

/**
 * JD が BSP のカバー範囲内かを検証する
 *
 * 範囲外の場合は RangeError を throw する。
 * 既存の try/catch がそのまま拾えるよう RangeError を使用。
 *
 * @param {number} jdTdb   検証する JD（TDB）
 * @param {import('./bsp-reader.js').BspFile} bspFile
 * @throws {RangeError} 範囲外の場合
 */
export function assertInCoverage(jdTdb, bspFile) {
  const coverage = getCoverageJd(bspFile);
  if (jdTdb < coverage.startJd || jdTdb > coverage.endJd) {
    const range = formatCoverageMessage(coverage);
    const inputYear = _jdToYear(jdTdb);
    const inputLabel = inputYear < 0
      ? `BC${Math.abs(Math.ceil(inputYear))}`
      : `AD${Math.floor(inputYear)}`;
    throw new RangeError(
      `天体暦の範囲外です（${inputLabel}）。この天体暦がカバーする範囲: ${range}。`
    );
  }
}

// =========================================================================
// 内部ユーティリティ
// =========================================================================

/**
 * JD → 年（小数）に変換（概算）
 * @param {number} jd
 * @returns {number}
 */
function _jdToYear(jd) {
  return 2000.0 + (jd - J2000_JD) / 365.25;
}
