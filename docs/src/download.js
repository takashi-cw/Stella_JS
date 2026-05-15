/**
 * download.js — ファイルダウンロードユーティリティ
 *
 * 純粋関数（buildTxtContent）と副作用関数（downloadTxt / downloadCsv）を提供する。
 * app.js やその他モジュールからインポートして使用する。
 */

// ── CSV ダウンロードユーティリティ ──────────────────────────────────────

/**
 * 2次元配列を CSV ファイルとしてブラウザからダウンロードする
 * @param {string}     filename  ダウンロード時のファイル名
 * @param {string[][]} data      1行目をヘッダーとする 2次元文字列配列
 */
export function downloadCsv(filename, data) {
  const bom = '\ufeff';  // UTF-8 BOM（Excel / Numbers で文字化けしないように）
  const csv = data.map(row =>
    row.map(v => {
      const s = String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(',')
  ).join('\n');
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── .txt ダウンロードユーティリティ ──────────────────────────────────────

/**
 * 天体位置データを .txt 形式の文字列に変換する（純粋関数）
 *
 * @param {object[]} rows       データ行 { jst, planet, lon, speed, lat, dist }
 * @param {object}   meta       メタ情報
 * @param {string}   meta.ephemeris  天体暦名
 * @param {string}   meta.center     観測中心
 * @param {string}   meta.coordLabel 座標系ラベル（'of-date' | 'J2000.0'）
 * @param {string}   meta.step       ステップ
 * @param {string}   meta.period     期間文字列
 * @param {string}   meta.planets    対象天体（例: "全惑星" or "水星, 金星"）
 * @returns {string} .txt ファイルの中身
 */
export function buildTxtContent(rows, meta) {
  const lines = [];
  lines.push(`# 生成: りんご力学 / 時刻表記: JST (UTC+9)`);
  lines.push(`# 天体暦: ${meta.ephemeris}`);
  lines.push(`# 観測中心: ${meta.center}`);
  lines.push(`# 座標系: ${meta.coordLabel}`);
  lines.push(`# 光行差補正: ${meta.aberration}`);
  lines.push(`# 天体: ${meta.planets}`);
  lines.push(`# ステップ: ${meta.step}`);
  lines.push(`# 期間: ${meta.period}`);
  lines.push(`# ---`);
  lines.push(`# CC BY-NC-SA 4.0 https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ja`);
  lines.push(`# 開発者: オンラインカウンセリングルーム「しがたかしホッとライン」運営 志賀高史`);
  lines.push(`# https://www.shigatkashi.com`);
  lines.push('');
  lines.push(['JST日時', '天体', '黄経(deg)', '角速度(deg/day)', '黄緯(deg)', '距離(AU)'].join('\t'));
  for (const r of rows) {
    lines.push([
      r.jst,
      r.planet,
      r.lon.toFixed(6),
      (r.speed >= 0 ? '+' : '') + r.speed.toFixed(6),
      (r.lat >= 0 ? '+' : '') + r.lat.toFixed(6),
      r.dist.toFixed(6),
    ].join('\t'));
  }
  return lines.join('\n');
}

/**
 * テキスト文字列をブラウザから .txt ファイルとしてダウンロードさせる（副作用）
 * @param {string} filename  ダウンロード時のファイル名
 * @param {string} content   ファイルの中身
 */
export function downloadTxt(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
