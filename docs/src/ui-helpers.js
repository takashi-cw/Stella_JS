/**
 * ui-helpers.js — 共有 UI ヘルパー群
 *
 * 計算・表示・入力変換のユーティリティ関数をエクスポートする。
 * app.js および各 ui-*.js モジュールからインポートして使用する。
 *
 * ルール:
 *   - BSP ファイル（bspFile）に依存する関数は含めない → app.js の requireBsp / computeApparent を参照
 *   - DOM 副作用を持つ関数は「副作用」コメントを付ける
 */

import {
  dateToJd, jdToDate, jdUtcToTdb,
  normAngularDiff,
  detectStationPoint,
  NAIF, AVG_SPEEDS,
} from './index.js';

// ── 時刻変換 ────────────────────────────────────────────────────────────────

/**
 * JST の datetime-local 文字列（"YYYY-MM-DDTHH:MM"）を UTC JD に変換する
 */
export function jstInputToJdUtc(datetimeLocal) {
  const [datePart, timePart] = datetimeLocal.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = (timePart || '00:00').split(':').map(Number);
  const utcHour = hh - 9;  // JST = UTC+9 → UTC
  return dateToJd(y, m, d + utcHour / 24 + mm / 1440);
}

/**
 * JST の datetime-local 文字列 → JD TDB
 */
export function jstInputToJdTdb(datetimeLocal) {
  return jdUtcToTdb(jstInputToJdUtc(datetimeLocal));
}

/**
 * datetime-local 文字列（"YYYY-MM-DDTHH:MM"）を JD TDB に変換する
 * JST → UTC 変換（-9h）を含む
 */
export function datetimeLocalToJdTdb(datetimeStr) {
  const [datePart, timePart = '00:00'] = datetimeStr.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm]  = timePart.split(':').map(Number);
  const utcHour   = hh - 9; // JST → UTC
  return jdUtcToTdb(dateToJd(y, m, d + utcHour / 24 + mm / 1440));
}

/**
 * JD を JST 日時文字列（ミリ秒付き）に変換する
 *
 * @param {number} jd
 * @returns {string} "YYYY/MM/DD HH:MM:SS.mmm JST"
 */
export function jdToJstStr(jd) {
  const { year, month, day, hour, minute, second } = jdToDate(jd + 9 / 24);
  const s  = Math.floor(second);
  const ms = Math.round((second - s) * 1000);
  const p2 = n => String(n).padStart(2, '0');
  const p3 = n => String(n).padStart(3, '0');
  return `${year}/${p2(month)}/${p2(day)} ${p2(hour)}:${p2(minute)}:${p2(s)}.${p3(ms)} JST`;
}

/**
 * 日付文字列 "YYYY-MM-DD" → JST 0:00 の UTC JD
 */
export function dateStrToJdUtcMidJst(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return dateToJd(y, m, d - 9 / 24);
}

// ── 星座・角度ユーティリティ ────────────────────────────────────────────────

export const ZODIAC_SIGNS_JP = [
  '牡羊座','牡牛座','双子座','蟹座','獅子座','乙女座',
  '天秤座','蠍座','射手座','山羊座','水瓶座','魚座'
];

// IAU 黄道星座の黄経境界（J2000.0 近似値、昇順）
// lon は度を100倍した整数（センチ度）で保持し、浮動小数点比較の誤差を排除する。
// 出典: Delporte (1930) "Délimitation scientifique des constellations" IAU 星座境界を
//       J2000.0 黄道座標に射影した近似値。蛇遣座（Oph）を含む13星座。
export const IAU_ZODIAC_BOUNDS = Object.freeze([
  { lon:  2869, name: '牡羊座', abbr: 'Ari' },
  { lon:  5345, name: '牡牛座', abbr: 'Tau' },
  { lon:  9015, name: '双子座', abbr: 'Gem' },
  { lon: 11823, name: '蟹座',   abbr: 'Cnc' },
  { lon: 13817, name: '獅子座', abbr: 'Leo' },
  { lon: 17413, name: '乙女座', abbr: 'Vir' },
  { lon: 21783, name: '天秤座', abbr: 'Lib' },
  { lon: 24120, name: '蠍座',   abbr: 'Sco' },
  { lon: 24765, name: '蛇遣座', abbr: 'Oph' },
  { lon: 26555, name: '射手座', abbr: 'Sgr' },
  { lon: 29967, name: '山羊座', abbr: 'Cap' },
  { lon: 32752, name: '水瓶座', abbr: 'Aqr' },
  { lon: 35165, name: '魚座',   abbr: 'Psc' },
]);

