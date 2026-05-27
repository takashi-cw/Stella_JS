/**
 * bsp-reader.test.js — bsp-reader.js の単体テスト
 *
 * 実行: node --test test/core/bsp-reader.test.js
 *
 * テスト構成:
 *   1. 単体テスト（モックデータ）— .bsp ファイルなしで実行可能
 *   2. 結合テスト（実データ）  — de440s.bsp が存在する場合のみ実行
 *
 * 精度検証の基準値:
 *   J2000.0 (2000-01-01 12:00 TDB = JD 2451545.0) の太陽位置（ICRS, SSB基準）
 *   Skyfield で確認済み: X≈-2.7e6 km, Y≈-4.4e5 km, Z≈-1.9e5 km （オーダー）
 */

import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadBsp, parseBsp, BspFile } from '../../public/src/core/bsp-reader.js';
import { jdUtcToTdb } from '../../public/src/core/timescale.js';
import { AU_KM, NAIF, J2000_JD } from '../../public/src/core/constants.js';

// de440s.bsp のパス（Stella-JS/public/data/ 内の開発用フル版）
// test/core/ からの相対パス: ../.. = Stella-JS/, public/data/de440s.bsp
const BSP_PATH = '../../public/data/de440s.bsp';
const BSP_ABS  = fileURLToPath(new URL(BSP_PATH, import.meta.url));
const HAS_BSP  = existsSync(BSP_ABS);

// =========================================================================
// 1. 単体テスト（モックデータ不要 = API・型の確認）
// =========================================================================
describe('bsp-reader — exports の確認', () => {
  it('loadBsp は関数', () => {
    assert.strictEqual(typeof loadBsp, 'function');
  });

  it('parseBsp は関数', () => {
    assert.strictEqual(typeof parseBsp, 'function');
  });

  it('BspFile はクラス', () => {
    assert.strictEqual(typeof BspFile, 'function');
  });
});

describe('bsp-reader — 不正な入力に対するエラー', () => {
  it('空の ArrayBuffer は例外を投げる', () => {
    const buf = new ArrayBuffer(0);
    assert.throws(() => parseBsp(buf), /TypeError|RangeError|非SPK/);
  });

  it('不正なマジックバイトは例外を投げる', () => {
    const buf = new ArrayBuffer(1024);
    const view = new DataView(buf);
    const bad = 'NOTSPK  ';
    for (let i = 0; i < 8; i++) view.setUint8(i, bad.charCodeAt(i));
    assert.throws(() => parseBsp(buf), /非SPK/);
  });
});

// =========================================================================
// 合成 BSP データ生成ヘルパー
// =========================================================================

/**
 * 最小限の DAF/SPK Type 2 合成バイナリを生成する
 *
 * Record 1 (0–1023):    ファイルヘッダー
 * Record 2 (1024–2047): サマリー（Sun/SSB, spkType=2）
 * Record 3 (2048–2167): Type 2 データ（ncoeff=3, rsize=11, 1レコード）
 *
 * J2000.0 での期待位置: x=100000, y=200000, z=300000 km
 */
