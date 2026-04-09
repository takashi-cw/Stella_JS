/**
 * constants.test.js — constants.js の単体テスト
 *
 * 実行: node --test test/core/constants.test.js
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  J2000_JD,
  JULIAN_CENTURY,
  JULIAN_YEAR,
  GREGORIAN_CUTOVER_JDN,
  GREGORIAN_CUTOVER_YEAR,
  GREGORIAN_CUTOVER_MONTH,
  GREGORIAN_CUTOVER_DAY,
  TT_MINUS_TAI_SECONDS,
  AU_KM,
  DEG_TO_RAD,
  RAD_TO_DEG,
  NAIF,
  PLANET_NAIF,
  DELTA_T_TABLE,
} from '../../public/src/core/constants.js';

describe('constants.js — 基本定数', () => {
  it('J2000_JD は 2451545.0 である', () => {
    assert.strictEqual(J2000_JD, 2451545.0);
  });

  it('JULIAN_CENTURY は 36525 日である', () => {
    assert.strictEqual(JULIAN_CENTURY, 36525.0);
  });

  it('JULIAN_YEAR は 365.25 日である', () => {
    assert.strictEqual(JULIAN_YEAR, 365.25);
  });

  it('グレゴリオ暦施行日 JDN は 2299161 である', () => {
    assert.strictEqual(GREGORIAN_CUTOVER_JDN, 2299161);
  });

  it('グレゴリオ暦施行日は 1582-10-15 である', () => {
    assert.strictEqual(GREGORIAN_CUTOVER_YEAR, 1582);
    assert.strictEqual(GREGORIAN_CUTOVER_MONTH, 10);
    assert.strictEqual(GREGORIAN_CUTOVER_DAY, 15);
  });

  it('TT - TAI は 32.184 秒である（IAU 1991）', () => {
    assert.strictEqual(TT_MINUS_TAI_SECONDS, 32.184);
  });
});

describe('constants.js — 角度換算', () => {
  it('DEG_TO_RAD × RAD_TO_DEG ≈ 1.0（逆変換が一致）', () => {
    assert.ok(Math.abs(DEG_TO_RAD * RAD_TO_DEG - 1.0) < 1e-15);
  });

  it('90° を rad に変換すると π/2 になる', () => {
    assert.ok(Math.abs(90 * DEG_TO_RAD - Math.PI / 2) < 1e-15);
  });

  it('π rad を度に変換すると 180° になる', () => {
    assert.ok(Math.abs(Math.PI * RAD_TO_DEG - 180.0) < 1e-12);
  });
});

describe('constants.js — AU', () => {
  it('AU_KM は約 1.496e8 km である', () => {
    assert.ok(Math.abs(AU_KM - 149597870.700) < 0.001);
  });
});

describe('constants.js — NAIF ボディコード', () => {
  it('SSB は 0', () => { assert.strictEqual(NAIF.SSB, 0); });
  it('SUN は 10', () => { assert.strictEqual(NAIF.SUN, 10); });
  it('MOON は 301', () => { assert.strictEqual(NAIF.MOON, 301); });
  it('EARTH は 399', () => { assert.strictEqual(NAIF.EARTH, 399); });
  it('JUPITER_BARYCENTER は 5', () => {
    assert.strictEqual(NAIF.JUPITER_BARYCENTER, 5);
  });

  it('NAIF オブジェクトはフリーズされている（書き込み不可）', () => {
    assert.ok(Object.isFrozen(NAIF));
  });
});

describe('constants.js — PLANET_NAIF マッピング', () => {
  it('Sun → 10', () => { assert.strictEqual(PLANET_NAIF.Sun, 10); });
  it('Moon → 301', () => { assert.strictEqual(PLANET_NAIF.Moon, 301); });
  it('Mars → 4（重心）', () => { assert.strictEqual(PLANET_NAIF.Mars, 4); });
  it('Neptune → 8（重心）', () => { assert.strictEqual(PLANET_NAIF.Neptune, 8); });
});

describe('constants.js — DELTA_T_TABLE', () => {
  it('テーブルは配列である', () => {
    assert.ok(Array.isArray(DELTA_T_TABLE));
  });

  it('テーブルは 15 エントリ以上ある', () => {
    assert.ok(DELTA_T_TABLE.length >= 15);
  });

  it('各エントリに from / to / coeffs が存在する', () => {
    for (const entry of DELTA_T_TABLE) {
      assert.ok('from' in entry, 'from が必要');
      assert.ok('to' in entry, 'to が必要');
      assert.ok(Array.isArray(entry.coeffs), 'coeffs が配列であること');
      assert.ok(entry.coeffs.length > 0, 'coeffs が空でないこと');
    }
  });

  it('範囲が連続している（gap なし）', () => {
    const sorted = [...DELTA_T_TABLE].sort((a, b) => a.from - b.from);
    for (let i = 0; i < sorted.length - 1; i++) {
      assert.strictEqual(
        sorted[i].to,
        sorted[i + 1].from,
        `gap: ${sorted[i].to} → ${sorted[i + 1].from}`
      );
    }
  });
});
