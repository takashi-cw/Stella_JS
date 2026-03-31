/**
 * renderer.js — ホロスコープチャート SVG 生成モジュール
 *
 * Layer 3: chart（DOM 非依存・純粋関数群）
 *
 * 入力: 惑星黄経配列・ハウスカスプ配列・アスペクト配列（数値）
 * 出力: SVG 文字列（ブラウザ・Node.js どちらでもそのまま使用可）
 *
 * 設計方針:
 *   - DOM には一切触らない（document.createElement 等は使わない）
 *   - SVG はテンプレート文字列で構築
 *   - 座標変換関数（黄経→ SVG xy）は純粋関数として独立
 *
 * ライセンス: MIT
 */

'use strict';

// =========================================================================
// デフォルト設定
// =========================================================================

/** デフォルトのチャート描画設定 */
export const DEFAULT_OPTIONS = Object.freeze({
  size:            600,    // SVG の縦横サイズ（px）
  bgColor:         '#0a0a1a',
  zodiacRingOuter: 0.92,   // 黄道帯外周（半径比）
  zodiacRingInner: 0.72,   // 黄道帯内周（半径比）
  houseRingRadius: 0.68,   // ハウスカスプ線の終端（半径比）
  planetRingRadius:0.60,   // 惑星記号配置（半径比）
  aspectRingRadius:0.55,   // アスペクト線の端点（半径比）
  zodiacColors: [
    '#c0392b', '#8e44ad', '#2980b9',  // 牡羊・牡牛・双子
    '#27ae60', '#f39c12', '#2ecc71',  // 蟹・獅子・乙女
    '#e74c3c', '#9b59b6', '#3498db',  // 天秤・蠍・射手
    '#1abc9c', '#f1c40f', '#e67e22',  // 山羊・水瓶・魚
  ],
  zodiacSymbols: ['♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓'],
  planetSymbols: {
    Sun:     '☉', Moon:    '☽', Mercury: '☿',
    Venus:   '♀', Mars:    '♂', Jupiter: '♃',
    Saturn:  '♄', Uranus:  '⛢', Neptune: '♆',
    Pluto:   '♇', Chiron:  '⚷',
    'North Node': '☊', 'South Node': '☋',
  },
  aspectColors: {
    0:   '#ffdd57',   // 合: 黄
    60:  '#4fc3f7',   // セクスタイル: 水色
    90:  '#ef5350',   // スクエア: 赤
    120: '#66bb6a',   // トライン: 緑
    180: '#ab47bc',   // オポジション: 紫
  },
  fontFamily: 'serif',
});

// =========================================================================
// 座標変換ユーティリティ
// =========================================================================

/**
 * ホロスコープの黄経を SVG の (x, y) 座標に変換する（純粋関数）
 *
 * ホロスコープは左側（lon=0°）が 9 時方向から始まり、
 * 反時計回りで黄経が増加する。ASC は通常チャートの右側（3時方向）。
 *
 * 慣例: ascLon を右 (3 時方向) に来るよう全体を回転する。
 *   SVG 角度 = -(lon - ascLon) + 180  →  右が ASC、反時計回り
 *
 * @param {number} lon     黄経（度）
 * @param {number} radius  SVG 半径（px）
 * @param {number} cx      SVG 中心 x（px）
 * @param {number} cy      SVG 中心 y（px）
 * @param {number} ascLon  ASC の黄経（度）—チャートの右端に配置
 * @returns {{ x: number, y: number }}
 */