function makeSyntheticBsp({ spkType = 2 } = {}) {
  const buf  = new ArrayBuffer(3 * 1024);
  const view = new DataView(buf);

  const writeStr = (s, offset, pad) => {
    for (let i = 0; i < pad; i++) {
      view.setUint8(offset + i, i < s.length ? s.charCodeAt(i) : 0x20);
    }
  };
  const le = true;

  // Record 1: ヘッダー
  writeStr('DAF/SPK ', 0, 8);
  view.setInt32(8,  2, le);   // ND
  view.setInt32(12, 6, le);   // NI
  writeStr('SyntheticBSP', 16, 60);
  view.setInt32(76, 2, le);   // FWARD
  view.setInt32(80, 2, le);   // BWARD
  writeStr('LTL-IEEE', 88, 8);

  // Record 2: サマリー
  // Type 2: firstAddr=257, lastAddr=271（rsize=11, n=1 → 15 doubles）
  // Type 3: firstAddr=257, lastAddr=268（rsize=8,  n=1 → 12 doubles）
  const isType3  = spkType === 3;
  const lastAddr = isType3 ? 268 : 271;
  const r2 = 1024;
  view.setFloat64(r2 + 0,  0.0, le);   // next rec
  view.setFloat64(r2 + 8,  0.0, le);
  view.setFloat64(r2 + 16, 1.0, le);   // NSUM
  const s = r2 + 24;
  view.setFloat64(s,       -86400.0, le);  // startJd（秒 → JD に変換されて格納、ここは便宜上秒を直接）
  view.setFloat64(s + 8,   86400.0, le);   // endJd（同上）
  view.setInt32(s + 16,  10, le);  // target = Sun
  view.setInt32(s + 20,   0, le);  // center = SSB
  view.setInt32(s + 24,   1, le);  // frame
  view.setInt32(s + 28,   spkType, le);
  view.setInt32(s + 32,   257, le);
  view.setInt32(s + 36,   lastAddr, le);

  // Record 3: データ
  const r3 = 2048;
  view.setFloat64(r3 + 0,  0.0,     le);  // mid
  view.setFloat64(r3 + 8,  86400.0, le);  // radius

  if (isType3) {
    // [Xpos, Ypos, Zpos, Xvel, Yvel, Zvel] (ncoeff=1 each)
    view.setFloat64(r3 + 16, 100000.0, le); // Xpos
    view.setFloat64(r3 + 24, 200000.0, le); // Ypos
    view.setFloat64(r3 + 32, 300000.0, le); // Zpos
    // Xvel, Yvel, Zvel = 0 (すでに 0 埋め)
    // メタ: dataEnd=268*8=2144 → metaOffset=2112
    view.setFloat64(2112, -86400.0, le);  // init
    view.setFloat64(2120, 172800.0, le);  // intlen
    view.setFloat64(2128, 8.0,      le);  // rsize
    view.setFloat64(2136, 1.0,      le);  // n
  } else {
    // [Xpos×3, Ypos×3, Zpos×3] (ncoeff=3)
    view.setFloat64(r3 + 16, 100000.0, le); // coeffX[0]
    // coeffX[1], coeffX[2] = 0
    view.setFloat64(r3 + 40, 200000.0, le); // coeffY[0]
    view.setFloat64(r3 + 64, 300000.0, le); // coeffZ[0]
    // メタ: dataEnd=271*8=2168 → metaOffset=2136
    view.setFloat64(2136, -86400.0, le);  // init
    view.setFloat64(2144, 172800.0, le);  // intlen
    view.setFloat64(2152, 11.0,     le);  // rsize
    view.setFloat64(2160, 1.0,      le);  // n
  }

  // サマリーの startJd/endJd は実際は JD 値が格納される。
  // ここでは _parseSummaries がそのまま使うので、_findSegment 用に JD 値に合わせる必要がある。
  // J2000_JD = 2451545.0、セグメントは ±1 day とする。
  const J2000 = 2451545.0;
  view.setFloat64(s,     J2000 - 1.0, le);  // startJd
  view.setFloat64(s + 8, J2000 + 1.0, le);  // endJd

  return buf;
}

// =========================================================================
// 合成 BSP を使った単体テスト
// =========================================================================

describe('bsp-reader — 合成 BSP（Type 2）', () => {
  const J2000 = 2451545.0;

  it('セグメントが 1 件パースされる', () => {
    const bsp = parseBsp(makeSyntheticBsp());
    assert.strictEqual(bsp.segments.length, 1);
    assert.strictEqual(bsp.segments[0].target, 10);
    assert.strictEqual(bsp.segments[0].type, 2);
  });

  it('J2000.0 の位置が正しい（定数係数）', () => {
    const bsp = parseBsp(makeSyntheticBsp());
    const pos = bsp.getPosition(10, 0, J2000);
    assert.ok(Math.abs(pos[0] - 100000) < 1e-6, `x=${pos[0]}`);
    assert.ok(Math.abs(pos[1] - 200000) < 1e-6, `y=${pos[1]}`);
    assert.ok(Math.abs(pos[2] - 300000) < 1e-6, `z=${pos[2]}`);
  });

  it('computePosition と getPosition が一致する', () => {
    const bsp = parseBsp(makeSyntheticBsp());
    const p1 = bsp.getPosition(10, 0, J2000);
    const p2 = bsp.computePosition(10, 0, J2000);
    assert.ok(Math.abs(p1[0] - p2[0]) < 1e-9);
  });

  it('同一 target/center は [0,0,0]', () => {
    const bsp = parseBsp(makeSyntheticBsp());
    const pos = bsp.computePosition(10, 10, J2000);
    assert.deepStrictEqual(pos, [0, 0, 0]);
  });

  it('定数係数 → 速度 = 0', () => {
    const bsp = parseBsp(makeSyntheticBsp());
    const { position, velocity } = bsp.getPositionAndVelocity(10, 0, J2000);
    assert.ok(Math.abs(position[0] - 100000) < 1e-6);
    assert.ok(Math.abs(velocity[0]) < 1e-6);
    assert.ok(Math.abs(velocity[1]) < 1e-6);
    assert.ok(Math.abs(velocity[2]) < 1e-6);
  });

  it('範囲外 JD はエラーを投げる', () => {
    const bsp = parseBsp(makeSyntheticBsp());
    // セグメントは J2000 ± 1 day → 1 week 後は範囲外
    assert.throws(
      () => bsp.getPosition(10, 0, J2000 + 7),
      /セグメントが見つかりません|out of coverage/
    );
  });
});