/**
 * IAU 黄道星座名を返す（天文計算メニュー用）
 *
 * @param {number} lon 黄経（度, J2000.0 または of-date）
 * @returns {string} "星座名 (Abbr)"
 */
export function lonToIauConstellation(lon) {
  const n = Math.round(((lon % 360) + 360) % 360 * 100);
  let best = null;
  for (const b of IAU_ZODIAC_BOUNDS) {
    if (n >= b.lon) best = b;
  }
  if (!best) best = IAU_ZODIAC_BOUNDS[IAU_ZODIAC_BOUNDS.length - 1];
  return `${best.name} (${best.abbr})`;
}

/** 小数点以下3桁・切り捨て表示 */
export function trunc3(n) {
  return (Math.trunc(n * 1000) / 1000).toFixed(3);
}

/** 占星術用: 黄経（度）→ 星座名 + 残り度数（均等 30° 分割） */
export function lonToSign(lon) {
  const idx = Math.floor(lon / 30);
  const degInSign = Math.trunc((lon - idx * 30) * 1000) / 1000;
  return `${ZODIAC_SIGNS_JP[idx]} ${degInSign.toFixed(3)}°`;
}

/** 方位角 → 8方位文字列 */
export function azDir(az) {
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(az / 45) % 8];
}

// ── UI 表示ヘルパー（副作用）──────────────────────────────────────────────

/** 結果エリアに表示（副作用） */
export function showResult(elId, html, isError = false) {
  const el = document.getElementById(elId);
  el.innerHTML = html;
  el.className = 'result-area visible' + (isError ? ' error' : '');
}

/**
 * 進捗バーつきのローディング表示を result-area に描画する（副作用）
 * @param {string} elId      result-area の要素 ID
 * @param {string} [label]   主メッセージ（省略時: "計算中…"）
 * @param {string} [sub]     サブメッセージ（省略時: なし）
 */
export function showLoading(elId, label = '計算中…', sub = '') {
  const el = document.getElementById(elId);
  el.className = 'result-area visible';
  el.innerHTML = `
    <div class="loading-wrap">
      <div class="loading-bar-track"><div class="loading-bar-fill"></div></div>
      <p class="loading-label">${label}</p>
      ${sub ? `<p class="loading-sub">${sub}</p>` : ''}
    </div>`;
}

/**
 * 確定した進捗 % をプログレスバーに反映する（副作用）
 * showLoading で表示済みの要素に対して呼ぶ
 */
export function setProgress(elId, pct, sub = '') {
  const el = document.getElementById(elId);
  if (!el) return;
  const fill    = el.querySelector('.loading-bar-fill');
  const labelEl = el.querySelector('.loading-label');
  const subEl   = el.querySelector('.loading-sub');
  if (fill) {
    fill.classList.add('is-progress');
    fill.style.setProperty('--progress', `${Math.min(100, pct).toFixed(1)}%`);
  }
  if (labelEl) labelEl.textContent = `計算中… ${Math.round(pct)}%`;
  if (subEl && sub) subEl.textContent = sub;
}

/** showLoading 後にブラウザが再描画できるよう 1 フレーム待つ */
export function yieldFrame() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ── 住所ジオコーディング（Nominatim / OpenStreetMap）────────────────────

/**
 * 住所文字列から緯度・経度候補を取得する（fetch 呼び出し）
 * Data: © OpenStreetMap contributors (ODbL)
 */
