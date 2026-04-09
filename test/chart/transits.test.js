/**
 * transits.test.js — transits.js の単体テスト
 *
 * 実行: node --test test/chart/transits.test.js
 *
 * 基準値（解析的な関数で calcFn をモック）:
 *   - normAngularDiff: 符号付き最短差
 *   - findLongitudeCrossing: sin 関数（既知の零点）で検証
 *   - detectStationPoint: sin 関数（cos=0 で逆行転換）で検証
 *   - calculateOptimalSampleCount: 平均速度テーブルとの一致
 *   - circularMeanLongitude: 解析値
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  AVG_SPEEDS,
  normAngularDiff,
  findLongitudeCrossing,
  detectStationPoint,
  calculateOptimalSampleCount,
  circularMeanLongitude,
} from '../../public/src/chart/transits.js';

const close = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// =========================================================================
// normAngularDiff
// =========================================================================
describe('normAngularDiff — 符号付き最短角度差', () => {
  it('lon2 = lon1 → 0°', () => assert.ok(close(normAngularDiff(0, 0), 0)));
  it('0° → 90°: +90°', ()   => assert.ok(close(normAngularDiff(0, 90), 90)));
  it('0° → 270°: -90°', ()  => assert.ok(close(normAngularDiff(0, 270), -90)));
  it('350° → 10°: +20°', () => assert.ok(close(normAngularDiff(350, 10), 20)));
  it('10° → 350°: -20°', () => assert.ok(close(normAngularDiff(10, 350), -20)));
  it('返り値は [-180, +180]', () => {
    for (let d = 0; d < 360; d += 15) {
      const r = normAngularDiff(0, d);
      assert.ok(r >= -180 && r <= 180, `d=${d} → ${r}`);
    }
  });
});

// =========================================================================
// findLongitudeCrossing — 二分探索による黄経通過検索
// =========================================================================
describe('findLongitudeCrossing — 黄経通過検索', () => {
  // テスト用 calcFn: 均一な角速度で移動する惑星モデル
  //   lon(jd) = startLon + speed * (jd - startJD)  (mod 360)
  function makeLinearCalcFn(startLon, speed, startJD = 0) {
    return (jd) => ({
      lon:      ((startLon + speed * (jd - startJD)) % 360 + 360) % 360,
      lonspeed: speed,
    });
  }

  it('太陽が 30° を通過する JD を精度 0.01h 以内で検索', () => {
    // 太陽: 0°から 1°/日で順行 → JD=30 に 30° を通過
    const calcFn = makeLinearCalcFn(0, 1.0);
    const result = findLongitudeCrossing(calcFn, 30, 0, 60);
    assert.ok(result !== null, 'should find crossing');
    assert.ok(close(result, 30.0, 0.001), `jd=${result}`);
  });

  it('360°/0° 境界をまたいで通過するケース', () => {
    // 355°から 1°/日 → JD=5 に 0° を通過
    const calcFn = makeLinearCalcFn(355, 1.0);
    const result = findLongitudeCrossing(calcFn, 0, 0, 10);
    assert.ok(result !== null);
    assert.ok(close(result, 5.0, 0.001), `jd=${result}`);
  });

  it('期間内に通過しない場合 null を返す', () => {
    const calcFn = makeLinearCalcFn(0, 1.0);
    const result = findLongitudeCrossing(calcFn, 30, 40, 60);
    assert.strictEqual(result, null);
  });

  it('逆行（負の速度）でも通過を検出できる', () => {
    // 60°から -1°/日で逆行 → JD=30 に 30° を通過
    const calcFn = makeLinearCalcFn(60, -1.0);
    const result = findLongitudeCrossing(calcFn, 30, 0, 60);
    assert.ok(result !== null, 'should find retrograde crossing');
    assert.ok(close(result, 30.0, 0.001), `jd=${result}`);
  });

  it('月が短期間で通過する高速移動ケース', () => {
    // 月: 0°から 13°/日 → JD≈9.23 に 120° を通過
    // 終端を10日間に制限して移動量<180°に収める（0→130°, normDiff=+130）
    const calcFn = makeLinearCalcFn(0, 13.0);
    const expected = 120 / 13.0;  // ≈ 9.2308 JD
    const result = findLongitudeCrossing(calcFn, 120, 0, 10);
    assert.ok(result !== null, 'should find crossing');
    assert.ok(close(result, expected, 0.01), `jd=${result} expected=${expected}`);
  });
});

// =========================================================================
// detectStationPoint — 留点検出
// =========================================================================
describe('detectStationPoint — 留点（逆行転換点）検出', () => {
  // テスト用 calcFn: sin 関数で逆行をモデル化
  // lon(jd) = baseLon + A * sin(2π * jd / period)  (mod 360)
  // lonspeed = A * 2π / period * cos(2π * jd / period)
  // lonspeed = 0 → jd = period/4（最初の留点, direct→retrograde）
  function makeSinCalcFn(baseLon, amplitude, period) {
    return (jd) => {
      const phase = 2 * Math.PI * jd / period;
      const lon   = ((baseLon + amplitude * Math.sin(phase)) % 360 + 360) % 360;
      const speed = amplitude * (2 * Math.PI / period) * Math.cos(phase);
      return { lon, lonspeed: speed };
    };
  }

  it('逆行転換点（direct_to_retrograde）を検出', () => {
    // period=40日: 最初の留点 jd = 40/4 = 10.0
    const calcFn = makeSinCalcFn(100, 5, 40);
    const result = detectStationPoint(calcFn, 0, 20, { precisionHours: 0.01 });

    assert.ok(result !== null, 'should find station');
    assert.strictEqual(result.type, 'direct_to_retrograde');
    assert.ok(close(result.jd, 10.0, 0.1), `jd=${result.jd}`);
  });

  it('順行転換点（retrograde_to_direct）を検出', () => {
    // period=40日: 2番目の留点 jd = 30.0
    const calcFn = makeSinCalcFn(100, 5, 40);
    const result = detectStationPoint(calcFn, 20, 40, { precisionHours: 0.01 });

    assert.ok(result !== null, 'should find station');
    assert.strictEqual(result.type, 'retrograde_to_direct');
    assert.ok(close(result.jd, 30.0, 0.1), `jd=${result.jd}`);
  });

  it('留点がない（純粋順行）の場合 null を返す', () => {
    const calcFn = (jd) => ({ lon: jd % 360, lonspeed: 1.0 });
    const result = detectStationPoint(calcFn, 0, 30);
    assert.strictEqual(result, null);
  });

  it('戻り値に lon, speedBefore, speedAfter が含まれる', () => {
    const calcFn = makeSinCalcFn(100, 5, 40);
    const result = detectStationPoint(calcFn, 0, 20);
    assert.ok('lon'         in result);
    assert.ok('speedBefore' in result);
    assert.ok('speedAfter'  in result);
  });
});

// =========================================================================
// calculateOptimalSampleCount
// =========================================================================
describe('calculateOptimalSampleCount — 最適サンプル点数', () => {
  it('月の30日間 → 最大（30点）', () => {
    // 月: 13°/日 × 30日 = 390° / 12 = 32.5 → clamp 30
    const n = calculateOptimalSampleCount(30, 'Moon');
    assert.strictEqual(n, 30);
  });

  it('太陽の30日間 → 少ないサンプル', () => {
    // 太陽: 0.9856°/日 × 30日 ≈ 29.6° / 12 = 2.47 → 3 (min)
    const n = calculateOptimalSampleCount(30, 'Sun');
    assert.ok(n >= 3 && n <= 6, `n=${n}`);
  });

  it('土星の365日間 → 最小（3点）', () => {
    // 土星: 0.03°/日 × 365日 = 10.95° / 12 = 0.91 → 1 → min=3
    const n = calculateOptimalSampleCount(365, 'Saturn');
    assert.strictEqual(n, 3);
  });

  it('未知の惑星 → デフォルト速度 0.5°/日 で計算', () => {
    const n = calculateOptimalSampleCount(100, 'UnknownPlanet');
    assert.ok(n >= 3);
  });

  it('opts.max / opts.min を上書きできる', () => {
    const n = calculateOptimalSampleCount(30, 'Moon', { max: 10, min: 5 });
    assert.ok(n <= 10);
    assert.ok(n >= 5);
  });
});

// =========================================================================
// circularMeanLongitude
// =========================================================================
describe('circularMeanLongitude — 円周角平均', () => {
  it('単一値 → その値を返す', () => {
    assert.ok(close(circularMeanLongitude([90]), 90));
  });

  it('[0°, 180°] → 90° または 270°（対称）', () => {
    const r = circularMeanLongitude([0, 180]);
    // 対称なので 90° または 270°（どちらも正しい）
    assert.ok(close(r, 90, 1e-4) || close(r, 270, 1e-4), `r=${r}`);
  });

  it('[0°, 60°, 120°] → 60°', () => {
    assert.ok(close(circularMeanLongitude([0, 60, 120]), 60));
  });

  it('360°/0° 境界をまたぐ場合: [350°, 10°] → 0°', () => {
    const r = circularMeanLongitude([350, 10]);
    assert.ok(close(r, 0, 0.001), `r=${r}`);
  });

  it('[90°, 90°, 90°] → 90°', () => {
    assert.ok(close(circularMeanLongitude([90, 90, 90]), 90));
  });

  it('空配列 → 0', () => {
    assert.strictEqual(circularMeanLongitude([]), 0);
  });

  it('返り値は [0, 360) 範囲', () => {
    const r = circularMeanLongitude([270, 350, 30]);
    assert.ok(r >= 0 && r < 360, `r=${r}`);
  });
});

// =========================================================================
// AVG_SPEEDS テーブル
// =========================================================================
describe('AVG_SPEEDS — 平均角速度テーブル', () => {
  it('主要10天体がすべて含まれる', () => {
    const required = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars',
                      'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];
    for (const p of required) {
      assert.ok(p in AVG_SPEEDS, `${p} missing`);
    }
  });

  it('月の角速度が最大（>1°/日）', () => {
    assert.ok(AVG_SPEEDS.Moon > 1.0);
  });

  it('冥王星の角速度が最小', () => {
    const speeds = Object.values(AVG_SPEEDS);
    assert.ok(AVG_SPEEDS.Pluto <= Math.min(...speeds) + 0.001);
  });
});