export function lonToXY(lon, radius, cx, cy, ascLon) {
  const angleDeg = -(lon - ascLon) + 180;
  const angleRad = angleDeg * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

/**
 * ホロスコープデータを SVG 描画用の中間データに変換する（純粋関数）
 *
 * @param {{
 *   planets: Array<{ id: string, lon: number }>,
 *   cusps:   number[],  // ハウス1〜12 のカスプ黄経配列（12要素）
 *   aspects: Array<{ planet1: string, planet2: string, type: number, orb: number }>,
 * }} chartData
 * @param {Partial<DEFAULT_OPTIONS>} [opts]
 * @returns {{
 *   size:    number,
 *   cx:      number,
 *   cy:      number,
 *   ascLon:  number,
 *   planets: Array<{ id: string, lon: number, x: number, y: number, symbol: string }>,
 *   cusps:   Array<{ cusp: number, lon: number, x1: number, y1: number, x2: number, y2: number }>,
 *   zodiac:  Array<{ index: number, startLon: number, midLon: number, mx: number, my: number }>,
 *   aspects: Array<{ type: number, x1: number, y1: number, x2: number, y2: number, color: string }>,
 * }}
 */
export function buildChartData(chartData, opts = {}) {
  const o   = { ...DEFAULT_OPTIONS, ...opts };
  const sz  = o.size;
  const cx  = sz / 2;
  const cy  = sz / 2;
  const r   = sz / 2;

  const ascLon = chartData.cusps?.[0] ?? 0;

  // 惑星座標
  const planetRadius = r * o.planetRingRadius;
  const planets = (chartData.planets ?? []).map(p => {
    const { x, y } = lonToXY(p.lon, planetRadius, cx, cy, ascLon);
    return {
      id: p.id,
      lon: p.lon,
      x, y,
      symbol: o.planetSymbols[p.id] ?? '?',
    };
  });

  // ハウスカスプ線
  const innerR = r * o.houseRingRadius;
  const outerR = r * o.zodiacRingInner;
  const cusps = (chartData.cusps ?? []).map((lon, i) => {
    const p1 = lonToXY(lon, innerR, cx, cy, ascLon);
    const p2 = lonToXY(lon, outerR, cx, cy, ascLon);
    return { cusp: i + 1, lon, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  });

  // 黄道帯サイン
  const zodiacMidR = r * (o.zodiacRingOuter + o.zodiacRingInner) / 2;
  const zodiac = Array.from({ length: 12 }, (_, i) => {
    const startLon = i * 30;
    const midLon   = startLon + 15;
    const { x, y } = lonToXY(midLon, zodiacMidR, cx, cy, ascLon);
    return { index: i, startLon, midLon, mx: x, my: y };
  });

  // アスペクト線（intra-chart）
  const aspectR = r * o.aspectRingRadius;
  const planetMap = Object.fromEntries(planets.map(p => [p.id, p]));
  const aspects = (chartData.aspects ?? []).map(asp => {
    const p1 = planetMap[asp.planet1];
    const p2 = planetMap[asp.planet2];
    if (!p1 || !p2) return null;
    const a1 = lonToXY(p1.lon, aspectR, cx, cy, ascLon);
    const a2 = lonToXY(p2.lon, aspectR, cx, cy, ascLon);
    return {
      type:  asp.type,
      x1: a1.x, y1: a1.y,
      x2: a2.x, y2: a2.y,
      color: o.aspectColors[asp.type] ?? '#888888',
    };
  }).filter(Boolean);

  return { size: sz, cx, cy, ascLon, planets, cusps, zodiac, aspects };
}

// =========================================================================
// SVG 生成
// =========================================================================

/** SVG の特殊文字をエスケープする */
function escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * buildChartData() の出力から SVG 文字列を生成する（純粋関数）
 *
 * @param {ReturnType<buildChartData>} data
 * @param {Partial<DEFAULT_OPTIONS>} [opts]
 * @returns {string} SVG 文字列
 */
export function renderSVG(data, opts = {}) {
  const o  = { ...DEFAULT_OPTIONS, ...opts };
  const { size: sz, cx, cy } = data;
  const r  = sz / 2;

  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}">`);

  // 背景
  lines.push(`<rect width="${sz}" height="${sz}" fill="${escXml(o.bgColor)}"/>`);

  // ── 黄道帯リング ─────────────────────────────────────
  const zOuter = r * o.zodiacRingOuter;
  const zInner = r * o.zodiacRingInner;

  for (let i = 0; i < 12; i++) {
    const startLon = i * 30;
    const endLon   = startLon + 30;
    const p1 = lonToXY(startLon, zOuter, cx, cy, data.ascLon);
    const p2 = lonToXY(endLon,   zOuter, cx, cy, data.ascLon);
    const p3 = lonToXY(endLon,   zInner, cx, cy, data.ascLon);
    const p4 = lonToXY(startLon, zInner, cx, cy, data.ascLon);
    const color = o.zodiacColors[i] ?? '#444';

    lines.push(
      `<path d="M${p1.x.toFixed(2)},${p1.y.toFixed(2)} ` +
      `A${zOuter.toFixed(2)},${zOuter.toFixed(2)} 0 0,0 ${p2.x.toFixed(2)},${p2.y.toFixed(2)} ` +
      `L${p3.x.toFixed(2)},${p3.y.toFixed(2)} ` +
      `A${zInner.toFixed(2)},${zInner.toFixed(2)} 0 0,1 ${p4.x.toFixed(2)},${p4.y.toFixed(2)} Z" ` +
      `fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="0.5"/>`
    );

    // サイン記号
    const { mx, my } = data.zodiac[i];
    const sym = escXml(o.zodiacSymbols[i] ?? '?');
    lines.push(
      `<text x="${mx.toFixed(2)}" y="${my.toFixed(2)}" ` +
      `text-anchor="middle" dominant-baseline="central" ` +
      `font-family="${escXml(o.fontFamily)}" font-size="14" fill="${color}">${sym}</text>`
    );
  }

  // ── ハウスカスプ線 ────────────────────────────────────
  for (const c of data.cusps) {
    const strokeW = (c.cusp === 1 || c.cusp === 4 || c.cusp === 7 || c.cusp === 10) ? 1.5 : 0.5;
    const color   = (c.cusp === 1 || c.cusp === 7) ? '#ffdd57' :
                    (c.cusp === 4 || c.cusp === 10) ? '#aaaaff' : '#666688';
    lines.push(
      `<line x1="${c.x1.toFixed(2)}" y1="${c.y1.toFixed(2)}" ` +
      `x2="${c.x2.toFixed(2)}" y2="${c.y2.toFixed(2)}" ` +
      `stroke="${color}" stroke-width="${strokeW}" stroke-opacity="0.8"/>`
    );

    // ハウス番号
    const midR = r * (o.houseRingRadius + o.aspectRingRadius) / 2;
    const m    = lonToXY(c.lon + 15, midR, cx, cy, data.ascLon);
    lines.push(
      `<text x="${m.x.toFixed(2)}" y="${m.y.toFixed(2)}" ` +
      `text-anchor="middle" dominant-baseline="central" ` +
      `font-family="${escXml(o.fontFamily)}" font-size="10" fill="#aaaacc">${c.cusp}</text>`
    );
  }

  // ── アスペクト線 ──────────────────────────────────────
  for (const asp of data.aspects) {
    lines.push(
      `<line x1="${asp.x1.toFixed(2)}" y1="${asp.y1.toFixed(2)}" ` +
      `x2="${asp.x2.toFixed(2)}" y2="${asp.y2.toFixed(2)}" ` +
      `stroke="${escXml(asp.color)}" stroke-width="0.7" stroke-opacity="0.6"/>`
    );
  }

  // ── 同心円（ハウスリング・アスペクトリング） ──────────
  const hR = r * o.houseRingRadius;
  const aR = r * o.aspectRingRadius;
  lines.push(`<circle cx="${cx}" cy="${cy}" r="${zOuter.toFixed(2)}" fill="none" stroke="#334" stroke-width="1"/>`);
  lines.push(`<circle cx="${cx}" cy="${cy}" r="${zInner.toFixed(2)}" fill="none" stroke="#334" stroke-width="0.5"/>`);
  lines.push(`<circle cx="${cx}" cy="${cy}" r="${hR.toFixed(2)}" fill="none" stroke="#223" stroke-width="0.5"/>`);
  lines.push(`<circle cx="${cx}" cy="${cy}" r="${aR.toFixed(2)}" fill="none" stroke="#112" stroke-width="0.3"/>`);

  // ── 惑星記号 ─────────────────────────────────────────
  for (const p of data.planets) {
    const sym = escXml(p.symbol);
    lines.push(
      `<text x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}" ` +
      `text-anchor="middle" dominant-baseline="central" ` +
      `font-family="${escXml(o.fontFamily)}" font-size="16" fill="#ffffff">${sym}</text>`
    );
  }

  lines.push('</svg>');
  return lines.join('\n');
}

/**
 * チャートデータから SVG 文字列を一括生成する（convenience wrapper）
 *
 * @param {{
 *   planets: Array<{ id: string, lon: number }>,
 *   cusps:   number[],
 *   aspects: Array<{ planet1: string, planet2: string, type: number }>,
 * }} chartData
 * @param {Partial<DEFAULT_OPTIONS>} [opts]
 * @returns {string} SVG 文字列
 */
export function renderHoroscopeSVG(chartData, opts = {}) {
  const data = buildChartData(chartData, opts);
  return renderSVG(data, opts);
}
