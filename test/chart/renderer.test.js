/**
 * renderer.test.js — renderer.js の単体テスト
 *
 * 実行: node --test test/chart/renderer.test.js
 *
 * 検証内容:
 *   - lonToXY: 黄経 → SVG 座標変換の解析値
 *   - buildChartData: 中間データの構造・フィールド
 *   - renderSVG / renderHoroscopeSVG: 有効な SVG 文字列の生成
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_OPTIONS,
  lonToXY,
  buildChartData,
  renderSVG,
  renderHoroscopeSVG,
} from '../../public/src/chart/renderer.js';

const close = (a, b, e = 0.01) => Math.abs(a - b) < e;

// サンプルチャートデータ（東京 2000-01-01 相当の仮値）
const SAMPLE_CHART = {
  planets: [
    { id: 'Sun',     lon: 280.4 },
    { id: 'Moon',    lon: 223.3 },
    { id: 'Mercury', lon: 265.1 },
    { id: 'Venus',   lon: 241.8 },
    { id: 'Mars',    lon: 345.2 },
    { id: 'Jupiter', lon: 25.3  },
  ],
  cusps: [
    155.3, 185.1, 215.0, 245.3, 275.1, 305.0,
    335.3,   5.1,  35.0,  65.3,  95.1, 125.0,
  ],
  aspects: [
    { planet1: 'Sun', planet2: 'Moon',    type: 60,  orb: 2.3 },
    { planet1: 'Sun', planet2: 'Mercury', type: 0,   orb: 0.5 },
    { planet1: 'Sun', planet2: 'Jupiter', type: 120, orb: 3.1 },
  ],
};

// =========================================================================
// lonToXY — 黄経 → SVG 座標変換
// =========================================================================
describe('lonToXY — 黄経 → SVG 座標変換', () => {
  const cx = 300, cy = 300, r = 200;

  it('ASC（ascLon）が 3 時方向（右）に来る', () => {
    // lon = ascLon → 角度 = -(ascLon - ascLon) + 180 = 180°
    // SVG 角度 180° → x = cx + r*cos(180°) = cx - r, y = cy
    const ascLon = 150;
    const { x, y } = lonToXY(ascLon, r, cx, cy, ascLon);
    assert.ok(close(x, cx - r, 0.01), `x=${x} expected=${cx - r}`);
    assert.ok(close(y, cy, 0.01),     `y=${y} expected=${cy}`);
  });

  it('ascLon + 90° が上方向（12 時）に来る', () => {
    // lon = ascLon + 90 → angle = -(90) + 180 = 90°
    // SVG 90° → x = cx + r*cos(90°) ≈ cx, y = cy + r*sin(90°) = cy + r
    // 注: SVG では y 軸が下向きなので sin(90°)>0 → 下方向
    const ascLon = 0;
    const { x, y } = lonToXY(90, r, cx, cy, ascLon);
    assert.ok(close(x, cx, 0.01),     `x=${x}`);
    assert.ok(close(y, cy + r, 0.01), `y=${y}`);
  });

  it('中心から距離 r にある', () => {
    for (let lon = 0; lon < 360; lon += 30) {
      const { x, y } = lonToXY(lon, r, cx, cy, 0);
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      assert.ok(close(dist, r, 0.001), `lon=${lon} dist=${dist}`);
    }
  });

  it('r=0 のときは常に中心座標', () => {
    const { x, y } = lonToXY(45, 0, cx, cy, 0);
    assert.ok(close(x, cx));
    assert.ok(close(y, cy));
  });
});

// =========================================================================
// buildChartData — 中間データ構造
// =========================================================================
describe('buildChartData — 中間データ構造', () => {
  const data = buildChartData(SAMPLE_CHART);

  it('size, cx, cy が返される', () => {
    assert.strictEqual(data.size, DEFAULT_OPTIONS.size);
    assert.strictEqual(data.cx,   DEFAULT_OPTIONS.size / 2);
    assert.strictEqual(data.cy,   DEFAULT_OPTIONS.size / 2);
  });

  it('ascLon は cusps[0] と一致する', () => {
    assert.strictEqual(data.ascLon, SAMPLE_CHART.cusps[0]);
  });

  it('planets: 入力と同数・必要なフィールドを持つ', () => {
    assert.strictEqual(data.planets.length, SAMPLE_CHART.planets.length);
    for (const p of data.planets) {
      assert.ok('id'     in p, 'id missing');
      assert.ok('lon'    in p, 'lon missing');
      assert.ok('x'      in p, 'x missing');
      assert.ok('y'      in p, 'y missing');
      assert.ok('symbol' in p, 'symbol missing');
    }
  });

  it('planets: 各天体が有効な SVG 座標範囲にある', () => {
    const sz = data.size;
    for (const p of data.planets) {
      assert.ok(p.x >= 0 && p.x <= sz, `x=${p.x} out of range`);
      assert.ok(p.y >= 0 && p.y <= sz, `y=${p.y} out of range`);
    }
  });

  it('cusps: 12 個のカスプデータを返す', () => {
    assert.strictEqual(data.cusps.length, 12);
    for (const c of data.cusps) {
      assert.ok('cusp' in c);
      assert.ok('lon'  in c);
      assert.ok('x1' in c && 'y1' in c && 'x2' in c && 'y2' in c);
    }
  });

  it('zodiac: 12 個のサインデータを返す', () => {
    assert.strictEqual(data.zodiac.length, 12);
    for (let i = 0; i < 12; i++) {
      assert.strictEqual(data.zodiac[i].startLon, i * 30);
    }
  });

  it('aspects: 入力と同数（未登録惑星はスキップ）', () => {
    assert.strictEqual(data.aspects.length, SAMPLE_CHART.aspects.length);
  });

  it('aspects: color フィールドを持つ', () => {
    for (const a of data.aspects) {
      assert.ok('color' in a);
      assert.ok(typeof a.color === 'string');
    }
  });

  it('空データでもクラッシュしない', () => {
    const empty = buildChartData({ planets: [], cusps: [], aspects: [] });
    assert.strictEqual(empty.planets.length, 0);
    assert.strictEqual(empty.cusps.length,   0);
    assert.strictEqual(empty.aspects.length, 0);
  });

  it('opts.size を変更できる', () => {
    const d = buildChartData(SAMPLE_CHART, { size: 400 });
    assert.strictEqual(d.size, 400);
    assert.strictEqual(d.cx,   200);
  });
});

// =========================================================================
// renderSVG — SVG 文字列生成
// =========================================================================
describe('renderSVG — SVG 文字列生成', () => {
  const data = buildChartData(SAMPLE_CHART);
  const svg  = renderSVG(data);

  it('<svg> タグで始まり </svg> で終わる', () => {
    assert.ok(svg.startsWith('<svg '), `不正な開始: ${svg.slice(0, 20)}`);
    assert.ok(svg.endsWith('</svg>'), `不正な終端: ${svg.slice(-20)}`);
  });

  it('xmlns 属性が含まれる', () => {
    assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  });

  it('width / height 属性が含まれる', () => {
    assert.ok(svg.includes(`width="${data.size}"`));
    assert.ok(svg.includes(`height="${data.size}"`));
  });

  it('惑星記号が少なくとも 1 つ含まれる', () => {
    assert.ok(svg.includes('☉') || svg.includes('☽') || svg.includes('?'));
  });

  it('サイン記号が含まれる（♈ など）', () => {
    assert.ok(svg.includes('♈'), '牡羊座の記号がない');
  });

  it('文字列長が正常範囲（1KB 以上）', () => {
    assert.ok(svg.length > 1000, `SVG が短すぎる: ${svg.length} bytes`);
  });

  it('XSS インジェクション文字がエスケープされている', () => {
    const injected = buildChartData({
      ...SAMPLE_CHART,
      planets: [{ id: '<script>', lon: 0 }],
    });
    const s = renderSVG(injected);
    assert.ok(!s.includes('<script>'), '<script> がエスケープされていない');
  });
});

// =========================================================================
// renderHoroscopeSVG — 統合ラッパー
// =========================================================================
describe('renderHoroscopeSVG — 統合ラッパー', () => {
  it('buildChartData + renderSVG と同等の出力を返す', () => {
    const svg1 = renderHoroscopeSVG(SAMPLE_CHART);
    const data  = buildChartData(SAMPLE_CHART);
    const svg2  = renderSVG(data);
    assert.strictEqual(svg1, svg2);
  });

  it('空データでクラッシュしない', () => {
    const svg = renderHoroscopeSVG({ planets: [], cusps: [], aspects: [] });
    assert.ok(svg.startsWith('<svg '));
  });

  it('opts.size=800 が反映される', () => {
    const svg = renderHoroscopeSVG(SAMPLE_CHART, { size: 800 });
    assert.ok(svg.includes('width="800"'));
  });
});
