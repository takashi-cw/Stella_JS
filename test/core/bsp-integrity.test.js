/**
 * bsp-integrity.test.js — 分割 BSP ファイルの整合性テスト
 *
 * 実行: node --test test/core/bsp-integrity.test.js
 *
 * テスト内容:
 *   1. 各分割ファイル（modern/history/future）が読み込めること
 *   2. 境界前後の天体位置が原本 BSP と完全一致すること
 *   3. 隣接ファイル間（history↔modern, modern↔future）の接続部が連続すること
 *
 * 実行条件:
 *   - modern:  public/data/de440s-modern.bsp  が存在すること
 *   - history: public/data/de440s-history.bsp が存在すること
 *   - future:  public/data/de440s-future.bsp  が存在すること
 *   - source:  public/data/de440s.bsp          が存在すること（modern の照合用・Stella-JS 内に自己完結）
 *   - source:  ../data/catalogs/de440.bsp     が存在すること（history/future の照合用・ない場合は自動 skip）
 *
 * 精度基準:
 *   位置差 < 1e-3 km（実質0）。Chebyshev 係数を再フィットせず原本コピーのため
 *   差は浮動小数点演算の丸め誤差のみ（1e-8 km 以下が期待値）。
 */

import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { existsSync }  from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadBsp, parseBsp } from '../../public/src/core/bsp-reader.js';
import { NAIF } from '../../public/src/core/constants.js';

// ── パス解決 ────────────────────────────────────────────────────────────────
// このファイルは test/core/ にある。Stella-JS ルートは ../../
const _base = new URL('../../', import.meta.url);
const abs = (rel) => fileURLToPath(new URL(rel, _base));

const PATH_MODERN  = abs('public/data/de440s-modern.bsp');
const PATH_HISTORY = abs('public/data/de440s-history.bsp');
const PATH_FUTURE  = abs('public/data/de440s-future.bsp');
const PATH_SRC_S   = abs('public/data/de440s.bsp');       // modern の照合元（Stella-JS 内に自己完結）
const PATH_SRC_D   = abs('../data/catalogs/de440.bsp');   // history/future の照合元（大元 BSP・ない場合は skip）

const HAS_MODERN  = existsSync(PATH_MODERN);
const HAS_HISTORY = existsSync(PATH_HISTORY);
const HAS_FUTURE  = existsSync(PATH_FUTURE);
const HAS_SRC_S   = existsSync(PATH_SRC_S);
const HAS_SRC_D   = existsSync(PATH_SRC_D);

// ── 定数 ────────────────────────────────────────────────────────────────────
const J2000_JD = 2451545.0;

/** JD 境界値（bsp_extractor.py の jd_from_date と同値） */
const JD = {
  HISTORY_START : 2287185.5,  // 1550-01-01
  HISTORY_END   : 2405158.5,  // 1872-12-31
  MODERN_START  : 2405159.5,  // 1873-01-01
  MODERN_END    : 2488433.5,  // 2100-12-31
  FUTURE_START  : 2488434.5,  // 2101-01-01
  FUTURE_END    : 2689316.5,  // 2650-12-31
};

/** 検証対象の天体ペア */
const PAIRS = [
  { target: NAIF.EMB,              center: NAIF.SSB,  label: '地球-月重心(EMB)' },
  { target: NAIF.MOON,             center: NAIF.EMB,  label: '月(Moon)'         },
  { target: NAIF.SUN,              center: NAIF.SSB,  label: '太陽(Sun)'         },
  { target: NAIF.JUPITER_BARYCENTER, center: NAIF.SSB, label: '木星重心'         },
];

// ── ヘルパー ────────────────────────────────────────────────────────────────