export async function geocodeAddress(query) {
  const url = `https://nominatim.openstreetmap.org/search?` +
    new URLSearchParams({ q: query, format: 'json', limit: '5', 'accept-language': 'ja' });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Stella-JS/1.0 (astronomical astrological engine)' },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  return data.map(d => ({
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
    displayName: d.display_name,
  }));
}

/**
 * 住所検索ボタンにジオコーディング動作を登録する共通ヘルパー（副作用）
 *
 * @param {string} prefix  フォーム識別プレフィックス
 *   - ボタン:   `${prefix}-geocode-btn`
 *   - 住所入力: `${prefix}-address`
 *   - 緯度:     `${prefix}-lat`
 *   - 経度:     `${prefix}-lon`
 *   - 結果表示: `${prefix}-geocode-result`
 */
export function attachGeocodeHandler(prefix) {
  const btn      = document.getElementById(`${prefix}-geocode-btn`);
  const addrEl   = document.getElementById(`${prefix}-address`);
  const latEl    = document.getElementById(`${prefix}-lat`);
  const lonEl    = document.getElementById(`${prefix}-lon`);
  const resultEl = document.getElementById(`${prefix}-geocode-result`);
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const query = addrEl.value.trim();
    if (!query) { resultEl.textContent = '住所を入力してください。'; return; }

    resultEl.textContent = '検索中...';
    try {
      const results = await geocodeAddress(query);
      if (results.length === 0) {
        resultEl.textContent = '見つかりませんでした。より詳細な住所で再検索してください。';
        return;
      }
      const { lat, lon, displayName } = results[0];
      latEl.value = trunc3(lat);
      lonEl.value = trunc3(lon);
      resultEl.innerHTML =
        `✓ ${displayName.split(',').slice(0, 3).join(', ')} ` +
        `<span style="color:var(--text-muted)">— © OpenStreetMap contributors</span>`;
    } catch (err) {
      resultEl.textContent = `検索エラー: ${err.message}`;
    }
  });
}

// ── 月の交点（Lunar Nodes）────────────────────────────────────────────────

/**
 * 月の昇交点（ノースノード）・降交点（サウスノード）の黄経を返す（純粋関数）
 *
 * 平均交点（Mean Node）: Meeus "Astronomical Algorithms" Ch.22 の IAU 式
 *   Ω = 125.04452° − 1934.136261°T + 0.0020708°T² + T³/450000
 * 精度: 数秒〜数分（占星術用途に十分）
 *
 * @param {number} jdTdb  ユリウス日（TDB）
 * @returns {{ north: number, south: number }}  0〜360° の黄経
 */
export function moonNode(jdTdb) {
  const T = (jdTdb - 2451545.0) / 36525.0;
  let omega = 125.04452
    - 1934.136261 * T
    +    0.0020708 * T * T
    + T * T * T / 450000.0;
  const north = ((omega % 360) + 360) % 360;
  const south = (north + 180) % 360;
  return { north, south };
}

/**
 * 月の昇交点の角速度を数値微分で求める（度/日）
 * ノースノードは常に逆行（約 −0.053°/日）
 */
export function moonNodeSpeed(jdTdb) {
  const DT = 1;
  const a = moonNode(jdTdb - DT).north;
  const b = moonNode(jdTdb + DT).north;
  let d = b - a;
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return d / (2 * DT);
}

// ── 共有天体定数 ────────────────────────────────────────────────────────────

/** 地心計算で使う惑星一覧（DE440s 収録の barycenter コード） */
export const GEOCENTRIC_PLANETS = [
  { id: NAIF.SUN,               name: '太陽' },
  { id: NAIF.MOON,              name: '月' },
  { id: NAIF.MERCURY_BARYCENTER,name: '水星' },
  { id: NAIF.VENUS_BARYCENTER,  name: '金星' },
  { id: NAIF.MARS_BARYCENTER,   name: '火星' },
  { id: NAIF.JUPITER_BARYCENTER,name: '木星' },
  { id: NAIF.SATURN_BARYCENTER, name: '土星' },
  { id: NAIF.URANUS_BARYCENTER, name: '天王星' },
  { id: NAIF.NEPTUNE_BARYCENTER,name: '海王星' },
  { id: NAIF.PLUTO_BARYCENTER,  name: '冥王星' },
];

