/**
 * houses.test.js — houses.js の単体テスト
 *
 * 実行: node --test test/astro/houses.test.js
 *
 * 基準値（Python spacefield/ephem/house_systems.py から取得）:
 *   JD=2451545.0 (J2000.0), lat=35.6895°(東京), lon=139.6917°(東京)
 *
 *   Placidus  H1≈155.289  H4≈242.235  H7≈335.289  H10≈62.235
 *   Koch      H1≈155.289  H4≈242.235  H10≈62.235
 *   Equal     各カスプは ASC + n×30°（30° 等差）
 *   WholeSigns H1 は 30° の倍数、各カスプも 30° の倍数
 *   Regiomontanus H1≈155.289, H10≈62.235
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  solveNewton,
  housesPlacidus,
  housesKoch,
  housesEqual,
  housesWholeSigns,
  housesRegiomontanus,
  housesCampanus,
  calculateHouses,
  HOUSE_SYSTEMS,
} from '../../src/astro/houses.js';

const J2000_JD = 2451545.0;
const LAT = 35.6895;
const LON = 139.6917;

const EPS2 = 0.01;    // 0.01° = 36 arcsec（ハウス計算許容誤差）

const close = (a, b, eps) => Math.abs(a - b) < eps;

function assertInRange(val, label) {
  assert.ok(val >= 0 && val < 360, `${label} = ${val}° は [0, 360) 範囲外`);
}

// =========================================================================
// solveNewton
// =========================================================================
describe('solveNewton — Newton-Raphson ソルバー', () => {
  it('f(x) = x² − 2 の正の根 ≈ √2', () => {
    const root = solveNewton(x => x * x - 2, 1.5);
    assert.ok(close(root, Math.SQRT2, 1e-9), `got ${root}`);
  });

  it('f(x) = x − 3 の根 = 3', () => {
    const root = solveNewton(x => x - 3, 0);
    assert.ok(close(root, 3, 1e-9), `got ${root}`);
  });

  it('収束しない場合（導関数ゼロを含む）は Error をスロー', () => {
    // f(x) = 1.0 は導関数ゼロ → ZeroDivision 相当のエラー
    assert.throws(() => solveNewton(_x => 1.0, 0, { maxIter: 5 }));
  });
});

// =========================================================================
// 共通: cusps の構造チェック
// =========================================================================
function assertHouseStructure(result, label) {
  assert.ok(Array.isArray(result.cusps), `${label}: cusps が配列でない`);
  assert.strictEqual(result.cusps.length, 12, `${label}: cusps の長さが 12 でない`);
  assert.ok(Array.isArray(result.angles), `${label}: angles が配列でない`);
  assert.strictEqual(result.angles.length, 4, `${label}: angles の長さが 4 でない`);
  for (let i = 0; i < 12; i++) assertInRange(result.cusps[i], `${label} H${i + 1}`);
  for (let i = 0; i < 4; i++) assertInRange(result.angles[i], `${label} angle[${i}]`);
}

// =========================================================================
// Placidus
// =========================================================================
describe('housesPlacidus — 東京 J2000.0', () => {
  const res = housesPlacidus(J2000_JD, LAT, LON);

  it('戻り値の構造が正しい', () => assertHouseStructure(res, 'Placidus'));

  it('H1（ASC）≈ 155.289°', () => {
    assert.ok(close(res.cusps[0], 155.289, EPS2), `H1=${res.cusps[0]}`);
  });

  it('H10（MC）≈ 62.235°', () => {
    assert.ok(close(res.cusps[9], 62.235, EPS2), `H10=${res.cusps[9]}`);
  });

  it('H7（DESC）= H1 + 180°', () => {
    const desc = (res.cusps[0] + 180) % 360;
    assert.ok(close(res.cusps[6], desc, EPS2), `H7=${res.cusps[6]}, expected≈${desc}`);
  });

  it('H4（IC）= H10 + 180°', () => {
    const ic = (res.cusps[9] + 180) % 360;
    assert.ok(close(res.cusps[3], ic, EPS2), `H4=${res.cusps[3]}, expected≈${ic}`);
  });

  it('angles = [ASC, MC, DESC, IC]', () => {
    assert.ok(close(res.angles[0], res.cusps[0], EPS2), 'angles[0] ≠ ASC');
    assert.ok(close(res.angles[1], res.cusps[9], EPS2), 'angles[1] ≠ MC');
  });
});

// =========================================================================
// Koch
// =========================================================================
describe('housesKoch — 東京 J2000.0', () => {
  const res = housesKoch(J2000_JD, LAT, LON);

  it('戻り値の構造が正しい', () => assertHouseStructure(res, 'Koch'));

  it('H1（ASC）≈ 155.289°', () => {
    assert.ok(close(res.cusps[0], 155.289, EPS2), `H1=${res.cusps[0]}`);
  });

  it('H10（MC）≈ 62.235°', () => {
    assert.ok(close(res.cusps[9], 62.235, EPS2), `H10=${res.cusps[9]}`);
  });

  it('Python 基準値: H11（idx10）≈ 94.935°', () => {
    // Koch H11=94.9346°（Placidus H11=95.6592° とは異なる）
    assert.ok(close(res.cusps[10], 94.935, 0.01), `H11=${res.cusps[10]}`);
  });
});

// =========================================================================
// Equal
// =========================================================================
describe('housesEqual — 東京 J2000.0', () => {
  const res = housesEqual(J2000_JD, LAT, LON);

  it('戻り値の構造が正しい', () => assertHouseStructure(res, 'Equal'));

  it('各カスプは 30° 等差（H1 を起点）', () => {
    for (let i = 0; i < 12; i++) {
      const expected = (res.cusps[0] + i * 30) % 360;
      assert.ok(
        close(res.cusps[i], expected, 1e-6),
        `H${i + 1}: expected=${expected}°, got=${res.cusps[i]}°`
      );
    }
  });

  it('H1 ≈ H1 of Placidus（同じ ASC）', () => {
    const placRes = housesPlacidus(J2000_JD, LAT, LON);
    assert.ok(close(res.cusps[0], placRes.cusps[0], EPS2));
  });
});

// =========================================================================
// Whole Sign
// =========================================================================
describe('housesWholeSigns — 東京 J2000.0', () => {
  const res = housesWholeSigns(J2000_JD, LAT, LON);

  it('戻り値の構造が正しい', () => assertHouseStructure(res, 'WholeSigns'));

  it('H1 は 30° の倍数', () => {
    assert.ok(res.cusps[0] % 30 < 1e-6, `H1=${res.cusps[0]}`);
  });

  it('すべてのカスプは 30° の倍数', () => {
    for (let i = 0; i < 12; i++) {
      assert.ok(res.cusps[i] % 30 < 1e-6, `H${i + 1}=${res.cusps[i]}`);
    }
  });

  it('各カスプは 30° 等差', () => {
    for (let i = 0; i < 11; i++) {
      const diff = ((res.cusps[i + 1] - res.cusps[i]) + 360) % 360;
      assert.ok(close(diff, 30, 1e-6), `H${i + 1}→H${i + 2}: ${diff}°`);
    }
  });

  it('Python 基準値: H1≈150°, H4≈240°', () => {
    assert.ok(close(res.cusps[0], 150, 1e-6), `H1=${res.cusps[0]}`);
    assert.ok(close(res.cusps[3], 240, 1e-6), `H4=${res.cusps[3]}`);
  });
});

// =========================================================================
// Regiomontanus
// =========================================================================
describe('housesRegiomontanus — 東京 J2000.0', () => {
  const res = housesRegiomontanus(J2000_JD, LAT, LON);

  it('戻り値の構造が正しい', () => assertHouseStructure(res, 'Regiomontanus'));

  it('H1（ASC）≈ 155.289°', () => {
    assert.ok(close(res.cusps[0], 155.289, EPS2), `H1=${res.cusps[0]}`);
  });

  it('H10（MC）≈ 62.235°', () => {
    assert.ok(close(res.cusps[9], 62.235, EPS2), `H10=${res.cusps[9]}`);
  });

  it('Python 基準値: H11≈106.075°', () => {
    assert.ok(close(res.cusps[10], 106.075, EPS2), `H11=${res.cusps[10]}`);
  });
});

// =========================================================================
// Campanus
// =========================================================================
describe('housesCampanus — 東京 J2000.0', () => {
  const res = housesCampanus(J2000_JD, LAT, LON);

  it('戻り値の構造が正しい', () => assertHouseStructure(res, 'Campanus'));

  it('H1（ASC）≈ 155.289°', () => {
    assert.ok(close(res.cusps[0], 155.289, EPS2), `H1=${res.cusps[0]}`);
  });

  it('H10（MC）≈ 62.235°', () => {
    assert.ok(close(res.cusps[9], 62.235, EPS2), `H10=${res.cusps[9]}`);
  });

  it('Python 基準値: H2≈40.513°（Campanus は非昇順が正常）', () => {
    // Campanus は主垂直圏投影のため H2, H3 が H1 より小さくなりうる
    assert.ok(close(res.cusps[1], 40.513, EPS2), `H2=${res.cusps[1]}`);
  });

  it('Python 基準値: H11≈107.407°', () => {
    assert.ok(close(res.cusps[10], 107.407, EPS2), `H11=${res.cusps[10]}`);
  });
});

// =========================================================================
// calculateHouses — ファサード
// =========================================================================
describe('calculateHouses — ファサード', () => {
  it('デフォルト（placidus）は housesPlacidus と同じ', () => {
    const r1 = calculateHouses(J2000_JD, LAT, LON);
    const r2 = housesPlacidus(J2000_JD, LAT, LON);
    for (let i = 0; i < 12; i++) {
      assert.ok(close(r1.cusps[i], r2.cusps[i], 1e-6), `H${i + 1}`);
    }
  });

  it('HOUSE_SYSTEMS.EQUAL を渡すと Equal が返る', () => {
    const r1 = calculateHouses(J2000_JD, LAT, LON, HOUSE_SYSTEMS.EQUAL);
    const r2 = housesEqual(J2000_JD, LAT, LON);
    assert.ok(close(r1.cusps[0], r2.cusps[0], 1e-6));
  });

  it('未知の hsys はデフォルト（Placidus）にフォールバック', () => {
    const r1 = calculateHouses(J2000_JD, LAT, LON, 'unknown_system');
    const r2 = housesPlacidus(J2000_JD, LAT, LON);
    assert.ok(close(r1.cusps[0], r2.cusps[0], 1e-6));
  });
});
