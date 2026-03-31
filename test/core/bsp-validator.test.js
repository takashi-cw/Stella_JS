/**
 * bsp-validator.test.js — bsp-validator.js の単体テスト
 *
 * 実行: node --test test/core/bsp-validator.test.js
 *
 * BspFile をモックし、セグメント時刻（J2000.0 からの秒数）を使って
 * getCoverageJd / assertInCoverage / formatCoverageMessage の動作を検証する。
 *
 * de440s.bsp の実際のカバー範囲: BC1550〜AD2650 相当
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  getCoverageJd,
  assertInCoverage,
  formatCoverageMessage,
} from '../../src/core/bsp-validator.js';

// =========================================================================
// テスト用モック BspFile
// =========================================================================

const J2000_JD   = 2451545.0;
const S_PER_DAY  = 86400.0;

// 秒 → JD 相対変換ヘルパー
const toSec = (jd) => (jd - J2000_JD) * S_PER_DAY;

// de440s.bsp に近いカバー範囲:
//   BC1550 ≈ JD 1270586  → 年: 2000 + (1270586−2451545)/365.25 ≈ −1550
//   AD2650 ≈ JD 2817025  → 年: 2000 + (2817025−2451545)/365.25 ≈  2650

const JD_START = J2000_JD + (-1550 - 2000) * 365.25;  // ≈ BC1550
const JD_END   = J2000_JD + ( 2650 - 2000) * 365.25;  // ≈ AD2650

/** NAIF=10 (太陽) のセグメント2本で BC1550〜AD2650 をカバー */
const mockBspFull = {
  segments: [
    { target: 10, center: 0, startJd: toSec(JD_START), endJd: toSec(J2000_JD) },
    { target: 10, center: 0, startJd: toSec(J2000_JD), endJd: toSec(JD_END)   },
    { target:  3, center: 0, startJd: toSec(JD_START), endJd: toSec(JD_END)   },
  ],
};

/** NAIF=10 が存在しないモック（フォールバック確認用） */
const mockBspNoSun = {
  segments: [
    { target: 3, center: 0, startJd: toSec(JD_START), endJd: toSec(JD_END) },
  ],
};

/** 狭いカバー範囲: AD1900〜AD2100 */
const JD_1900 = J2000_JD + (1900 - 2000) * 365.25;
const JD_2100 = J2000_JD + (2100 - 2000) * 365.25;
const mockBspNarrow = {
  segments: [
    { target: 10, center: 0, startJd: toSec(JD_1900), endJd: toSec(JD_2100) },
  ],
};

// =========================================================================
// getCoverageJd
// =========================================================================

describe('getCoverageJd', () => {
  it('太陽セグメントから startJd / endJd を正しく JD に変換する', () => {
    const cov = getCoverageJd(mockBspFull);
    // 誤差許容: ±1 日
    assert.ok(Math.abs(cov.startJd - JD_START) < 1,
      `startJd expected ≈ ${JD_START}, got ${cov.startJd}`);
    assert.ok(Math.abs(cov.endJd - JD_END) < 1,
      `endJd expected ≈ ${JD_END}, got ${cov.endJd}`);
  });

  it('NAIF=10 が存在しない場合は全セグメントからフォールバック', () => {
    const cov = getCoverageJd(mockBspNoSun);
    assert.ok(Math.abs(cov.startJd - JD_START) < 1);
    assert.ok(Math.abs(cov.endJd   - JD_END)   < 1);
  });

  it('naifTarget 引数で任意天体を指定できる', () => {
    const cov = getCoverageJd(mockBspFull, 3);  // NAIF 3: 地球-月バリセンタ
    assert.ok(Math.abs(cov.startJd - JD_START) < 1);
    assert.ok(Math.abs(cov.endJd   - JD_END)   < 1);
  });
});

// =========================================================================
// formatCoverageMessage
// =========================================================================

describe('formatCoverageMessage', () => {
  it('AD範囲のみの場合は "AD1900〜AD2100" 形式', () => {
    const msg = formatCoverageMessage({ startJd: JD_1900, endJd: JD_2100 });
    assert.match(msg, /AD1900〜AD2100/);
  });

  it('BC〜AD 範囲では "BC1550〜AD2650" 形式', () => {
    const msg = formatCoverageMessage({ startJd: JD_START, endJd: JD_END });
    assert.match(msg, /BC1\d{3}〜AD26\d{2}/);
  });
});

// =========================================================================
// assertInCoverage
// =========================================================================

describe('assertInCoverage', () => {
  const JD_2026_VERNAL = 2461127.0;  // 2026-03-27 付近

  it('カバー範囲内の JD では例外を投げない', () => {
    assert.doesNotThrow(() => assertInCoverage(JD_2026_VERNAL, mockBspFull));
  });

  it('startJd より前の JD で RangeError を throw', () => {
    const jdBeforeStart = JD_START - 1;
    assert.throws(
      () => assertInCoverage(jdBeforeStart, mockBspFull),
      (err) => {
        assert.ok(err instanceof RangeError, 'RangeError であること');
        assert.match(err.message, /天体暦の範囲外/);
        return true;
      }
    );
  });

  it('endJd より後の JD で RangeError を throw', () => {
    const jdAfterEnd = JD_END + 1;
    assert.throws(
      () => assertInCoverage(jdAfterEnd, mockBspFull),
      (err) => {
        assert.ok(err instanceof RangeError, 'RangeError であること');
        assert.match(err.message, /天体暦の範囲外/);
        return true;
      }
    );
  });

  it('エラーメッセージに入力年とカバー範囲を含む', () => {
    const jdFarFuture = J2000_JD + (3000 - 2000) * 365.25;
    let caught;
    try {
      assertInCoverage(jdFarFuture, mockBspFull);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'エラーが throw されること');
    assert.match(caught.message, /AD3000/,   '入力年が含まれること');
    assert.match(caught.message, /AD2[0-9]{3}/, 'カバー終端年が含まれること');
  });

  it('BC 年のエラーメッセージに BC が含まれる', () => {
    const jdAncient = J2000_JD + (-2000 - 2000) * 365.25;
    let caught;
    try {
      assertInCoverage(jdAncient, mockBspFull);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught);
    assert.match(caught.message, /BC2000/);
  });

  it('狭いカバー範囲: 範囲内の 2050 年は OK', () => {
    const jd2050 = J2000_JD + (2050 - 2000) * 365.25;
    assert.doesNotThrow(() => assertInCoverage(jd2050, mockBspNarrow));
  });

  it('狭いカバー範囲: AD1899 は範囲外で RangeError', () => {
    const jd1899 = J2000_JD + (1899 - 2000) * 365.25;
    assert.throws(
      () => assertInCoverage(jd1899, mockBspNarrow),
      RangeError
    );
  });
});
