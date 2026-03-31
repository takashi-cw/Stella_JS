/**
 * timescale.test.js — timescale.js の単体テスト
 *
 * 実行: node --test test/core/timescale.test.js
 *
 * 基準値:
 *   標準ユリウス日定義（JD 0 = 4713 BC 1/1 12:00 UT）に準拠
 *   - dateToJd(2000, 1, 1, 12) = 2451545.0 (J2000.0)
 *   - dateToJd(2026, 3, 27, 12) = 2461127.0 (2000-01-01 から 9582 日)
 *   - dateToJd(-410, 6, 21, 12) = 1571477.0 (BC 410年)
 *   - JD 2299160.5 = 1582-10-15 (グレゴリオ施行初日の JDN=2299161)
 *
 *   注: Python版 timescale.py のdocstringの値(2460755.0)は誤り。
 *   正しくは 2461127.0 (docstringの日付が2025年当時のものが混入した模様)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  dateToJd,
  jdToDate,
  astroYearToHistorical,
  historicalYearToAstro,
  deltaT,
  deltaTFromJd,
  jdUtcToTt,
  jdTtToTdb,
  jdUtcToTdb,
  jstToJdUtc,
  localToJdUtc,
  jdToLocalSolarTime,
  classifyEra,
  ERA,
  TDBDatetime,
} from '../../src/core/timescale.js';

const EPS6 = 1e-6;   // JD の精度（約 0.1 秒相当）
const EPS3 = 1e-3;   // ΔT の精度（1ms 相当）
const close = (a, b, eps = EPS6) => Math.abs(a - b) < eps;

// =========================================================================
// dateToJd — 日付 → JD
// =========================================================================
describe('dateToJd — 基本動作', () => {
  it('J2000.0 エポック: 2000-01-01 12:00 UTC → 2451545.0', () => {
    const jd = dateToJd(2000, 1, 1, 12, 0, 0);
    assert.ok(close(jd, 2451545.0), `got ${jd}`);
  });

  it('2026-03-27 12:00 UTC → 2461127.0（J2000.0 から 9582 日）', () => {
    const jd = dateToJd(2026, 3, 27, 12, 0, 0);
    assert.ok(close(jd, 2461127.0), `got ${jd}`);
  });

  it('1582-10-10 00:00（ユリウス暦）→ Python: 2299165.5', () => {
    // Python: date_to_jd(1582, 10, 10) = JDN 2299166 → JD = 2299166 - 0.5 = 2299165.5
    const jd = dateToJd(1582, 10, 10);
    assert.ok(close(jd, 2299165.5), `got ${jd}`);
  });

  it('1582-10-15（グレゴリオ暦施行初日）は正常に計算される', () => {
    const jd = dateToJd(1582, 10, 15);
    assert.ok(close(jd, GREGORIAN_CUTOVER_JDN - 0.5), `got ${jd}`);
  });

  it('BC 410年（天文学方式 -410）: 2026-03-27 の基準値として確認', () => {
    // date_to_jd(-410, 6, 21, 12, 0, 0) = 1571477.0（Python）
    const jd = dateToJd(-410, 6, 21, 12, 0, 0);
    assert.ok(close(jd, 1571477.0), `got ${jd}`);
  });

  it('欠番日(1582-10-10) を gregorian 強制すると例外', () => {
    // 欠番: 1582-10-05〜10-14
    assert.throws(() => dateToJd(1582, 10, 10, 0, 0, 0, 'gregorian'), /グレゴリオ暦に存在しない/);
  });

  it('時刻の精度: 2000-01-01 18:30:30 → 正確に計算される', () => {
    const jd = dateToJd(2000, 1, 1, 18, 30, 30);
    // 12:00 UTC = 2451545.0, 6h30m30s = 6.5083... 時間 = 0.271204... 日
    const expected = 2451545.0 + (6 * 3600 + 30 * 60 + 30) / 86400;
    assert.ok(close(jd, expected), `got ${jd}, expected ${expected}`);
  });
});

// =========================================================================
// jdToDate — JD → 日付
// =========================================================================
describe('jdToDate — 基本動作', () => {
  it('2451545.0 → 2000-01-01 12:00:00 UTC', () => {
    const d = jdToDate(2451545.0);
    assert.strictEqual(d.year, 2000);
    assert.strictEqual(d.month, 1);
    assert.strictEqual(d.day, 1);
    assert.ok(close(d.hour + d.minute / 60 + d.second / 3600, 12.0, 1e-6));
  });

  it('2461127.0 → 2026-03-27 12:00:00', () => {
    const d = jdToDate(2461127.0);
    assert.strictEqual(d.year, 2026);
    assert.strictEqual(d.month, 3);
    assert.strictEqual(d.day, 27);
    assert.strictEqual(d.hour, 12);
  });

  it('1571477.0 → -410-06-21 00:00:00 (BC 410年)', () => {
    const d = jdToDate(1571477.0);
    assert.strictEqual(d.year, -410);
    assert.strictEqual(d.month, 6);
    assert.strictEqual(d.day, 21);
  });

  it('グレゴリオ施行初日: JDN=2299161 の JD は 2299160.5', () => {
    const d = jdToDate(2299160.5);
    assert.strictEqual(d.year, 1582);
    assert.strictEqual(d.month, 10);
    assert.strictEqual(d.day, 15);
  });

  it('dateToJd → jdToDate の往復変換が一致する', () => {
    const jd = dateToJd(2025, 11, 10, 4, 1, 0);
    const d = jdToDate(jd);
    assert.strictEqual(d.year, 2025);
    assert.strictEqual(d.month, 11);
    assert.strictEqual(d.day, 10);
    assert.strictEqual(d.hour, 4);
    assert.strictEqual(d.minute, 1);
    assert.ok(close(d.second, 0, 1e-9));
  });
});

// =========================================================================
// 年号変換
// =========================================================================
describe('astroYearToHistorical / historicalYearToAstro', () => {
  it('Year 0 → BC 1', () => {
    const { absYear, era } = astroYearToHistorical(0);
    assert.strictEqual(absYear, 1);
    assert.strictEqual(era, 'BC');
  });

  it('Year -409 → BC 410', () => {
    const { absYear, era } = astroYearToHistorical(-409);
    assert.strictEqual(absYear, 410);
    assert.strictEqual(era, 'BC');
  });

  it('Year 2026 → AD 2026', () => {
    const { absYear, era } = astroYearToHistorical(2026);
    assert.strictEqual(absYear, 2026);
    assert.strictEqual(era, 'AD');
  });

  it('BC 1 → Year 0', () => {
    assert.strictEqual(historicalYearToAstro(1, 'BC'), 0);
  });

  it('BC 410 → Year -409', () => {
    assert.strictEqual(historicalYearToAstro(410, 'BC'), -409);
  });

  it('往復変換: astro → historical → astro', () => {
    for (const year of [-410, -1, 0, 1, 2026]) {
      const { absYear, era } = astroYearToHistorical(year);
      assert.strictEqual(historicalYearToAstro(absYear, era), year, `year=${year}`);
    }
  });
});

// =========================================================================
// deltaT — ΔT 計算
// =========================================================================
describe('deltaT — Espenak & Meeus 2006 + IERS 実測値（2017+）', () => {
  it('J2000.0 付近 (2000年): ΔT ≈ 63〜64 秒（多項式）', () => {
    const dt = deltaT(2000);
    assert.ok(dt > 60 && dt < 70, `ΔT(2000)=${dt}`);
  });

  it('現代 (2026年): ΔT ≈ 69.1〜69.4 秒（IERS 実測値、TT−UTC=69.184s）', () => {
    const dt = deltaT(2026);
    // 旧値(多項式): ~75.07s → 修正後: ~69.22s
    assert.ok(dt > 68.5 && dt < 70.0, `ΔT(2026)=${dt.toFixed(3)}s`);
  });

  it('2024年: ΔT ≈ 68.97 秒（IERS 実測値）', () => {
    const dt = deltaT(2024);
    assert.ok(close(dt, 68.97, 0.5), `ΔT(2024)=${dt.toFixed(3)}s`);
  });

  it('2020年: ΔT ≈ 69.36 秒（IERS 実測値）', () => {
    const dt = deltaT(2020);
    assert.ok(close(dt, 69.36, 0.5), `ΔT(2020)=${dt.toFixed(3)}s`);
  });

  it('2026年は旧多項式（75.07s）より 5 秒以上小さい', () => {
    const dt = deltaT(2026);
    assert.ok(dt < 72.0, `ΔT(2026)=${dt.toFixed(3)}s（修正前は ~75.07s）`);
  });

  it('1800年: ΔT ≈ 13〜14 秒（多項式）', () => {
    const dt = deltaT(1800);
    assert.ok(dt > 10 && dt < 20, `ΔT(1800)=${dt}`);
  });

  it('古代 (-500年): ΔT は数千秒以上（多項式）', () => {
    const dt = deltaT(-500);
    assert.ok(dt > 10000, `ΔT(-500)=${dt}`);
  });

  it('未来 (2100年): ΔT ≈ 70〜500 秒程度（外挿）', () => {
    const dt = deltaT(2100);
    assert.ok(dt > 50 && dt < 500, `ΔT(2100)=${dt}`);
  });

  it('2016→2017 の遷移: 両側で連続（差 < 5秒）', () => {
    const dt2016late = deltaT(2016.99);
    const dt2017early = deltaT(2017.01);
    assert.ok(Math.abs(dt2017early - dt2016late) < 5,
      `2016.99=${dt2016late.toFixed(2)}s, 2017.01=${dt2017early.toFixed(2)}s`);
  });
});

// =========================================================================
// 時刻系変換
// =========================================================================
describe('jdUtcToTt — UTC → TT', () => {
  it('TT は UTC より ΔT秒 だけ進んでいる', () => {
    const jdUtc = 2451545.0;
    const dt = deltaT(2000);
    const jdTt = jdUtcToTt(jdUtc);
    assert.ok(close(jdTt - jdUtc, dt / 86400, 1e-10), `差=${(jdTt-jdUtc)*86400}秒`);
  });
});

describe('jdTtToTdb — TT → TDB', () => {
  it('TDB と TT の差は ±0.002 秒以内', () => {
    const jdTt = 2451545.0;
    const jdTdb = jdTtToTdb(jdTt);
    const diffSec = Math.abs(jdTdb - jdTt) * 86400;
    assert.ok(diffSec < 0.002, `差=${diffSec}秒`);
  });
});

describe('jdUtcToTdb — UTC → TDB（パイプライン）', () => {
  it('TDB は UTC より ΔT 秒以上進んでいる', () => {
    const jdUtc = 2451545.0;
    const jdTdb = jdUtcToTdb(jdUtc);
    const diffSec = (jdTdb - jdUtc) * 86400;
    assert.ok(diffSec > 60, `差=${diffSec}秒`);
  });
});

// =========================================================================
// jstToJdUtc
// =========================================================================
describe('jstToJdUtc — JST → UTC', () => {
  it('JST 2025-11-10 04:01 → UTC 2025-11-09 19:01', () => {
    const jdUtc = jstToJdUtc(2025, 11, 10, 4, 1, 0);
    const d = jdToDate(jdUtc);
    assert.strictEqual(d.year, 2025);
    assert.strictEqual(d.month, 11);
    assert.strictEqual(d.day, 9);
    assert.strictEqual(d.hour, 19);
    assert.strictEqual(d.minute, 1);
  });
});

// =========================================================================
// localToJdUtc
// =========================================================================
describe('localToJdUtc — ローカル時刻 → UTC', () => {
  it('UTC+9 は JST と同じ結果', () => {
    const jdA = jstToJdUtc(2026, 3, 27, 12, 0, 0);
    const jdB = localToJdUtc(2026, 3, 27, 12, 0, 0, 9);
    assert.ok(close(jdA, jdB), `差=${Math.abs(jdA - jdB)}`);
  });

  it('UTC-5（EST）: ローカル 2026-03-27 12:00 → UTC 2026-03-27 17:00', () => {
    const jdUtc = localToJdUtc(2026, 3, 27, 12, 0, 0, -5);
    const d = jdToDate(jdUtc);
    assert.strictEqual(d.hour, 17);
  });
});

// =========================================================================
// jdToLocalSolarTime
// =========================================================================
describe('jdToLocalSolarTime — 地方太陽時', () => {
  it('バビロン（東経44.4°）: UTC + 約2時間58分', () => {
    const jdUt = dateToJd(1582, 10, 14, 0, 0, 0);  // UTC 0:00
    const lst = jdToLocalSolarTime(jdUt, 44.4);
    // offset = 44.4/15 ≈ 2.96h ≈ 2h57m36s
    assert.ok(close(lst.offsetHours, 44.4 / 15, 1e-10));
    assert.strictEqual(lst.hour, 2);
    assert.strictEqual(lst.minute, 57);
  });
});

// =========================================================================
// classifyEra
// =========================================================================
describe('classifyEra — 時代区分', () => {
  it('2026年 → modern', () => {
    assert.strictEqual(classifyEra(2026).era, ERA.MODERN);
  });
  it('1700年 → premodern', () => {
    assert.strictEqual(classifyEra(1700).era, ERA.PREMODERN);
  });
  it('1000年 → medieval', () => {
    assert.strictEqual(classifyEra(1000).era, ERA.MEDIEVAL);
  });
  it('-410年 → ancient', () => {
    assert.strictEqual(classifyEra(-410).era, ERA.ANCIENT);
  });
  it('timezoneValid は modern のみ true', () => {
    assert.strictEqual(classifyEra(2026).timezoneValid, true);
    assert.strictEqual(classifyEra(1700).timezoneValid, false);
  });
});

// =========================================================================
// TDBDatetime クラス
// =========================================================================
describe('TDBDatetime', () => {
  it('fromUtc で生成: TDB が UTC より大きい', () => {
    const dt = TDBDatetime.fromUtc(2025, 11, 9, 19, 1, 0);
    assert.ok(dt.tdb > dt.utc, `tdb=${dt.tdb}, utc=${dt.utc}`);
  });

  it('fromJst で生成: UTC が JST より9時間遅い', () => {
    const dt = TDBDatetime.fromJst(2025, 11, 10, 4, 1, 0);
    const utc = dt.toUtc();
    assert.strictEqual(utc.hour, 19);
    assert.strictEqual(utc.minute, 1);
  });

  it('fromJst: era は modern', () => {
    const dt = TDBDatetime.fromJst(2026, 3, 27, 12, 0, 0);
    assert.strictEqual(dt.era, ERA.MODERN);
  });

  it('fromUtc: BC 410年の era は ancient', () => {
    const dt = TDBDatetime.fromUtc(-410, 6, 21, 12, 0, 0);
    assert.strictEqual(dt.era, ERA.ANCIENT);
  });

  it('fromLocal と fromJst は UTC+9 で一致する', () => {
    const a = TDBDatetime.fromJst(2026, 3, 27, 12, 0, 0);
    const b = TDBDatetime.fromLocal(2026, 3, 27, 12, 0, 0, 9);
    assert.ok(close(a.tdb, b.tdb), `差=${Math.abs(a.tdb - b.tdb)}`);
  });

  it('fromJdUtc: 往復変換が一致', () => {
    const jdUtc = dateToJd(2026, 3, 27, 12, 0, 0);
    const dt = TDBDatetime.fromJdUtc(jdUtc);
    assert.ok(close(dt.utc, jdUtc));
  });

  it('tt は utc より ΔT秒 だけ大きい', () => {
    const dt = TDBDatetime.fromUtc(2026, 3, 27, 12, 0, 0);
    const diffSec = (dt.tt - dt.utc) * 86400;
    assert.ok(diffSec > 60 && diffSec < 100, `ΔT=${diffSec}秒`);
  });
});

// GREGORIAN_CUTOVER_JDN をインポートしてテストで使う
import { GREGORIAN_CUTOVER_JDN } from '../../src/core/constants.js';