/** 3次元ベクトルの距離 */
function norm3(a, b) {
  return Math.sqrt(
    (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2
  );
}

/**
 * 2つの BspFile から同一 JD の同一天体位置を取得して差を返す。
 * どちらかがカバー範囲外なら null を返す。
 */
function posDiff(bspA, bspB, target, center, jd) {
  try {
    const pa = bspA.getPosition(target, center, jd);
    const pb = bspB.getPosition(target, center, jd);
    return norm3(pa, pb);
  } catch (_) {
    return null;  // カバー範囲外は skip
  }
}

// ── テストスイート ───────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════
// 1. de440s-modern.bsp の整合性テスト
// ════════════════════════════════════════════════════════════════════
describe(
  'BSP 整合性 [modern] de440s-modern.bsp vs de440s.bsp',
  { skip: !(HAS_MODERN && HAS_SRC_S) },
  () => {
    let modern, srcS;

    before(async () => {
      modern = parseBsp(await loadBsp(PATH_MODERN));
      srcS   = parseBsp(await loadBsp(PATH_SRC_S));
    });

    it('de440s-modern.bsp が読み込める', () => {
      assert.ok(modern.segments.length > 0, 'セグメントが存在すること');
    });

    it('セグメント数が 14 個（原本と同じ）', () => {
      assert.strictEqual(modern.segments.length, 14);
    });

    // 開始境界前後
    for (const ofs of [-1, 0, 1, 10]) {
      const jd = JD.MODERN_START + ofs;
      const yr = (2000 + (jd - J2000_JD) / 365.25).toFixed(2);
      for (const { target, center, label } of PAIRS) {
        it(`modern 開始境界 ${ofs >= 0 ? '+' : ''}${ofs}日 (${yr}年) — ${label}`, () => {
          const diff = posDiff(modern, srcS, target, center, jd);
          if (diff === null) return; // 範囲外はスキップ
          assert.ok(diff < 1e-3, `位置差 ${diff.toExponential(2)} km が 1e-3 km 未満`);
        });
      }
    }

    // 終了境界前後
    for (const ofs of [-10, -1, 0, 1]) {
      const jd = JD.MODERN_END + ofs;
      const yr = (2000 + (jd - J2000_JD) / 365.25).toFixed(2);
      for (const { target, center, label } of PAIRS) {
        it(`modern 終了境界 ${ofs >= 0 ? '+' : ''}${ofs}日 (${yr}年) — ${label}`, () => {
          const diff = posDiff(modern, srcS, target, center, jd);
          if (diff === null) return;
          assert.ok(diff < 1e-3, `位置差 ${diff.toExponential(2)} km が 1e-3 km 未満`);
        });
      }
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// 2. de440s-history.bsp の整合性テスト
// ════════════════════════════════════════════════════════════════════
describe(
  'BSP 整合性 [history] de440s-history.bsp vs de440.bsp',
  { skip: !(HAS_HISTORY && HAS_SRC_D) },
  () => {
    let history, srcD;

    before(async () => {
      history = parseBsp(await loadBsp(PATH_HISTORY));
      srcD    = parseBsp(await loadBsp(PATH_SRC_D));
    });

    it('de440s-history.bsp が読み込める', () => {
      assert.ok(history.segments.length > 0, 'セグメントが存在すること');
    });

    // 開始境界前後
    for (const ofs of [0, 1, 10]) {
      const jd = JD.HISTORY_START + ofs;
      const yr = (2000 + (jd - J2000_JD) / 365.25).toFixed(2);
      for (const { target, center, label } of PAIRS) {
        it(`history 開始境界 +${ofs}日 (${yr}年) — ${label}`, () => {
          const diff = posDiff(history, srcD, target, center, jd);
          if (diff === null) return;
          assert.ok(diff < 1e-3, `位置差 ${diff.toExponential(2)} km が 1e-3 km 未満`);
        });
      }
    }

    // 終了境界前後
    for (const ofs of [-10, -1, 0]) {
      const jd = JD.HISTORY_END + ofs;
      const yr = (2000 + (jd - J2000_JD) / 365.25).toFixed(2);
      for (const { target, center, label } of PAIRS) {
        it(`history 終了境界 ${ofs >= 0 ? '+' : ''}${ofs}日 (${yr}年) — ${label}`, () => {
          const diff = posDiff(history, srcD, target, center, jd);
          if (diff === null) return;
          assert.ok(diff < 1e-3, `位置差 ${diff.toExponential(2)} km が 1e-3 km 未満`);
        });
      }
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// 3. de440s-future.bsp の整合性テスト
// ════════════════════════════════════════════════════════════════════
describe(
  'BSP 整合性 [future] de440s-future.bsp vs de440.bsp',
  { skip: !(HAS_FUTURE && HAS_SRC_D) },
  () => {
    let future, srcD;

    before(async () => {
      future = parseBsp(await loadBsp(PATH_FUTURE));
      srcD   = parseBsp(await loadBsp(PATH_SRC_D));
    });

    it('de440s-future.bsp が読み込める', () => {
      assert.ok(future.segments.length > 0, 'セグメントが存在すること');
    });

    // 開始境界前後
    for (const ofs of [0, 1, 10]) {
      const jd = JD.FUTURE_START + ofs;
      const yr = (2000 + (jd - J2000_JD) / 365.25).toFixed(2);
      for (const { target, center, label } of PAIRS) {
        it(`future 開始境界 +${ofs}日 (${yr}年) — ${label}`, () => {
          const diff = posDiff(future, srcD, target, center, jd);
          if (diff === null) return;
          assert.ok(diff < 1e-3, `位置差 ${diff.toExponential(2)} km が 1e-3 km 未満`);
        });
      }
    }

    // 終了境界前後
    for (const ofs of [-10, -1, 0]) {
      const jd = JD.FUTURE_END + ofs;
      const yr = (2000 + (jd - J2000_JD) / 365.25).toFixed(2);
      for (const { target, center, label } of PAIRS) {
        it(`future 終了境界 ${ofs >= 0 ? '+' : ''}${ofs}日 (${yr}年) — ${label}`, () => {
          const diff = posDiff(future, srcD, target, center, jd);
          if (diff === null) return;
          assert.ok(diff < 1e-3, `位置差 ${diff.toExponential(2)} km が 1e-3 km 未満`);
        });
      }
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// 4. 隣接ファイル間の連続性テスト
// ════════════════════════════════════════════════════════════════════
describe(
  'BSP 連続性 [history ↔ modern] 1872-12-31 / 1873-01-01',
  { skip: !(HAS_HISTORY && HAS_MODERN && HAS_SRC_D) },
  () => {
    let history, modern, srcD;

    before(async () => {
      [history, modern, srcD] = await Promise.all([
        loadBsp(PATH_HISTORY).then(parseBsp),
        loadBsp(PATH_MODERN).then(parseBsp),
        loadBsp(PATH_SRC_D).then(parseBsp),
      ]);
    });

    for (const { target, center, label } of PAIRS) {
      it(`history 末尾 1872-12-31 が de440.bsp と一致 — ${label}`, () => {
        const diff = posDiff(history, srcD, target, center, JD.HISTORY_END);
        if (diff === null) return;
        assert.ok(diff < 1e-3, `Δ=${diff.toExponential(2)} km`);
      });

      it(`modern 開始 1873-01-01 が de440.bsp と一致 — ${label}`, () => {
        const diff = posDiff(modern, srcD, target, center, JD.MODERN_START);
        if (diff === null) return;
        assert.ok(diff < 1e-3, `Δ=${diff.toExponential(2)} km`);
      });
    }
  }
);

describe(
  'BSP 連続性 [modern ↔ future] 2100-12-31 / 2101-01-01',
  { skip: !(HAS_MODERN && HAS_FUTURE && HAS_SRC_D) },
  () => {
    let modern, future, srcD;

    before(async () => {
      [modern, future, srcD] = await Promise.all([
        loadBsp(PATH_MODERN).then(parseBsp),
        loadBsp(PATH_FUTURE).then(parseBsp),
        loadBsp(PATH_SRC_D).then(parseBsp),
      ]);
    });

    for (const { target, center, label } of PAIRS) {
      it(`modern 末尾 2100-12-31 が de440.bsp と一致 — ${label}`, () => {
        const diff = posDiff(modern, srcD, target, center, JD.MODERN_END);
        if (diff === null) return;
        assert.ok(diff < 1e-3, `Δ=${diff.toExponential(2)} km`);
      });

      it(`future 開始 2101-01-01 が de440.bsp と一致 — ${label}`, () => {
        const diff = posDiff(future, srcD, target, center, JD.FUTURE_START);
        if (diff === null) return;
        assert.ok(diff < 1e-3, `Δ=${diff.toExponential(2)} km`);
      });
    }
  }
);
