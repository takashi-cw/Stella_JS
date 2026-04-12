/**
 * precession.test.js — precession.js の単体テスト
 *
 * 実行: node --test test/astro/precession.test.js
 *
 * 基準値:
 *   - obliquity J2000.0 = 84381.406 / 3600 = 23.43927944°（IAU 2006）
 *   - IAU 1976 多項式 p_A(T=1) = 5029.0966 + 1.0939 − 0.0028 = 5030.1877" = 1.397274°
 *   - Lahiri ayanamsha 2026 ≈ 24.21°（多項式モデル）
 *   - recommendZodiac(2025, 'western') → tropical
 *   - recommendZodiac(-500, 'mesopotamia') → sidereal (fagan_bradley)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  obliquity,
  calculatePrecession,
  calculateAyanamsha,
  recommendZodiac,
  warnZodiacMismatch,
  _lieskePrecessionArcsec,
  PRECESSION_RATE,
} from '../../public/src/astro/precession.js';

const J2000_JD = 2451545.0;

const EPS4 = 1e-4;  // 0.36 arcsec — 黄道傾斜角の精度
const EPS3 = 1e-3;  // ΔアヤナムシャはO(0.001°)以内

const close = (a, b, eps) => Math.abs(a - b) < eps;

// =========================================================================
// obliquity — IAU 2006 黄道傾斜角
// =========================================================================
describe('obliquity — IAU 2006 黄道傾斜角', () => {
  it('J2000.0 (T=0): 84381.406 arcsec → 23.43927944°', () => {
    const eps = obliquity(J2000_JD);
    assert.ok(
      close(eps, 23.43927944, EPS4),
      `期待 ≈ 23.43927944, 実際 = ${eps}`
    );
  });

  it('T > 0 では T=0 より小さくなる（歳差による傾斜角の減少）', () => {
    const eps0 = obliquity(J2000_JD);
    const eps1 = obliquity(J2000_JD + 36525);  // J2100.0
    assert.ok(eps1 < eps0, `T=1 の傾斜角 ${eps1}° が T=0 の ${eps0}° 以上になっています`);
  });

  it('返り値の範囲: 20° < ε < 25°（100 年以内）', () => {
    for (const offset of [-36525, 0, 36525]) {
      const eps = obliquity(J2000_JD + offset);
      assert.ok(eps > 20 && eps < 25, `obliquity(${offset}d) = ${eps}°`);
    }
  });
});

// =========================================================================
// _lieskePrecessionArcsec — IAU 1976 多項式プライベート関数
// =========================================================================
describe('_lieskePrecessionArcsec — IAU 1976 多項式', () => {
  it('T=0（J2000.0）: 累積歳差 = 0 arcsec', () => {
    assert.strictEqual(_lieskePrecessionArcsec(0), 0);
  });

  it('T=1（2100年）: p_A = 5029.0966 + 1.0939 − 0.0028 = 5030.1877"', () => {
    const expected = 5029.0966 + 1.0939 - 0.0028;
    const actual   = _lieskePrecessionArcsec(1.0);
    assert.ok(close(actual, expected, 1e-6), `got ${actual}`);
  });

  it('T > 0 → 正値（未来は春分点が西に移動）', () => {
    assert.ok(_lieskePrecessionArcsec(1.0) > 0);
  });

  it('T < 0 → 負値（過去は春分点が東に戻る）', () => {
    assert.ok(_lieskePrecessionArcsec(-1.0) < 0);
  });

  it('T=−20（0年）: 係数代入値と一致', () => {
    const expected = 5029.0966 * (-20) + 1.0939 * 400 + (-0.0028) * (-8000);
    assert.ok(close(_lieskePrecessionArcsec(-20), expected, 1e-4));
  });

  it('同じ引数で100回呼んで常に同じ結果（純粋関数）', () => {
    const ref = _lieskePrecessionArcsec(-15.0);
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(_lieskePrecessionArcsec(-15.0), ref);
    }
  });
});

// =========================================================================
// calculatePrecession — 一般歳差（IAU 1976 多項式モデル）
// =========================================================================
describe('calculatePrecession — 一般歳差（IAU 1976 多項式）', () => {
  it('2000→2000: 0°', () => {
    assert.strictEqual(calculatePrecession(2000, 2000), 0);
  });

  it('2000→2025: 多項式値 ≈ 0.3493°（線形 0.3490° と近いが別値）', () => {
    const p = calculatePrecession(2000, 2025);
    // 多項式: T=0.25 → (5029.0966×0.25 + 1.0939×0.0625 − 0.0028×0.0156)/3600 ≈ 0.34926°
    assert.ok(close(p, 0.34926, EPS3), `got ${p}`);
  });

  it('2025→2000: 負の移動量（過去方向）', () => {
    const p = calculatePrecession(2025, 2000);
    assert.ok(p < 0, `正の値が返りました: ${p}`);
  });

  it('2000→2100: 多項式値 ≈ 1.3973°（T=1 の p_A = 5030.1877" / 3600）', () => {
    const expected = (5029.0966 + 1.0939 - 0.0028) / 3600.0;  // ≈ 1.397274°
    const p = calculatePrecession(2000, 2100);
    assert.ok(close(p, expected, EPS4), `got ${p}, expected ${expected}`);
  });

  it('往復対称性: p(a→b) = −p(b→a)', () => {
    const fwd = calculatePrecession(1000, 2000);
    const bwd = calculatePrecession(2000, 1000);
    assert.ok(close(fwd + bwd, 0, 1e-10), `fwd+bwd = ${fwd + bwd}`);
  });

  it('未来（2500年）は正値', () => {
    assert.ok(calculatePrecession(2000, 2500) > 0);
  });

  it('古代（BC 1000年）は負値', () => {
    assert.ok(calculatePrecession(2000, -999) < 0);
  });

  it('BC 1000年スパン: 線形近似より > 0.05° 小さい（誤差の有意性）', () => {
    const poly   = calculatePrecession(2000, -999);
    const linear = (-999 - 2000) * PRECESSION_RATE;
    assert.ok(Math.abs(poly - linear) > 0.05,
      `差が小さすぎる: poly=${poly}, linear=${linear}`);
  });

  it('同じ引数で100回呼んで常に同じ結果（純粋関数）', () => {
    const ref = calculatePrecession(2000, -500);
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(calculatePrecession(2000, -500), ref);
    }
  });
});

// =========================================================================
// calculateAyanamsha — アヤナムシャ
// =========================================================================
describe('calculateAyanamsha — Lahiri', () => {
  it('year=2000: offsetDeg ≈ 23.85°（J2000 基準値）', () => {
    const a = calculateAyanamsha('lahiri', 2000);
    assert.ok(close(a.offsetDeg, 23.85, EPS3), `got ${a.offsetDeg}`);
  });

  it('year=2026: offsetDeg は 23〜25° の範囲内', () => {
    const a = calculateAyanamsha('lahiri', 2026);
    assert.ok(a.offsetDeg > 23.0 && a.offsetDeg < 25.0, `got ${a.offsetDeg}`);
  });

  it('year=285（Lahiri ゼロ点）: offsetDeg が ±1.5° 以内', () => {
    const a = calculateAyanamsha('lahiri', 285);
    assert.ok(Math.abs(a.offsetDeg) < 1.5,
      `Lahiri ゼロ点 285 AD = ${a.offsetDeg}° (> ±1.5°)`);
  });

  it('過去（BC 300年）は現代より小さい（単調性）', () => {
    const ancient = calculateAyanamsha('lahiri', -299);
    const modern  = calculateAyanamsha('lahiri', 2026);
    assert.ok(ancient.offsetDeg < modern.offsetDeg,
      `BC300=${ancient.offsetDeg} >= 2026=${modern.offsetDeg}`);
  });

  it('type フィールドが "lahiri"', () => {
    assert.strictEqual(calculateAyanamsha('lahiri', 2000).type, 'lahiri');
  });
});

describe('calculateAyanamsha — Fagan-Bradley', () => {
  it('year=2000: offsetDeg ≈ 24.042044°', () => {
    const a = calculateAyanamsha('fagan_bradley', 2000);
    assert.ok(close(a.offsetDeg, 24.042044, EPS4), `got ${a.offsetDeg}`);
  });
});

describe('calculateAyanamsha — Raman は Lahiri − 0.2°', () => {
  it('year=2025', () => {
    const lah = calculateAyanamsha('lahiri', 2025);
    const ram = calculateAyanamsha('raman', 2025);
    assert.ok(
      close(lah.offsetDeg - ram.offsetDeg, 0.2, EPS4),
      `差 = ${lah.offsetDeg - ram.offsetDeg}`
    );
  });
});

describe('calculateAyanamsha — Custom', () => {
  it('customOffset=10.5° がそのまま返る', () => {
    const a = calculateAyanamsha('custom', 2000, 10.5);
    assert.strictEqual(a.type, 'custom');
    assert.strictEqual(a.offsetDeg, 10.5);
  });
});

describe('calculateAyanamsha — 未知の type は lahiri にフォールバック', () => {
  it('type="unknown" → lahiri と同じ値', () => {
    const unk = calculateAyanamsha('unknown', 2025);
    const lah = calculateAyanamsha('lahiri', 2025);
    assert.ok(close(unk.offsetDeg, lah.offsetDeg, EPS4));
  });
});

// =========================================================================
// recommendZodiac — 黄道帯推奨
// =========================================================================
describe('recommendZodiac — 西洋近代（AD 2025）', () => {
  it('tropical を推奨', () => {
    const r = recommendZodiac(2025, 'western');
    assert.strictEqual(r.zodiac, 'tropical');
    assert.strictEqual(r.ayanamsha, null);
  });

  it('confidence が "high"', () => {
    assert.strictEqual(recommendZodiac(2025, 'western').confidence, 'high');
  });
});

describe('recommendZodiac — バビロニア（BC 500）', () => {
  it('sidereal + fagan_bradley を推奨', () => {
    const r = recommendZodiac(-500, 'mesopotamia');
    assert.strictEqual(r.zodiac, 'sidereal');
    assert.strictEqual(r.ayanamsha, 'fagan_bradley');
  });
});

describe('recommendZodiac — インド（任意年）', () => {
  it('sidereal + lahiri を推奨', () => {
    const r = recommendZodiac(2025, 'indian');
    assert.strictEqual(r.zodiac, 'sidereal');
    assert.strictEqual(r.ayanamsha, 'lahiri');
  });
});

describe('recommendZodiac — 地理推定（南アジア）', () => {
  it('lat=20, lon=80 → indian → sidereal', () => {
    const r = recommendZodiac(2000, null, 80, 20);
    assert.strictEqual(r.zodiac, 'sidereal');
    assert.strictEqual(r.culture, 'indian');
  });
});

describe('recommendZodiac — 該当なし', () => {
  it('culture="western", year=-9999 → tropical（デフォルト）', () => {
    const r = recommendZodiac(-9999, 'western');
    assert.strictEqual(r.zodiac, 'tropical');
    assert.strictEqual(r.confidence, 'low');
  });
});

// =========================================================================
// warnZodiacMismatch
// =========================================================================
describe('warnZodiacMismatch', () => {
  it('一致するとき warningIssued=false', () => {
    const r = warnZodiacMismatch(2025, 'western', 'tropical');
    assert.strictEqual(r.warningIssued, false);
  });

  it('不一致のとき warningIssued=true', () => {
    const r = warnZodiacMismatch(2025, 'western', 'sidereal');
    assert.strictEqual(r.warningIssued, true);
  });

  it('disputed のとき warningIssued=false', () => {
    const r = warnZodiacMismatch(100, 'hellenistic', 'tropical');
    assert.strictEqual(r.warningIssued, false);
  });
});
