/**
 * chebyshev.js — Chebyshev 多項式評価（Clenshaw algorithm）
 *
 * Layer 1: core（依存なし）
 *
 * JPL DE440s の各セグメントには天体位置が Chebyshev 多項式係数として
 * 格納されている。このモジュールはその係数列から位置（および速度）を復元する。
 *
 * アルゴリズム出典:
 *   - Clenshaw (1955) "A note on the summation of Chebyshev series"
 *   - Meeus "Astronomical Algorithms" 2nd ed., Ch.3
 *   - jplephem (Brandon Rhodes, MIT License) の設計を参考に JS で再実装
 *
 * ライセンス: MIT
 */

'use strict';

/**
 * Chebyshev 多項式を Clenshaw algorithm で評価する（位置のみ）
 *
 * f(x) = sum_{k=0}^{n} c_k * T_k(x)
 *
 * @param {number[]} coeffs - Chebyshev 係数配列 [c0, c1, ..., cn]
 * @param {number} x - 評価点。[-1, 1] に正規化済みであること
 * @returns {number} 多項式の値
 */
export function chebyshevEval(coeffs, x) {
  const n = coeffs.length;
  if (n === 0) return 0;
  if (n === 1) return coeffs[0];

  // Clenshaw algorithm:
  //   b_{n+1} = b_{n+2} = 0
  //   b_k = c_k + 2x*b_{k+1} - b_{k+2}  (k = n..1)
  //   f(x) = c_0 + x*b_1 - b_2
  let b2 = 0;
  let b1 = 0;
  for (let i = n - 1; i >= 1; i--) {
    const b = coeffs[i] + 2 * x * b1 - b2;
    b2 = b1;
    b1 = b;
  }
  return coeffs[0] + x * b1 - b2;
}

/**
 * Chebyshev 多項式の位置と速度（x に関する微分）を同時に計算する
 *
 * 速度の導出:
 *   b_k = c_k + 2x*b_{k+1} - b_{k+2}
 *   db_k/dx = 2*b_{k+1} + 2x*(db_{k+1}/dx) - (db_{k+2}/dx)
 *   df/dx = b_1 + x*(db_1/dx) - (db_2/dx)
 *
 * @param {number[]} coeffs - Chebyshev 係数配列 [c0, c1, ..., cn]
 * @param {number} x - 評価点 [-1, 1]
 * @returns {{ position: number, dpdx: number }}
 *   - position: f(x)
 *   - dpdx: df/dx（正規化変数 x に対する微分）
 */
export function chebyshevEvalWithDeriv(coeffs, x) {
  const n = coeffs.length;
  if (n === 0) return { position: 0, dpdx: 0 };
  if (n === 1) return { position: coeffs[0], dpdx: 0 };

  let b2 = 0,  b1 = 0;
  let d2 = 0,  d1 = 0;

  for (let i = n - 1; i >= 1; i--) {
    const b = coeffs[i] + 2 * x * b1 - b2;
    const d = 2 * b1 + 2 * x * d1 - d2;
    b2 = b1; b1 = b;
    d2 = d1; d1 = d;
  }

  const position = coeffs[0] + x * b1 - b2;
  const dpdx    = b1 + x * d1 - d2;
  return { position, dpdx };
}

/**
 * 位置と速度（AU/day）を計算する
 *
 * @param {number[]} coeffs - Chebyshev 係数配列
 * @param {number} x - 評価点 [-1, 1]
 * @param {number} intervalDays - セグメントが対応する期間（日数）
 * @returns {{ position: number, velocity: number }}
 *   - position: AU 等（係数の単位に依存）
 *   - velocity: position/day
 */
export function chebyshevEvalWithVelocity(coeffs, x, intervalDays) {
  const { position, dpdx } = chebyshevEvalWithDeriv(coeffs, x);
  // dx/dt = 2 / intervalDays（正規化変数 x の時間微分）
  const velocity = dpdx * (2 / intervalDays);
  return { position, velocity };
}

/**
 * 3 成分（X, Y, Z）まとめて Chebyshev 評価する（位置のみ）
 *
 * @param {number[][]} coeffsXYZ - [coeffsX, coeffsY, coeffsZ]
 * @param {number} x - 評価点 [-1, 1]
 * @returns {number[]} [px, py, pz] 位置ベクトル
 */
export function chebyshevEval3(coeffsXYZ, x) {
  return [
    chebyshevEval(coeffsXYZ[0], x),
    chebyshevEval(coeffsXYZ[1], x),
    chebyshevEval(coeffsXYZ[2], x),
  ];
}

/**
 * 3 成分まとめて位置と速度を計算する
 *
 * @param {number[][]} coeffsXYZ - [coeffsX, coeffsY, coeffsZ]
 * @param {number} x - 評価点 [-1, 1]
 * @param {number} intervalDays - セグメント期間（日数）
 * @returns {{ position: number[], velocity: number[] }}
 */
export function chebyshevEval3WithVelocity(coeffsXYZ, x, intervalDays) {
  const px = chebyshevEvalWithVelocity(coeffsXYZ[0], x, intervalDays);
  const py = chebyshevEvalWithVelocity(coeffsXYZ[1], x, intervalDays);
  const pz = chebyshevEvalWithVelocity(coeffsXYZ[2], x, intervalDays);
  return {
    position: [px.position, py.position, pz.position],
    velocity: [px.velocity, py.velocity, pz.velocity],
  };
}

/**
 * 評価点を [-1, 1] に正規化する
 *
 * @param {number} jd - ユリウス日
 * @param {number} tStart - セグメント開始 JD
 * @param {number} tEnd - セグメント終了 JD
 * @returns {number} 正規化された評価点 [-1, 1]
 */
export function normalizeTime(jd, tStart, tEnd) {
  return (2 * jd - (tStart + tEnd)) / (tEnd - tStart);
}
