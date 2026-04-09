/**
 * aspects.test.js — aspects.js の単体テスト
 *
 * 実行: node --test test/chart/aspects.test.js
 *
 * 基準値（Python 手計算 + flatlib props.py 準拠）:
 *   - closestAngularDist: 符号付き最短距離
 *   - analyzeAspect: メジャー・マイナーアスペクト、オーブ判定、接近/離脱
 *   - getAllAspects: 全組み合わせ検出・オーブ昇順
 *   - getAspectStats: 統計集計
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ASPECT,
  MAJOR_ASPECTS,
  ALL_ASPECTS,
  PLANET,
  PLANET_ORBS,
  ASPECT_NAMES_EN,
  ASPECT_NAMES_JP,
  ASPECT_SYMBOLS,
  closestAngularDist,
  getPlanetOrb,
  analyzeAspect,
  getAllAspects,
  getAspectStats,
} from '../../public/src/chart/aspects.js';

const EPS = 1e-9;
const close = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// =========================================================================
// closestAngularDist
// =========================================================================
describe('closestAngularDist — 符号付き最短角度差', () => {
  it('同一位置: 0°', () => assert.ok(close(closestAngularDist(0, 0), 0)));
  it('0° → 60°: +60°', () => assert.ok(close(closestAngularDist(0, 60), 60)));
  it('0° → 180°: 180°', () => assert.ok(close(closestAngularDist(0, 180), 180)));
  it('0° → 270°: -90°（時計回りが短い）', () => assert.ok(close(closestAngularDist(0, 270), -90)));
  it('350° → 10°: +20°（境界またぎ）', () => assert.ok(close(closestAngularDist(350, 10), 20)));
  it('10° → 350°: -20°', () => assert.ok(close(closestAngularDist(10, 350), -20)));
  it('返り値は -180 〜 +180 の範囲', () => {
    for (let d = 0; d <= 360; d += 15) {
      const r = closestAngularDist(0, d);
      assert.ok(r >= -180 && r <= 180, `d=${d} → ${r}`);
    }
  });
});

// =========================================================================
// getPlanetOrb
// =========================================================================
describe('getPlanetOrb — 惑星オーブ取得', () => {
  it('太陽: 15°', () => assert.strictEqual(getPlanetOrb(PLANET.SUN), 15));
  it('月: 12°', ()  => assert.strictEqual(getPlanetOrb(PLANET.MOON), 12));
  it('水星: 7°', ()  => assert.strictEqual(getPlanetOrb(PLANET.MERCURY), 7));
  it('土星: 9°', ()  => assert.strictEqual(getPlanetOrb(PLANET.SATURN), 9));
  it('未知 ID: デフォルト 5°', () => assert.strictEqual(getPlanetOrb('Unknown'), 5));
});

// =========================================================================
// analyzeAspect — アスペクト検出・運動判定
// =========================================================================
describe('analyzeAspect — メジャーアスペクト検出', () => {
  // 太陽(lon=0, speed=1) vs 木星(lon=0, speed=0.08) → 合
  it('合（Conjunction）: lon差=0°', () => {
    const sun = { id: PLANET.SUN, lon: 0, lonspeed: 1.0 };
    const jup = { id: PLANET.JUPITER, lon: 0, lonspeed: 0.08 };
    const r = analyzeAspect(sun, jup);
    assert.ok(r.exists, 'exists');
    assert.strictEqual(r.type, ASPECT.CONJUNCTION);
    assert.ok(close(r.orb, 0, EPS));
    assert.ok(r.exact);
  });

  it('セクスタイル（60°）', () => {
    const sun = { id: PLANET.SUN, lon: 0, lonspeed: 1.0 };
    const mar = { id: PLANET.MARS, lon: 60, lonspeed: 0.5 };
    const r = analyzeAspect(sun, mar);
    assert.strictEqual(r.type, ASPECT.SEXTILE);
    assert.ok(close(r.orb, 0, EPS));
  });

  it('スクエア（90°）', () => {
    const sun = { id: PLANET.SUN, lon: 0, lonspeed: 1.0 };
    const sat = { id: PLANET.SATURN, lon: 90, lonspeed: 0.03 };
    const r = analyzeAspect(sun, sat);
    assert.strictEqual(r.type, ASPECT.SQUARE);
    assert.ok(close(r.orb, 0, EPS));
  });

  it('トライン（120°）', () => {
    const sun = { id: PLANET.SUN, lon: 0, lonspeed: 1.0 };
    const jup = { id: PLANET.JUPITER, lon: 120, lonspeed: 0.08 };
    const r = analyzeAspect(sun, jup);
    assert.strictEqual(r.type, ASPECT.TRINE);
  });

  it('オポジション（180°）', () => {
    const sun = { id: PLANET.SUN, lon: 0, lonspeed: 1.0 };
    const sat = { id: PLANET.SATURN, lon: 180, lonspeed: 0.03 };
    const r = analyzeAspect(sun, sat);
    assert.strictEqual(r.type, ASPECT.OPPOSITION);
  });

  it('360° 境界をまたいだ合', () => {
    const sun = { id: PLANET.SUN, lon: 355, lonspeed: 1.0 };
    const mar = { id: PLANET.MARS, lon: 5, lonspeed: 0.5 };
    const r = analyzeAspect(sun, mar);
    assert.strictEqual(r.type, ASPECT.CONJUNCTION);
    assert.ok(close(r.orb, 10, 0.001), `orb=${r.orb}`);
  });

  it('アスペクトなし（オーブ超過）', () => {
    // Uranus(orb=5) vs Neptune(orb=5): lon差=76°
    //   nearest major: sextile(60°) → orb=16 > 5
    //                  square(90°)  → orb=14 > 5
    // → どちらも両惑星のオーブを超える → アスペクトなし
    const ura = { id: PLANET.URANUS,  lon: 0,  lonspeed: 0.01 };
    const nep = { id: PLANET.NEPTUNE, lon: 76, lonspeed: 0.006 };
    const r = analyzeAspect(ura, nep, MAJOR_ASPECTS);
    assert.ok(!r.exists, `exists=${r.exists} type=${r.type} orb=${r.orb}`);
  });

  it('オーブ内のスクエア（5° 内）', () => {
    const sun = { id: PLANET.SUN, lon: 0, lonspeed: 1.0 };
    const mars = { id: PLANET.MARS, lon: 95, lonspeed: 0.5 };
    // orb=5 ≤ mars.orb=8 → 有効
    const r = analyzeAspect(sun, mars);
    assert.ok(r.exists);
    assert.strictEqual(r.type, ASPECT.SQUARE);
    assert.ok(close(r.orb, 5, 0.001));
  });
});

describe('analyzeAspect — 運動状態（接近・離脱）', () => {
  it('月(lon=85, speed=13) vs 太陽(lon=0, speed=1): スクエア・接近中', () => {
    // 月(active), 太陽(passive)
    // sep(moon→sun) = closestDist(85,0) = -85; orbDir=-85+90=+5>0, speed>0 → applying
    const sun  = { id: PLANET.SUN,  lon: 0,  lonspeed: 1.0 };
    const moon = { id: PLANET.MOON, lon: 85, lonspeed: 13.0 };
    const r = analyzeAspect(sun, moon);
    assert.ok(r.exists, 'exists');
    assert.strictEqual(r.type, ASPECT.SQUARE);
    assert.ok(close(r.orb, 5, 0.001), `orb=${r.orb}`);
    assert.strictEqual(r.movement, 'applying');
    assert.ok(r.applying);
  });

  it('月(lon=95, speed=13) vs 太陽(lon=0, speed=1): スクエア・離脱中', () => {
    // sep(moon→sun) = closestDist(95,0) = -95; orbDir=-95+90=-5<0, speed>0 → separating
    const sun  = { id: PLANET.SUN,  lon: 0,  lonspeed: 1.0 };
    const moon = { id: PLANET.MOON, lon: 95, lonspeed: 13.0 };
    const r = analyzeAspect(sun, moon);
    assert.ok(r.exists);
    assert.strictEqual(r.movement, 'separating');
    assert.ok(!r.applying);
  });

  it('完全一致（exact）: orb < 0.3°', () => {
    const sun  = { id: PLANET.SUN,  lon: 0,   lonspeed: 1.0 };
    const moon = { id: PLANET.MOON, lon: 0.1, lonspeed: 13.0 };
    const r = analyzeAspect(sun, moon);
    assert.strictEqual(r.type, ASPECT.CONJUNCTION);
    assert.ok(r.exact, `exact=${r.exact} orb=${r.orb}`);
    assert.strictEqual(r.movement, 'exact');
  });
});

describe('analyzeAspect — 方向（dexter / sinister）', () => {
  it('sep ≤ 0 → dexter', () => {
    // 月(active, 速い) が太陽(passive, 遅い) より後ろ（時計回り方向）
    const sun  = { id: PLANET.SUN,  lon: 90, lonspeed: 1.0 };
    const moon = { id: PLANET.MOON, lon: 0,  lonspeed: 13.0 };
    // sep(moon→sun) = closest(0, 90) = +90  → sinister
    const r = analyzeAspect(sun, moon);
    assert.strictEqual(r.direction, 'sinister');
  });

  it('sep > 0 → sinister', () => {
    const sun  = { id: PLANET.SUN,  lon: 0,  lonspeed: 1.0 };
    const moon = { id: PLANET.MOON, lon: 90, lonspeed: 13.0 };
    // sep(moon→sun) = closest(90, 0) = -90 → dexter
    const r = analyzeAspect(sun, moon);
    assert.strictEqual(r.direction, 'dexter');
  });
});

describe('analyzeAspect — マイナーアスペクト', () => {
  it('セミスクエア（45°）は ALL_ASPECTS で検出', () => {
    const sun = { id: PLANET.SUN, lon: 0, lonspeed: 1.0 };
    const mer = { id: PLANET.MERCURY, lon: 45, lonspeed: 1.5 };
    const r = analyzeAspect(sun, mer, ALL_ASPECTS);
    assert.ok(r.exists);
    assert.strictEqual(r.type, ASPECT.SEMISQUARE);
  });

  it('セミスクエアは MAJOR_ASPECTS では type=SEMISQUARE にならない', () => {
    // Uranus(orb=5) vs Neptune(orb=5): lon差=45°（セミスクエア）
    // MAJOR_ASPECTS ではセミスクエアは候補外 → 検出されない
    const ura = { id: PLANET.URANUS,  lon: 0,  lonspeed: 0.01 };
    const nep = { id: PLANET.NEPTUNE, lon: 45, lonspeed: 0.006 };
    const r = analyzeAspect(ura, nep, MAJOR_ASPECTS);
    // MAJOR_ASPECTS リストにセミスクエアがないので type === SEMISQUARE にはならない
    assert.ok(r.type !== ASPECT.SEMISQUARE,
      `type=${r.type} should not be SEMISQUARE`);
  });

  it('クインカンクス（150°）は ALL_ASPECTS で検出', () => {
    const sun = { id: PLANET.SUN, lon: 0, lonspeed: 1.0 };
    const jup = { id: PLANET.JUPITER, lon: 151, lonspeed: 0.08 };
    const r = analyzeAspect(sun, jup, ALL_ASPECTS);
    assert.ok(r.exists);
    assert.strictEqual(r.type, ASPECT.QUINCUNX);
    assert.ok(close(r.orb, 1, 0.001));
  });
});

// =========================================================================
// getAllAspects
// =========================================================================
describe('getAllAspects — 全組み合わせアスペクト', () => {
  // 3天体: 太陽(0°), 月(120°), 火星(180°)
  const planets = [
    { id: PLANET.SUN,  lon: 0,   lonspeed: 1.0 },
    { id: PLANET.MOON, lon: 120, lonspeed: 13.0 },
    { id: PLANET.MARS, lon: 180, lonspeed: 0.5 },
  ];

  it('トライン（太陽-月）と オポジション（太陽-火星）が検出される', () => {
    const asps = getAllAspects(planets);
    const types = asps.map(a => a.type);
    assert.ok(types.includes(ASPECT.TRINE), 'trine missing');
    assert.ok(types.includes(ASPECT.OPPOSITION), 'opposition missing');
  });

  it('結果はオーブ昇順にソートされている', () => {
    const asps = getAllAspects(planets);
    for (let i = 1; i < asps.length; i++) {
      assert.ok(asps[i].orb >= asps[i - 1].orb,
        `order error: ${asps[i-1].orb} > ${asps[i].orb}`);
    }
  });

  it('planet1, planet2 フィールドを持つ', () => {
    const asps = getAllAspects(planets);
    for (const a of asps) {
      assert.ok('planet1' in a);
      assert.ok('planet2' in a);
    }
  });

  it('空の惑星リスト → []', () => {
    assert.deepStrictEqual(getAllAspects([]), []);
  });
});

// =========================================================================
// getAspectStats
// =========================================================================
describe('getAspectStats — アスペクト統計', () => {
  it('空配列 → total=0', () => {
    const s = getAspectStats([]);
    assert.strictEqual(s.total, 0);
    assert.strictEqual(s.tightest, null);
  });

  it('統計値が正しく集計される', () => {
    const planets = [
      { id: PLANET.SUN,  lon: 0,   lonspeed: 1.0 },
      { id: PLANET.MOON, lon: 120, lonspeed: 13.0 },
      { id: PLANET.MARS, lon: 180, lonspeed: 0.5 },
    ];
    const asps  = getAllAspects(planets);
    const stats = getAspectStats(asps);
    assert.ok(stats.total > 0);
    assert.ok(stats.averageOrb >= 0);
    assert.ok(stats.tightest !== null);
    assert.ok(stats.tightest.orb <= stats.averageOrb + 1e-9);
  });
});

// =========================================================================
// 定数・記号テーブル
// =========================================================================
describe('定数テーブル', () => {
  it('ASPECT_NAMES_EN にメジャー5アスペクトが含まれる', () => {
    for (const t of MAJOR_ASPECTS) {
      assert.ok(t in ASPECT_NAMES_EN, `type=${t} missing`);
    }
  });

  it('ASPECT_NAMES_JP にメジャー5アスペクトが含まれる', () => {
    for (const t of MAJOR_ASPECTS) {
      assert.ok(t in ASPECT_NAMES_JP, `type=${t} missing`);
    }
  });

  it('ASPECT_SYMBOLS に合の記号 ☌ が登録されている', () => {
    assert.strictEqual(ASPECT_SYMBOLS[ASPECT.CONJUNCTION], '☌');
  });

  it('PLANET_ORBS に主要10天体が含まれる', () => {
    const required = [
      PLANET.SUN, PLANET.MOON, PLANET.MERCURY, PLANET.VENUS, PLANET.MARS,
      PLANET.JUPITER, PLANET.SATURN, PLANET.URANUS, PLANET.NEPTUNE, PLANET.PLUTO,
    ];
    for (const p of required) {
      assert.ok(p in PLANET_ORBS, `${p} missing`);
    }
  });
});