describe('bsp-reader — 合成 BSP（Type 3）', () => {
  const J2000 = 2451545.0;

  it('Type 3 セグメントが spkType=3 としてパースされる', () => {
    const bsp = parseBsp(makeSyntheticBsp({ spkType: 3 }));
    assert.strictEqual(bsp.segments[0].type, 3);
  });

  it('Type 3 から位置が正しく取得できる', () => {
    const bsp = parseBsp(makeSyntheticBsp({ spkType: 3 }));
    const pos = bsp.getPosition(10, 0, J2000);
    assert.ok(Math.abs(pos[0] - 100000) < 1e-6, `x=${pos[0]}`);
    assert.ok(Math.abs(pos[1] - 200000) < 1e-6, `y=${pos[1]}`);
    assert.ok(Math.abs(pos[2] - 300000) < 1e-6, `z=${pos[2]}`);
  });

  it('Type 3 定数係数 → 速度 = 0', () => {
    const bsp = parseBsp(makeSyntheticBsp({ spkType: 3 }));
    const { velocity } = bsp.getPositionAndVelocity(10, 0, J2000);
    assert.ok(Math.abs(velocity[0]) < 1e-6);
    assert.ok(Math.abs(velocity[1]) < 1e-6);
    assert.ok(Math.abs(velocity[2]) < 1e-6);
  });

  it('Type 3 computePosition と getPosition が一致', () => {
    const bsp = parseBsp(makeSyntheticBsp({ spkType: 3 }));
    const p1 = bsp.getPosition(10, 0, J2000);
    const p2 = bsp.computePosition(10, 0, J2000);
    assert.ok(Math.abs(p1[0] - p2[0]) < 1e-9);
  });
});

describe('bsp-reader — Type 13（非対応）', () => {
  const J2000 = 2451545.0;

  it('Type 13 セグメントは例外を投げる', () => {
    const bsp = parseBsp(makeSyntheticBsp({ spkType: 13 }));
    assert.throws(
      () => bsp.getPosition(10, 0, J2000),
      /未対応の SPK タイプ: 13/
    );
  });
});