/** アスペクト定義: 角度（度）→ { name, symbol } */
export const ASPECT_DEFS = Object.freeze({
  0:   { name: '合',              symbol: '☌' },
  30:  { name: 'セミセクスタイル', symbol: '⚺' },
  45:  { name: 'セミスクエア',    symbol: '∠' },
  60:  { name: 'セクスタイル',    symbol: '⚹' },
  90:  { name: 'スクエア',        symbol: '□' },
  120: { name: 'トライン',        symbol: '△' },
  135: { name: 'セスキスクエア',  symbol: '⚼' },
  150: { name: 'クインカンクス',  symbol: '⚻' },
  180: { name: 'オポジション',    symbol: '☍' },
});

// ── 境界角度通過検出ユーティリティ ──────────────────────────────────────────

/**
 * 指定した境界角度を天体が通過する JD を検出する（純粋関数）
 *
 * @param {function} calcFn       JD → { lon }
 * @param {number[]} boundaries   境界角度リスト [0, 360)
 * @param {number}   startJD
 * @param {number}   endJD
 * @param {object}   [opts]
 * @returns {Array<{ jd, boundary, lon, lonspeed }>}
 */
export function detectBoundaryCrossings(calcFn, boundaries, startJD, endJD, opts = {}) {
  const stepDays = opts.stepDays      ?? 0.25;
  const precJD   = (opts.precisionHours ?? 0.01) / 24;

  function dev(lon, bnd) {
    return ((lon - bnd + 180 + 360) % 360) - 180;
  }

  function angularDiff(from, to) {
    let d = to - from;
    if (d >  180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  function crossedBoundary(prevLon, curLon, bnd) {
    const d0 = dev(prevLon, bnd);
    const d1 = dev(curLon,  bnd);
    if (d0 * d1 >= 0) return false;
    return Math.abs(d1 - d0) < 180;
  }

  const results = [];
  let prevJD  = startJD;
  let prevLon = calcFn(startJD).lon;

  for (let jd = startJD + stepDays; jd <= endJD; jd += stepDays) {
    const curLon = calcFn(jd).lon;

    for (const bnd of boundaries) {
      if (crossedBoundary(prevLon, curLon, bnd)) {
        let lo = prevJD, loD = dev(prevLon, bnd), hi = jd;
        let iter = 0;
        while (hi - lo > precJD && iter < 60) {
          const mid  = (lo + hi) / 2;
          const midD = dev(calcFn(mid).lon, bnd);
          if (loD * midD <= 0) { hi = mid; } else { lo = mid; loD = midD; }
          iter++;
        }
        const crossJD  = (lo + hi) / 2;
        const crossLon = calcFn(crossJD).lon;
        const lonAfter  = calcFn(crossJD + 0.5 / 24).lon;
        const lonBefore = calcFn(crossJD - 0.5 / 24).lon;
        const lonspeed  = angularDiff(lonBefore, lonAfter) / (1 / 24);
        results.push({ jd: crossJD, boundary: bnd, lon: crossLon, lonspeed });
      }
    }

    prevJD  = jd;
    prevLon = curLon;
  }

  results.sort((a, b) => a.jd - b.jd);
  return results;
}

/**
 * 2惑星間のアスペクト通過 JD を検出する（純粋関数）
 *
 * @param {function} calcFnA  JD → { lon }
 * @param {function} calcFnB  JD → { lon }
 * @param {number}   target   アスペクト角度（0〜180）
 * @param {number}   startJD
 * @param {number}   endJD
 * @returns {Array<{ jd, lonA, lonB, sep }>}
 */
export function detectAspectCrossings(calcFnA, calcFnB, target, startJD, endJD, opts = {}) {
  const stepDays = opts.stepDays   ?? 1.0;
  const precJD   = (opts.precisionHours ?? 0.01) / 24;

  function foldedSep(jd) {
    const diff = ((calcFnA(jd).lon - calcFnB(jd).lon) % 360 + 360) % 360;
    return diff <= 180 ? diff : 360 - diff;
  }

  function deviation(jd) {
    const lonA = calcFnA(jd).lon;
    const lonB = calcFnB(jd).lon;
    if (target === 0)   return ((lonA - lonB + 180 + 360) % 360) - 180;
    if (target === 180) return ((lonA - lonB + 360) % 360) - 180;
    return foldedSep(jd) - target;
  }

  const results = [];
  let prevJD  = startJD;
  let prevDev = deviation(startJD);

  for (let jd = startJD + stepDays; jd <= endJD; jd += stepDays) {
    const currDev = deviation(jd);

    if (prevDev * currDev < 0) {
      let lo = prevJD, loD = prevDev, hi = jd;
      let iter = 0;
      while (hi - lo > precJD && iter < 60) {
        const mid  = (lo + hi) / 2;
        const midD = deviation(mid);
        if (loD * midD <= 0) { hi = mid; } else { lo = mid; loD = midD; }
        iter++;
      }
      const crossJD = (lo + hi) / 2;
      const lonA    = calcFnA(crossJD).lon;
      const lonB    = calcFnB(crossJD).lon;
      const diff    = ((lonA - lonB) % 360 + 360) % 360;
      results.push({ jd: crossJD, lonA, lonB, sep: diff <= 180 ? diff : 360 - diff });
    }

    prevJD  = jd;
    prevDev = currDev;
  }

  return results;
}

// ── 逆行計算ユーティリティ ────────────────────────────────────────────────

/**
 * 逆行検出用 calcFn を生成する
 *
 * detectStationPoint が要求する { lon, lonspeed } を返す関数を返す。
 * lonspeed は 1時間前進差分による近似（°/day）。
 *
 * @param {number}   naifId           惑星の NAIF コード
 * @param {function} computeApparentFn app.js の computeApparent を渡す
 * @param {object}   [opts]
 * @param {boolean}  [opts.aberration=true]
 * @returns {function(jd: number): { lon: number, lonspeed: number }}
 */
export function makeRetroCalcFn(naifId, computeApparentFn, { aberration = true } = {}) {
  const DT = 1.0 / 24; // 1 hour
  return function(jd) {
    const p0 = computeApparentFn(naifId, jd,      { aberration });
    const p1 = computeApparentFn(naifId, jd + DT, { aberration });
    const lonspeed = normAngularDiff(p0.lon, p1.lon) / DT; // °/day
    return { lon: p0.lon, lonspeed };
  };
}

/**
 * 期間内の全留点を検出する（純粋関数）
 *
 * @param {function} calcFn
 * @param {number}   startJD
 * @param {number}   endJD
 * @returns {Array<{jd, lon, type, speedBefore, speedAfter}>}
 */
export function detectAllStations(calcFn, startJD, endJD) {
  const stations = [];
  let from = startJD;
  while (from < endJD) {
    const st = detectStationPoint(calcFn, from, endJD, {
      stepDays: 1.0,
      precisionHours: 0.01,
    });
    if (!st) break;
    stations.push(st);
    from = st.jd + 2;
  }
  return stations;
}

/**
 * 留点リストを逆行期間（開始・終了ペア）に変換する（純粋関数）
 *
 * @param {Array} stations
 * @returns {Array<{start: object|null, end: object|null}>}
 */
export function groupRetrogradePeriods(stations) {
  const periods = [];
  let startSt = null;
  for (const st of stations) {
    if (st.type === 'direct_to_retrograde') {
      startSt = st;
    } else if (st.type === 'retrograde_to_direct') {
      periods.push({ start: startSt, end: st });
      startSt = null;
    }
  }
  if (startSt) periods.push({ start: startSt, end: null });
  return periods;
}
