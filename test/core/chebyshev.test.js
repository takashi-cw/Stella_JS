/**
 * chebyshev.test.js — chebyshev.js の単体テスト
 *
 * 実行: node --test test/core/chebyshev.test.js
 *
 * 検証方法:
 *   T_0(x) = 1
 *   T_1(x) = x
 *   T_2(x) = 2x^2 - 1
 *   T_3(x) = 4x^3 - 3x
 *
 *   T'_0(x) = 0
 *   T'_1(x) = 1
 *   T'_2(x) = 4x
 *   T'_3(x) = 12x^2 - 3
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  chebyshevEval,
  chebyshevEvalWithDeriv,
  chebyshevEvalWithVelocity,
  chebyshevEval3,
  chebyshevEval3WithVelocity,
  normalizeTime,
} from '../../public/src/core/chebyshev.js';

const EPS = 1e-12;
const close = (a, b, eps = EPS) => Math.abs(a - b) < eps;

// =========================================================================
// chebyshevEval — 位置計算
// =========================================================================
describe('chebyshevEval — 基本動作', () => {
  it('係数が空なら 0 を返す', () => {
    assert.strictEqual(chebyshevEval([], 0.5), 0);
  });

  it('係数が 1 つなら定数値を返す', () => {
    assert.strictEqual(chebyshevEval([7], 0.3), 7);
  });

  it('T_0(x) = 1: coeffs=[1] → 任意 x で 1', () => {
    assert.ok(close(chebyshevEval([1, 0, 0, 0], 0.5), 1));
    assert.ok(close(chebyshevEval([1, 0, 0, 0], -0.7), 1));
  });

  it('T_1(x) = x: coeffs=[0,1] → x をそのまま返す', () => {
    assert.ok(close(chebyshevEval([0, 1], 0.5), 0.5));
    assert.ok(close(chebyshevEval([0, 1], -0.3), -0.3));
  });

  it('T_2(x) = 2x^2 - 1: x=0.5 → 2*0.25-1 = -0.5', () => {
    assert.ok(close(chebyshevEval([0, 0, 1], 0.5), -0.5));
  });

  it('T_3(x) = 4x^3 - 3x: x=0.5 → 4*0.125 - 1.5 = -1.0', () => {
    assert.ok(close(chebyshevEval([0, 0, 0, 1], 0.5), -1.0));
  });

  it('T_2(x=1) = 1', () => {
    assert.ok(close(chebyshevEval([0, 0, 1], 1.0), 1.0));
  });

  it('T_2(x=-1) = 1', () => {
    assert.ok(close(chebyshevEval([0, 0, 1], -1.0), 1.0));
  });

  it('複合多項式: c0+c1*T1+c2*T2 = 1 + 2x + 3*(2x^2-1)', () => {
    // = 1 + 2x + 6x^2 - 3 = 6x^2 + 2x - 2
    // x=0.5: 6*0.25 + 1 - 2 = 1.5 + 1 - 2 = 0.5
    assert.ok(close(chebyshevEval([1, 2, 3], 0.5), 0.5));
  });
});

// =========================================================================
// chebyshevEvalWithDeriv — 位置 + 微分
// =========================================================================
describe('chebyshevEvalWithDeriv — 微分計算', () => {
  it('定数係数: 微分は 0', () => {
    const { position, dpdx } = chebyshevEvalWithDeriv([5], 0.3);
    assert.ok(close(position, 5));
    assert.ok(close(dpdx, 0));
  });

  it('T_1 の微分: dT_1/dx = 1', () => {
    const { position, dpdx } = chebyshevEvalWithDeriv([0, 1], 0.5);
    assert.ok(close(position, 0.5));
    assert.ok(close(dpdx, 1.0));
  });

  it('T_2 の微分: dT_2/dx = 4x → x=0.5 で 2.0', () => {
    const { position, dpdx } = chebyshevEvalWithDeriv([0, 0, 1], 0.5);
    assert.ok(close(position, -0.5));
    assert.ok(close(dpdx, 2.0));
  });

  it('T_3 の微分: dT_3/dx = 12x^2-3 → x=0.5 で 0.0', () => {
    const { position, dpdx } = chebyshevEvalWithDeriv([0, 0, 0, 1], 0.5);
    assert.ok(close(position, -1.0));
    assert.ok(close(dpdx, 0.0));    // 12*0.25 - 3 = 0
  });

  it('T_3 の微分: x=0.0 で -3.0', () => {
    const { dpdx } = chebyshevEvalWithDeriv([0, 0, 0, 1], 0.0);
    assert.ok(close(dpdx, -3.0));
  });

  it('複合多項式の微分: coeffs=[1,2,3] → 2 + 6*(2x) at x=0.5 = 2 + 6 = 8', () => {
    // f(x) = 1 + 2x + 3*(2x^2-1) = 6x^2 + 2x - 2
    // f'(x) = 12x + 2 → x=0.5: 8
    const { dpdx } = chebyshevEvalWithDeriv([1, 2, 3], 0.5);
    assert.ok(close(dpdx, 8.0));
  });
});

// =========================================================================
// chebyshevEvalWithVelocity — 速度換算
// =========================================================================
describe('chebyshevEvalWithVelocity — 速度換算', () => {
  it('intervalDays=2 のとき velocity = dpdx * (2/2) = dpdx', () => {
    // T_1: dpdx=1, velocity = 1*(2/2) = 1
    const { velocity } = chebyshevEvalWithVelocity([0, 1], 0.5, 2);
    assert.ok(close(velocity, 1.0));
  });

  it('intervalDays=4 のとき velocity = dpdx * 0.5', () => {
    // T_2: dpdx=2 at x=0.5, velocity = 2 * (2/4) = 1
    const { velocity } = chebyshevEvalWithVelocity([0, 0, 1], 0.5, 4);
    assert.ok(close(velocity, 1.0));
  });
});

// =========================================================================
// chebyshevEval3 — 3 成分
// =========================================================================
describe('chebyshevEval3 — 3 成分同時評価', () => {
  it('各軸に独立した係数を与えると正しく計算される', () => {
    const coeffsXYZ = [
      [0, 1],       // X: T_1(x) = x
      [0, 0, 1],    // Y: T_2(x) = 2x^2 - 1
      [1, 0, 0, 0], // Z: T_0(x) = 1
    ];
    const [px, py, pz] = chebyshevEval3(coeffsXYZ, 0.5);
    assert.ok(close(px, 0.5));
    assert.ok(close(py, -0.5));
    assert.ok(close(pz, 1.0));
  });
});

// =========================================================================
// chebyshevEval3WithVelocity
// =========================================================================
describe('chebyshevEval3WithVelocity — 3 成分位置 + 速度', () => {
  it('position と velocity が正しく返る', () => {
    const coeffsXYZ = [
      [0, 1],    // X: T_1
      [0, 0, 1], // Y: T_2
      [3],       // Z: constant
    ];
    const { position, velocity } = chebyshevEval3WithVelocity(coeffsXYZ, 0.5, 2);
    assert.ok(close(position[0], 0.5));
    assert.ok(close(position[1], -0.5));
    assert.ok(close(position[2], 3.0));
    // X: dpdx=1, velocity=1*(2/2)=1
    assert.ok(close(velocity[0], 1.0));
    // Y: dpdx=2, velocity=2*(2/2)=2
    assert.ok(close(velocity[1], 2.0));
    // Z: constant → velocity=0
    assert.ok(close(velocity[2], 0.0));
  });
});

// =========================================================================
// normalizeTime — 時間正規化
// =========================================================================
describe('normalizeTime', () => {
  it('中点は 0 になる', () => {
    assert.ok(close(normalizeTime(50, 0, 100), 0));
  });

  it('開始点は -1 になる', () => {
    assert.ok(close(normalizeTime(0, 0, 100), -1));
  });

  it('終了点は 1 になる', () => {
    assert.ok(close(normalizeTime(100, 0, 100), 1));
  });

  it('JD 2451545.0 をセグメント [2451500, 2451600] で正規化', () => {
    const x = normalizeTime(2451545.0, 2451500.0, 2451600.0);
    // (2*2451545 - (2451500+2451600)) / 100 = (4903090 - 4903100) / 100 = -0.1
    assert.ok(close(x, -0.1));
  });
});