// =========================================================================
// 2. 結合テスト（de440s.bsp が存在する場合のみ）
// =========================================================================
describe('bsp-reader — 実ファイル結合テスト (de440s.bsp)', { skip: !HAS_BSP }, () => {
  let bsp;

  before(async () => {
    const buf = await loadBsp(BSP_ABS);
    bsp = parseBsp(buf);
  });

  it('BspFile インスタンスが生成される', () => {
    assert.ok(bsp instanceof BspFile);
  });

  it('セグメントが 1 つ以上存在する', () => {
    assert.ok(bsp.segments.length > 0, `segments.length=${bsp.segments.length}`);
  });

  it('segments には target, center, startJd, endJd が含まれる', () => {
    for (const seg of bsp.segments) {
      assert.ok(typeof seg.target === 'number', 'target');
      assert.ok(typeof seg.center === 'number', 'center');
      assert.ok(typeof seg.startJd === 'number', 'startJd');
      assert.ok(typeof seg.endJd === 'number', 'endJd');
      assert.ok(seg.endJd > seg.startJd, 'endJd > startJd');
    }
  });

  it('pairs に Sun→SSB が含まれる', () => {
    const sunSsb = bsp.pairs.find(p => p.target === NAIF.SUN && p.center === NAIF.SSB);
    assert.ok(sunSsb, '太陽(10)→SSB(0) セグメントが存在すること');
  });

  it('pairs に Moon→EMB が含まれる', () => {
    const moonEmb = bsp.pairs.find(p => p.target === NAIF.MOON && p.center === NAIF.EMB);
    assert.ok(moonEmb, '月(301)→EMB(3) セグメントが存在すること');
  });

  it('J2000.0 の Sun(10) 位置が SSB 基準で合理的な値', () => {
    const pos = bsp.getPosition(NAIF.SUN, NAIF.SSB, J2000_JD);
    assert.strictEqual(pos.length, 3, '3成分');
    const dist = Math.sqrt(pos[0]**2 + pos[1]**2 + pos[2]**2);
    // 太陽は SSB からごく近い場所（概ね太陽半径程度か数百万km以内）
    const distAu = dist / AU_KM;
    assert.ok(distAu < 0.1, `太陽-SSB 距離 ≈ ${distAu.toFixed(4)} AU が 0.1 AU 以内`);
    assert.ok(distAu >= 0, 'distAu >= 0');
  });

  it('J2000.0 の Earth(399) 位置が合理的な値（SSB経由の合成）', () => {
    // Earth は直接セグメントなし。EMB 経由: SSB→EMB + EMB→Earth
    const pos = bsp.computePosition(NAIF.EARTH, NAIF.SSB, J2000_JD);
    const dist = Math.sqrt(pos[0]**2 + pos[1]**2 + pos[2]**2);
    const distAu = dist / AU_KM;
    // 地球の太陽距離 ≈ 1 AU (0.98〜1.02)
    // ただし SSB 起点なので厳密には異なるが概算チェック
    assert.ok(distAu > 0.9 && distAu < 1.1,
      `地球-SSB 距離 ≈ ${distAu.toFixed(4)} AU が 0.9〜1.1 AU の範囲`);
  });

  it('J2000.0 の Jupiter Barycenter 位置が合理的', () => {
    const pos = bsp.getPosition(NAIF.JUPITER_BARYCENTER, NAIF.SSB, J2000_JD);
    const dist = Math.sqrt(pos[0]**2 + pos[1]**2 + pos[2]**2);
    const distAu = dist / AU_KM;
    // 木星の平均距離 ≈ 5.2 AU
    assert.ok(distAu > 4.0 && distAu < 6.5,
      `木星-SSB 距離 ≈ ${distAu.toFixed(3)} AU が 4〜6.5 AU の範囲`);
  });

  it('computePosition(Earth, SSB) と getPosition(EMB,SSB)+getPosition(Earth,EMB) の合成が近い', () => {
    const jd = J2000_JD;
    const embPos = bsp.getPosition(NAIF.EMB, NAIF.SSB, jd);
    const earthFromEmb = bsp.getPosition(NAIF.EARTH, NAIF.EMB, jd);
    const expected = [
      embPos[0] + earthFromEmb[0],
      embPos[1] + earthFromEmb[1],
      embPos[2] + earthFromEmb[2],
    ];
    const computed = bsp.computePosition(NAIF.EARTH, NAIF.SSB, jd);

    for (let i = 0; i < 3; i++) {
      const diff = Math.abs(computed[i] - expected[i]);
      assert.ok(diff < 1.0,  // 1 km 以内
        `成分 ${i}: computed=${computed[i].toFixed(1)}, expected=${expected[i].toFixed(1)}, diff=${diff.toFixed(3)}`);
    }
  });

  it('時刻補間の連続性: JD を 0.01 日ずつ変えた時に位置が連続する', () => {
    const jd0 = J2000_JD;
    const pos0 = bsp.getPosition(NAIF.SUN, NAIF.SSB, jd0);
    const pos1 = bsp.getPosition(NAIF.SUN, NAIF.SSB, jd0 + 0.01);
    // 太陽は 1 日に約 15〜20 km 動く
    const dist = Math.sqrt(
      (pos1[0]-pos0[0])**2 + (pos1[1]-pos0[1])**2 + (pos1[2]-pos0[2])**2
    );
    assert.ok(dist > 0 && dist < 1000,
      `0.01 日の太陽移動距離 ≈ ${dist.toFixed(2)} km が 0〜1000 km の範囲`);
  });

  it('速度も取得できる: getPositionAndVelocity', () => {
    const { position, velocity } = bsp.getPositionAndVelocity(NAIF.SUN, NAIF.SSB, J2000_JD);
    assert.strictEqual(position.length, 3);
    assert.strictEqual(velocity.length, 3);
    // 太陽の速度は km/day 単位で数十〜数百程度
    const speed = Math.sqrt(velocity[0]**2 + velocity[1]**2 + velocity[2]**2);
    assert.ok(speed > 0, `速度 > 0: ${speed}`);
    assert.ok(speed < 1e6, `速度が異常値でない: ${speed} km/day`);
  });
});

if (!HAS_BSP) {
  console.log(`⚠️  結合テストをスキップ: ${BSP_ABS} が存在しません`);
}
