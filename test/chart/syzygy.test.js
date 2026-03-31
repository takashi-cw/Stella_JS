/**
 * syzygy.test.js — calcSyzygy() の単体テスト
 *
 * 実行: node --test test/chart/syzygy.test.js
 *
 * calcFn をモックすることで BSP ファイルなしにテスト可能。
 * 検証方法:
 *   - 既知の朔/望 JD を解析的に設定し、calcSyzygy() が正しく検出するか確認する。
 *   - 太陽黄経は一定（0°）、月黄経だけを動かしてシンプルなモックを構成する。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { calcSyzygy } from '../../src/chart/transits.js';

// 許容誤差: 計算精度 0.01 時間 → 0.01 / 24 日 = 約 4.2e-4 日
const PREC_JD = 0.01 / 24 + 1e-6;

/**
 * シンプルなモック:
 *   sunLon  = 固定値 sunLon0
 *   moonLon = sunLon0 + moonOffset(jd)
 *
 * moonOffset が 0  → 朔
 * moonOffset が 180 → 望
 */
function makeFns(sunLon0, moonOffsetFn) {
  const sunFn  = jd => ({ lon: sunLon0 });
  const moonFn = jd => ({ lon: (sunLon0 + moonOffsetFn(jd) + 720) % 360 });
  return { sunFn, moonFn };
}

// =========================================================================
// calcSyzygy — 基本テスト
// =========================================================================
describe('calcSyzygy', () => {

  it('指定 JD の直前に朔が 1 件あるとき、正しい JD と type:new_moon を返す', () => {
    // 設定: JD=100 を基準とし、JD=90 に月オフセット 0（朔）が来るよう定義
    // moonOffset(jd) = (jd - 90) * 360 / 29.53 で月は 29.53 日周期
    const SYNODIC = 29.53;
    const newMoonJD = 90.0;
    const baseJD    = 100.0;
    const sunLon = 45;

    const { sunFn, moonFn } = makeFns(sunLon, jd => {
      // JD=90 でオフセット=0（朔）、そこから順行
      return ((jd - newMoonJD) / SYNODIC) * 360;
    });

    const result = calcSyzygy(sunFn, moonFn, baseJD);

    assert.ok(result !== null, 'シジジーが見つかるべき');
    assert.strictEqual(result.type, 'new_moon');
    assert.ok(
      Math.abs(result.jd - newMoonJD) < PREC_JD,
      `JD 誤差 ${Math.abs(result.jd - newMoonJD).toExponential(3)} が許容範囲外（<${PREC_JD.toExponential(3)}）`
    );
  });

  it('指定 JD の直前に望が 1 件あるとき、正しい JD と type:full_moon を返す', () => {
    const SYNODIC   = 29.53;
    const fullMoonJD = 95.0;
    const baseJD     = 100.0;
    const sunLon  = 0;

    const { sunFn, moonFn } = makeFns(sunLon, jd => {
      // JD=fullMoonJD でオフセット=180（望）
      return 180 + ((jd - fullMoonJD) / SYNODIC) * 360;
    });

    const result = calcSyzygy(sunFn, moonFn, baseJD);

    assert.ok(result !== null, 'シジジーが見つかるべき');
    assert.strictEqual(result.type, 'full_moon');
    assert.ok(
      Math.abs(result.jd - fullMoonJD) < PREC_JD,
      `JD 誤差 ${Math.abs(result.jd - fullMoonJD).toExponential(3)} が許容範囲外`
    );
  });

  it('直近が望で、さらに前に朔があるとき、望を優先して返す', () => {
    const SYNODIC   = 29.53;
    const baseJD    = 100.0;
    // 望: JD=92（baseJD - 8）、朔: JD=77（baseJD - 23）
    const fullMoonJD = 92.0;
    const sunLon = 270;

    const { sunFn, moonFn } = makeFns(sunLon, jd => {
      return 180 + ((jd - fullMoonJD) / SYNODIC) * 360;
    });

    const result = calcSyzygy(sunFn, moonFn, baseJD);

    assert.ok(result !== null, 'シジジーが見つかるべき');
    assert.strictEqual(result.type, 'full_moon', '直近の望が返るべき');
    assert.ok(Math.abs(result.jd - fullMoonJD) < PREC_JD);
  });

  it('searchDays=5 で直前 5 日にシジジーがなければ null を返す', () => {
    const SYNODIC = 29.53;
    const baseJD  = 100.0;
    // 朔は JD=80 → baseJD から 20 日前（searchDays=5 では届かない）
    const { sunFn, moonFn } = makeFns(0, jd => ((jd - 80) / SYNODIC) * 360);

    const result = calcSyzygy(sunFn, moonFn, baseJD, { searchDays: 5 });
    assert.strictEqual(result, null, 'searchDays 不足で null が返るべき');
  });

  it('太陽黄経が 0° のとき、朔 lon は 0° 付近になる', () => {
    const SYNODIC  = 29.53;
    const newMoonJD = 90.0;
    const baseJD   = 100.0;

    const { sunFn, moonFn } = makeFns(0, jd => ((jd - newMoonJD) / SYNODIC) * 360);
    const result = calcSyzygy(sunFn, moonFn, baseJD);

    assert.ok(result !== null);
    // 朔の lon は sunLon (≈ 0°) と一致するはず
    const lonDiff = Math.abs((result.lon - 0 + 360) % 360);
    assert.ok(
      lonDiff < 1.0 || lonDiff > 359.0,
      `朔の lon (${result.lon.toFixed(3)}°) は 0° 付近のはず`
    );
  });

  it('朔の jd が baseJD とほぼ一致するとき（境界）も正しく検出する', () => {
    // baseJD=100.0、朔は JD=99.99 → すぐ直前
    const SYNODIC   = 29.53;
    const newMoonJD = 99.99;
    const baseJD    = 100.0;

    const { sunFn, moonFn } = makeFns(60, jd => ((jd - newMoonJD) / SYNODIC) * 360);
    const result = calcSyzygy(sunFn, moonFn, baseJD);

    assert.ok(result !== null, '直前 0.01 日の朔も検出できるべき');
    assert.strictEqual(result.type, 'new_moon');
    assert.ok(Math.abs(result.jd - newMoonJD) < PREC_JD * 10);
  });

});
