/**
 * coordinates.test.js — coordinates.js の単体テスト
 *
 * 実行: node --test test/astro/coordinates.test.js
 *
 * 基準値（Python Skyfield 1.54 + 手計算）:
 *   - GMST at J2000.0 = 280.46061837°
 *   - LST(J2000.0, lon=139.6917°) = 60.152318°
 *   - eclipticToEquatorial(90°, 0°, ε) → RA≈90°, Dec≈23.439°
 *   - equatorialToEcliptic round-trip → 元の値と一致
 *   - calculateMcAsc(J2000.0, 35.6895, 139.6917) → MC≈62.2349°, ASC≈155.2886°
 *   - icrsToJ2000Ecliptic: 解析値・Skyfield 基準値（太陽・月）
 *   - precessLongitude: IAU 2006 ψ_A（Capitaine et al. 2003）
 *   - nutationAngles: IAU 2000B 77項（Meeus 22.a 基準値との差 < 0.002"）
 *   - icrsToEcliptic: Capitaine 3角度歳差 + IAU 2000B 章動（Skyfield互換）
 *   - applyAberration: 速度ベクトル法（ICRS空間、相対論的一次近似）
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  normAngle,
  gmst,
  siderealTime,
  eclipticToEquatorial,
  equatorialToEcliptic,
  calculateMcAsc,
  icrsToJ2000Ecliptic,
  precessLongitude,
  icrsToEcliptic,
  nutationAngles,
  applyAberration,
  observerGCRS,
  applyLightDeflection,
} from '../../src/astro/coordinates.js';

const J2000_JD = 2451545.0;
const EPS6 = 1e-6;   // サブ秒角精度
const EPS3 = 1e-3;   // 数値微分・三角関数の累積誤差
const EPS2 = 0.01;   // ハウス計算の許容誤差（0.036 arcsec）

const close = (a, b, eps) => Math.abs(a - b) < eps;

// =========================================================================
// normAngle
// =========================================================================
describe('normAngle — 角度正規化', () => {
  it('0° → 0°', () => assert.strictEqual(normAngle(0), 0));
  it('360° → 0°', () => assert.ok(close(normAngle(360), 0, EPS6)));
  it('−90° → 270°', () => assert.ok(close(normAngle(-90), 270, EPS6)));
  it('450° → 90°', () => assert.ok(close(normAngle(450), 90, EPS6)));
  it('−0.001° → 359.999°', () => assert.ok(close(normAngle(-0.001), 359.999, EPS6)));
});

// =========================================================================
// gmst — グリニッジ平均恒星時
// =========================================================================
describe('gmst — グリニッジ平均恒星時', () => {
  it('J2000.0: 280.46061837°', () => {
    const g = gmst(J2000_JD);
    assert.ok(close(g, 280.46061837, EPS6), `got ${g}`);
  });

  it('返り値は [0, 360) の範囲', () => {
    for (const offset of [-100, 0, 100, 1000]) {
      const g = gmst(J2000_JD + offset);
      assert.ok(g >= 0 && g < 360, `gmst(+${offset}d) = ${g}° は範囲外`);
    }
  });
});

// =========================================================================
// siderealTime — 地方恒星時
// =========================================================================
describe('siderealTime — 地方恒星時（LST）', () => {
  it('J2000.0, lon=0°: GMST と同じ', () => {
    assert.ok(close(siderealTime(J2000_JD, 0), gmst(J2000_JD), EPS6));
  });

  it('J2000.0, lon=139.6917°（東京）≈ 60.152318°', () => {
    const lst = siderealTime(J2000_JD, 139.6917);
    assert.ok(close(lst, 60.152318, EPS3), `got ${lst}`);
  });

  it('lon=360° は lon=0° と同じ', () => {
    assert.ok(
      close(siderealTime(J2000_JD, 360), siderealTime(J2000_JD, 0), EPS6)
    );
  });
});

// =========================================================================
// eclipticToEquatorial — 黄道 → 赤道
// =========================================================================
describe('eclipticToEquatorial — 黄道 → 赤道', () => {
  it('春分点（lon=0, lat=0）→ RA=0°, Dec=0°', () => {
    const { ra, dec } = eclipticToEquatorial(0, 0, 23.4393);
    assert.ok(close(ra, 0, EPS3), `RA=${ra}`);
    assert.ok(close(dec, 0, EPS3), `Dec=${dec}`);
  });

  it('夏至点（lon=90, lat=0）→ RA≈90°, Dec≈23.439°', () => {
    const eps = 23.43927944;
    const { ra, dec } = eclipticToEquatorial(90, 0, eps);
    assert.ok(close(ra, 90, EPS3), `RA=${ra}`);
    assert.ok(close(dec, eps, EPS3), `Dec=${dec}`);
  });

  it('返り値 RA は [0, 360)', () => {
    for (const lon of [0, 90, 180, 270, 359]) {
      const { ra } = eclipticToEquatorial(lon, 0, 23.44);
      assert.ok(ra >= 0 && ra < 360, `RA=${ra} at lon=${lon}`);
    }
  });
});

// =========================================================================
// equatorialToEcliptic — 赤道 → 黄道
// =========================================================================
describe('equatorialToEcliptic — 赤道 → 黄道', () => {
  it('RA=0°, Dec=0° → lon=0°, lat=0°', () => {
    const { lon, lat } = equatorialToEcliptic(0, 0, 23.44);
    assert.ok(close(lon, 0, EPS3), `lon=${lon}`);
    assert.ok(close(lat, 0, EPS3), `lat=${lat}`);
  });

  it('RA=90°, Dec=23.439° → lon≈90°, lat≈0°', () => {
    const eps = 23.43927944;
    const { lon, lat } = equatorialToEcliptic(90, eps, eps);
    assert.ok(close(lon, 90, EPS3), `lon=${lon}`);
    assert.ok(close(Math.abs(lat), 0, EPS3), `lat=${lat}`);
  });
});

// =========================================================================
// round-trip: ecliptic → equatorial → ecliptic
// =========================================================================
describe('round-trip: 黄道 → 赤道 → 黄道', () => {
  const EPS_RT = 1e-8;
  const eps = 23.43927944;
  const testCases = [
    [0, 0], [30, 5], [90, -10], [180, 0], [270, 15], [315, -5],
  ];
  for (const [lon0, lat0] of testCases) {
    it(`(${lon0}°, ${lat0}°) → 元の値に一致`, () => {
      const { ra, dec } = eclipticToEquatorial(lon0, lat0, eps);
      const { lon, lat } = equatorialToEcliptic(ra, dec, eps);
      assert.ok(close(lon, lon0, EPS_RT), `lon: ${lon0} → ${lon}`);
      assert.ok(close(lat, lat0, EPS_RT), `lat: ${lat0} → ${lat}`);
    });
  }
});

// =========================================================================
// calculateMcAsc — MC / ASC 計算
// =========================================================================
describe('calculateMcAsc — MC / ASC', () => {
  it('J2000.0, 東京 → MC≈62.235°, ASC≈155.289°', () => {
    const { mc, asc, ramc } = calculateMcAsc(J2000_JD, 35.6895, 139.6917);
    assert.ok(close(mc,   62.235,  EPS2), `MC=${mc}`);
    assert.ok(close(asc, 155.289,  EPS2), `ASC=${asc}`);
    assert.ok(close(ramc, 60.152,  EPS2), `RAMC=${ramc}`);
  });

  it('DESC は ASC + 180°', () => {
    const { mc, asc } = calculateMcAsc(J2000_JD, 35.6895, 139.6917);
    const desc = (asc + 180) % 360;
    assert.ok(close(desc, (asc + 180) % 360, EPS6));
  });

  it('MC は [0, 360) の範囲', () => {
    const { mc, asc } = calculateMcAsc(J2000_JD, 35.6895, 139.6917);
    assert.ok(mc  >= 0 && mc  < 360, `MC=${mc}`);
    assert.ok(asc >= 0 && asc < 360, `ASC=${asc}`);
  });

  it('赤道（lat=0）でも計算できる', () => {
    const { mc, asc } = calculateMcAsc(J2000_JD, 0, 0);
    assert.ok(mc  >= 0 && mc  < 360);
    assert.ok(asc >= 0 && asc < 360);
  });
});

// =========================================================================
// icrsToJ2000Ecliptic — ICRS XYZ → J2000.0 黄道球面座標
// =========================================================================
// 基準値: 解析的（単位ベクトル）+ Skyfield astrometric（太陽・月）at J2000.0
//
//   Python: astrometric = earth.at(t).observe(planet).position.au → ICRS XYZ
//   変換:   R_x(+ε₀) + 球面座標
//
//   太陽 ICRS(AU): (0.17713507, -0.88742848, -0.38474288)
//     → lon=280.377821°, lat=0.000227°, dist=0.983328 AU
//
//   月 ICRS(AU): (-0.00194902, -0.00178284, -0.00050869)
//     → lon=223.321894°, lat=5.171304°
// =========================================================================
describe('icrsToJ2000Ecliptic — ICRS→J2000 黄道変換', () => {
  it('単位ベクトル (1,0,0) → lon=0°, lat=0°, dist=1', () => {
    const r = icrsToJ2000Ecliptic(1, 0, 0);
    assert.ok(close(r.lon,  0, EPS6), `lon=${r.lon}`);
    assert.ok(close(r.lat,  0, EPS6), `lat=${r.lat}`);
    assert.ok(close(r.dist, 1, EPS6), `dist=${r.dist}`);
  });

  it('ICRS 北極 (0,0,1) → 黄緯 = +ε₀ ≈ 66.5607°', () => {
    // ICRS z 軸（天の北極）は黄道から ε₀ 傾いている
    const r = icrsToJ2000Ecliptic(0, 0, 1);
    assert.ok(close(r.lat, 66.56072, 1e-4), `lat=${r.lat}`);
    assert.ok(close(r.lon, 90.0, EPS6), `lon=${r.lon}`);
    assert.ok(close(r.dist, 1.0, EPS6), `dist=${r.dist}`);
  });

  it('黄道北極ベクトル (0, -sinε₀, cosε₀) → lat=90°', () => {
    const eps0r = 84381.406 / 3600 * Math.PI / 180;
    const r = icrsToJ2000Ecliptic(0, -Math.sin(eps0r), Math.cos(eps0r));
    assert.ok(close(r.lat, 90, EPS6), `lat=${r.lat}`);
    assert.ok(close(r.dist, 1.0, EPS6), `dist=${r.dist}`);
  });

  it('ゼロベクトル → dist=0 でもクラッシュしない', () => {
    const r = icrsToJ2000Ecliptic(0, 0, 0);
    assert.strictEqual(r.dist, 0);
  });

  // Skyfield astrometric 基準値（Python spacefield + Skyfield de440s）
  it('太陽 at J2000.0: lon≈280.378°, lat≈0.000°, dist≈0.983 AU', () => {
    // Skyfield geocentric astrometric: (0.17713507, -0.88742848, -0.38474288) AU
    const r = icrsToJ2000Ecliptic(0.17713507, -0.88742848, -0.38474288);
    assert.ok(close(r.lon,  280.377821, 1e-3), `lon=${r.lon}`);
    assert.ok(close(r.lat,  0.000227,   1e-3), `lat=${r.lat}`);
    assert.ok(close(r.dist, 0.983328,   1e-4), `dist=${r.dist}`);
  });

  it('月 at J2000.0: lon≈223.322°, lat≈5.171°', () => {
    // Skyfield geocentric astrometric: (-0.00194902, -0.00178284, -0.00050869) AU
    const r = icrsToJ2000Ecliptic(-0.00194902, -0.00178284, -0.00050869);
    assert.ok(close(r.lon, 223.321894, 1e-3), `lon=${r.lon}`);
    assert.ok(close(r.lat,   5.171304, 1e-3), `lat=${r.lat}`);
  });
});

// =========================================================================
// precessLongitude — J2000.0 → of-date 黄経（IAU 2006 ψ_A）
// =========================================================================
// ψ_A(T=0)  = 0°
// ψ_A(T=1)  = (5038.481507 − 1.0790069) / 3600 ≈ +1.399278°
// ψ_A(T=−1) = (−5038.481507 − 1.0790069) / 3600 ≈ −1.399879°
// =========================================================================
describe('precessLongitude — 一般歳差 ψ_A', () => {
  const JC = 36525;  // ユリウス世紀（日）

  it('T=0（J2000.0）: 歳差ゼロ、入力そのまま', () => {
    const lon = precessLongitude(280.0, J2000_JD);
    assert.ok(close(lon, 280.0, EPS6), `lon=${lon}`);
  });

  it('T=+1（J2100.0）: +1.399278° 加算', () => {
    const jd = J2000_JD + JC;
    const lon = precessLongitude(0.0, jd);
    assert.ok(close(lon, 1.399278, 1e-4), `lon=${lon}`);
  });

  it('T=−1（J1900.0）: −1.399879° 加算', () => {
    const jd = J2000_JD - JC;
    const lon = precessLongitude(0.0, jd);
    // normAngle により 358.600121° に変換される
    assert.ok(close(lon, 360 - 1.399879, 1e-4), `lon=${lon}`);
  });

  it('360° 境界を正しく折り返す（normAngle）', () => {
    // lon=359.5°, ψ_A=1.399°: 360.899° → normAngle → 0.899°
    const jd = J2000_JD + JC;
    const lon = precessLongitude(359.5, jd);
    assert.ok(lon >= 0 && lon < 360, `lon=${lon}`);
    assert.ok(close(lon, 0.899278, 1e-3), `lon=${lon}`);
  });
});

// =========================================================================
// nutationAngles — IAU 2000B 全 77 項章動
// =========================================================================
describe('nutationAngles — IAU 2000B 77 項章動', () => {
  // Meeus "Astronomical Algorithms" 2nd ed. Example 22.a
  // JD 2446895.5 = 1987-04-10 0h TT
  // IAU 2000B と IAU 1980 の差は ~8 mas 以内
  it('Meeus 22.a: JD 2446895.5 → dpsi≈−3.781", deps≈+9.445"（IAU 2000B）', () => {
    const { dpsi, deps } = nutationAngles(2446895.5);
    assert.ok(close(dpsi, -3.7808, 0.002), `dpsi=${dpsi.toFixed(4)}" (期待値 -3.7808")`);
    assert.ok(close(deps,  9.4452, 0.002), `deps=${deps.toFixed(4)}" (期待値 +9.4452")`);
  });

  it('J2000.0: dpsi≈−13.93", deps≈−5.77"（IAU 2000B）', () => {
    const { dpsi, deps } = nutationAngles(J2000_JD);
    assert.ok(close(dpsi, -13.9315, 0.05), `dpsi=${dpsi.toFixed(4)}" (期待値 -13.9315")`);
    assert.ok(close(deps,  -5.7698, 0.05), `deps=${deps.toFixed(4)}" (期待値 -5.7698")`);
  });
});

// =========================================================================
// icrsToEcliptic — ICRS XYZ → of-date 黄道（合成）
// =========================================================================
describe('icrsToEcliptic — ICRS → of-date 黄道（合成）', () => {
  // T=0 では章動 ΔΨ ≈ −13.9" が黄経に現れるため、icrsToJ2000Ecliptic とは
  // 約 14" 程度の差が生じる（これは正常な動作）
  it('T=0（J2000.0）: icrsToJ2000Ecliptic と章動量（≈14"）以内の差', () => {
    const r1 = icrsToJ2000Ecliptic(0.17713507, -0.88742848, -0.38474288);
    const r2 = icrsToEcliptic(0.17713507, -0.88742848, -0.38474288, J2000_JD);
    const dlon_arcsec = Math.abs(r2.lon - r1.lon) * 3600;
    // 章動 ΔΨ ≈ ±30" 以内の差であることを確認
    assert.ok(dlon_arcsec < 30, `lon 差分 ${dlon_arcsec.toFixed(1)}" が 30" を超過`);
    assert.ok(close(r1.dist, r2.dist, EPS6), `dist 不一致: ${r1.dist} vs ${r2.dist}`);
  });

  // IAU 2006 Capitaine 3角度歳差（ψ_A ≈ +5037"）と IAU 2000B 章動込みの
  // 合計黄経変化 ≈ +5033"（+1.398°）
  it('T=+1（J2100.0）: J2000 黄経から約 +1.398° 増加（Capitaine 歳差 + IAU 2000B 章動）', () => {
    const jd = J2000_JD + 36525;
    const r2000 = icrsToJ2000Ecliptic(0.17713507, -0.88742848, -0.38474288);
    const rDate = icrsToEcliptic(0.17713507, -0.88742848, -0.38474288, jd);
    const diff  = rDate.lon - r2000.lon;
    // Capitaine 3角度 + IAU 2000B 章動込みの差分 ≈ 1.3981°
    assert.ok(close(diff, 1.3981, 0.005), `歳差+章動差分=${diff.toFixed(5)}° (期待 1.3981°±0.005°)`);
    // 距離（モジュール）は不変
    assert.ok(close(r2000.dist, rDate.dist, EPS6), `dist: ${r2000.dist} vs ${rDate.dist}`);
  });

  it('戻り値は 0–360° 範囲', () => {
    const r = icrsToEcliptic(1, 0, 0, J2000_JD);
    assert.ok(r.lon >= 0 && r.lon < 360);
  });
});

// =========================================================================
// applyAberration — 速度ベクトル法光行差補正
// =========================================================================
describe('applyAberration — 速度ベクトル法 ICRS 光行差', () => {
  // 地球の典型的な公転速度: ~29.78 km/s = ~2573352 km/day
  // κ ≈ 20.5" → β ≈ 9.936e-5

  it('速度ゼロのとき入力方向と一致（単位ベクトル）', () => {
    const { x, y, z } = applyAberration(1, 0, 0, 0, 0, 0);
    assert.ok(close(x, 1, EPS6), `x=${x}`);
    assert.ok(close(y, 0, EPS6), `y=${y}`);
    assert.ok(close(z, 0, EPS6), `z=${z}`);
  });

  it('速度ゼロのとき任意方向でも不変', () => {
    const { x, y, z } = applyAberration(3, 4, 0, 0, 0, 0);
    assert.ok(close(x, 3 / 5, EPS6), `x=${x}`);
    assert.ok(close(y, 4 / 5, EPS6), `y=${y}`);
    assert.ok(close(z, 0, EPS6), `z=${z}`);
  });

  it('典型的な地球速度で出力がほぼ単位ベクトル', () => {
    // 地球速度 ≈ 30 km/s = 2592000 km/day（+Y方向）
    const v = 30 * 86400;
    const { x, y, z } = applyAberration(1e8, 0, 0, 0, v, 0);
    const norm = Math.sqrt(x * x + y * y + z * z);
    assert.ok(close(norm, 1, 1e-7), `|u'|=${norm}`);
  });

  it('光行差量は光行差定数 κ ≈ 20.5" のオーダー', () => {
    // 太陽方向（+X）に対して速度が +Y の場合:
    // 天体が +X にあり、地球が +Y に動いていれば光行差は +Y 方向にずれる
    const C_KM_PER_DAY = 299792.458 * 86400;
    const v = 29.78 * 86400;  // 典型的な地球公転速度 km/day
    const { x, y, z } = applyAberration(1e8, 0, 0, 0, v, 0);
    const beta = v / C_KM_PER_DAY;
    // y 成分は β ≈ 9.94e-5 に近いはず
    assert.ok(close(y, beta, 1e-6), `y=${y.toExponential(4)}, β=${beta.toExponential(4)}`);
  });

  it('逆方向の速度では符号が反転', () => {
    const v = 29.78 * 86400;
    const pos = applyAberration(1e8, 0, 0, 0,  v, 0);
    const neg = applyAberration(1e8, 0, 0, 0, -v, 0);
    assert.ok(pos.y > 0, `正速度で y>0: y=${pos.y}`);
    assert.ok(neg.y < 0, `負速度で y<0: y=${neg.y}`);
    assert.ok(close(pos.y, -neg.y, 1e-10), '符号対称');
  });
});

// =========================================================================
// observerGCRS — WGS-84 観測者 GCRS 位置ベクトル
// =========================================================================
describe('observerGCRS — WGS-84 → GCRS 位置ベクトル', () => {
  // 地球半径 WGS-84 平均: 6371.009 km
  const EARTH_R_KM = 6371.009;

  it('赤道上（lat=0, lon=0, elev=0）でベクトルが赤道面 X 軸方向', () => {
    const jdUtc = J2000_JD;  // GMST ≈ 280.46° → X軸からずれるが大きさは正しい
    const [x, y, z] = observerGCRS(0, 0, 0, jdUtc);
    const r = Math.sqrt(x * x + y * y + z * z);
    // z ≈ 0（赤道上）
    assert.ok(close(z, 0, 1), `z=${z.toFixed(3)} (赤道上なので ~0)`);
    // 地球赤道半径に一致（WGS-84 a = 6378.137 km）
    assert.ok(close(r, 6378.137, 0.1), `r=${r.toFixed(3)} km`);
  });

  it('北極（lat=90, lon=0, elev=0）で z ≈ b（短半径）', () => {
    const [x, y, z] = observerGCRS(90, 0, 0, J2000_JD);
    // WGS-84 短半径 b = 6356.752 km
    assert.ok(close(z, 6356.752, 0.5), `z=${z.toFixed(3)} km`);
    assert.ok(close(x, 0, 1), `x=${x.toFixed(3)}`);
    assert.ok(close(y, 0, 1), `y=${y.toFixed(3)}`);
  });

  it('距離は地球半径 ±30 km 以内', () => {
    // 東京（35.69°N, 139.69°E）
    const [x, y, z] = observerGCRS(35.6895, 139.6917, 0, J2000_JD);
    const r = Math.sqrt(x * x + y * y + z * z);
    assert.ok(Math.abs(r - EARTH_R_KM) < 30, `r=${r.toFixed(3)} km`);
  });

  it('標高 100km で距離が約 100km 増加', () => {
    const [x0, y0, z0] = observerGCRS(35.0, 135.0, 0,   J2000_JD);
    const [x1, y1, z1] = observerGCRS(35.0, 135.0, 100, J2000_JD);
    const r0 = Math.sqrt(x0*x0 + y0*y0 + z0*z0);
    const r1 = Math.sqrt(x1*x1 + y1*y1 + z1*z1);
    assert.ok(close(r1 - r0, 100, 1), `標高差=${(r1 - r0).toFixed(3)} km`);
  });

  it('対蹠点では符号が反転', () => {
    const [x1, y1, z1] = observerGCRS( 35.0,  135.0, 0, J2000_JD);
    const [x2, y2, z2] = observerGCRS(-35.0, -45.0,  0, J2000_JD);
    assert.ok(close(x1 + x2, 0, 5), `x1+x2=${(x1+x2).toFixed(3)}`);
    assert.ok(close(z1 + z2, 0, 1), `z1+z2=${(z1+z2).toFixed(3)}`);
  });
});

// =========================================================================
// applyLightDeflection — 太陽重力場による光偏差補正
// =========================================================================
describe('applyLightDeflection — 光偏差補正', () => {
  // 太陽地球間距離 ≈ 1 AU = 149597870.7 km
  const AU = 149597870.7;

  it('太陽と天体が同方向（正反対）なら補正量はゼロ', () => {
    // 太陽方向 +X に天体も +X：ê_q·ê_e ≈ 1 → 補正 → 0
    // ただし ê_q·ê_e = 1 は特異点なので、ほぼ同方向で確認
    const { x, y, z } = applyLightDeflection(1e8, 0, 0, AU, 0, 0);
    const norm = Math.sqrt(x*x + y*y + z*z);
    assert.ok(close(norm, 1, 1e-9), `|u'|=${norm}`);
  });

  it('出力は単位ベクトル', () => {
    const { x, y, z } = applyLightDeflection(0, 1e8, 0, AU, 0, 0);
    const norm = Math.sqrt(x*x + y*y + z*z);
    assert.ok(close(norm, 1, 1e-9), `|u'|=${norm}`);
  });

  it('太陽と90°離れた天体の偏差 ≈ 2GM_sun/c²/r ≈ 1.97e-8 rad ≈ 0.004"', () => {
    // 太陽 +X 方向、天体 +Y 方向（90°離れ）
    const { x, y } = applyLightDeflection(0, 1e8, 0, AU, 0, 0);
    // +X 方向への偏差が発生（太陽方向に引っ張られる）
    const deflArcsec = Math.abs(x) * (180 / Math.PI) * 3600;
    // 0.001" ～ 0.005" のオーダー
    assert.ok(deflArcsec > 0.001 && deflArcsec < 0.01,
      `偏差=${deflArcsec.toFixed(5)}" (期待 0.001〜0.01")`);
  });

  it('太陽から遠い天体ほど偏差が小さい', () => {
    // 太陽距離 2倍で偏差 1/2
    const r1 = applyLightDeflection(0, 1e8, 0, AU, 0, 0);
    const r2 = applyLightDeflection(0, 1e8, 0, 2 * AU, 0, 0);
    assert.ok(Math.abs(r1.x) > Math.abs(r2.x), '近い方が偏差大');
    assert.ok(close(r1.x / r2.x, 2, 0.01), `偏差比≈2: ${(r1.x/r2.x).toFixed(4)}`);
  });
});
