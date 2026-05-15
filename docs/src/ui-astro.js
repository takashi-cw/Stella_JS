/**
 * ui-astro.js — 占星術計算メニュー UI ハンドラ群
 *
 * 担当セクション（元 app.js L1903–L2873 相当）:
 *   - ホロスコープ計算（ネイタル）
 *   - 期間トランジット
 *   - 惑星星座運行計算（イングレス）
 *   - アスペクト計算
 *   - 中世西洋占星術（ホロスコープ・イングレス）
 *   - ヘリオ占星術チャート
 *   - 日心アスペクト時系列
 *
 * 使用方法:
 *   import { init } from './ui-astro.js';
 *   init({ computeApparent, computeHeliocentric, requireBsp, settings });
 */

import {
  NAIF, jdUtcToTdb, jdTtToUtc, normAngle, normAngularDiff,
  calculateAyanamsha, calcSyzygy, circularMeanLongitude, calculateOptimalSampleCount,
  getAllAspects, MAJOR_ASPECTS,
  housesPlacidus, housesKoch, housesEqual, housesWholeSigns,
  housesRegiomontanus, housesCampanus,
} from './index.js';

import {
  jstInputToJdUtc, jstInputToJdTdb, jdToJstStr, trunc3, lonToSign,
  showResult, showLoading, yieldFrame,
  ZODIAC_SIGNS_JP, moonNode, moonNodeSpeed,
  dateStrToJdUtcMidJst, attachGeocodeHandler,
  GEOCENTRIC_PLANETS, ASPECT_DEFS,
  detectBoundaryCrossings, detectAspectCrossings,
} from './ui-helpers.js';

// ── モジュールレベルの依存 ────────────────────────────────────────────────
let _computeApparent;
let _computeHeliocentric;
let _requireBsp;
let _settings;

/**
 * モジュールの初期化 — イベントハンドラを登録する
 */
export function init(deps) {
  _computeApparent    = deps.computeApparent;
  _computeHeliocentric = deps.computeHeliocentric;
  _requireBsp         = deps.requireBsp;
  _settings           = deps.settings;
  _registerHandlers();
}

// ── アヤナムシャ ──────────────────────────────────────────────────────────

const AYANAMSHA = { LAHIRI: 'lahiri', FAGAN_BRADLEY: 'fagan_bradley' };

function ayanamsha(jdTdb, type) {
  const year = 2000 + (jdTdb - 2451545.0) / 365.25;
  const result = calculateAyanamsha(type, year);
  return result?.offsetDeg ?? 0;
}

// ── ハウス関数マップ ─────────────────────────────────────────────────────
const HOUSE_FN_MAP = {
  placidus:      housesPlacidus,
  koch:          housesKoch,
  equal:         housesEqual,
  whole:         housesWholeSigns,
  regiomontanus: housesRegiomontanus,
  campanus:      housesCampanus,
};

// ── 定数 ─────────────────────────────────────────────────────────────────

const MODERN_INGRESS_STEP = Object.freeze({
  [NAIF.SUN]:                1.0,
  [NAIF.MOON]:               0.5,
  [NAIF.MERCURY_BARYCENTER]: 1.0,
  [NAIF.VENUS_BARYCENTER]:   1.0,
  [NAIF.MARS_BARYCENTER]:    2.0,
  [NAIF.JUPITER_BARYCENTER]: 7.0,
  [NAIF.SATURN_BARYCENTER]:  14.0,
  [NAIF.URANUS_BARYCENTER]:  30.0,
  [NAIF.NEPTUNE_BARYCENTER]: 60.0,
  [NAIF.PLUTO_BARYCENTER]:   90.0,
});

const ASPECT_DEFS_FULL = Object.freeze([
  { type:   0, symbol: '☌', name: 'コンジャンクション（合）'  },
  { type:  60, symbol: '⚹', name: 'セクスタイル（六分）'       },
  { type:  90, symbol: '□', name: 'スクエア（四分）'           },
  { type: 120, symbol: '△', name: 'トライン（三分）'           },
  { type: 180, symbol: '☍', name: 'オポジション（衝）'         },
]);

const MEDIEVAL_PLANETS = [
  { id: NAIF.SUN,                name: '太陽' },
  { id: NAIF.MOON,               name: '月' },
  { id: NAIF.MERCURY_BARYCENTER, name: '水星' },
  { id: NAIF.VENUS_BARYCENTER,   name: '金星' },
  { id: NAIF.MARS_BARYCENTER,    name: '火星' },
  { id: NAIF.JUPITER_BARYCENTER, name: '木星' },
  { id: NAIF.SATURN_BARYCENTER,  name: '土星' },
];

const MEDIEVAL_INGRESS_STEP = Object.freeze({
  [NAIF.MOON]:               0.5,
  [NAIF.SUN]:                1.0,
  [NAIF.MERCURY_BARYCENTER]: 1.0,
  [NAIF.VENUS_BARYCENTER]:   1.0,
  [NAIF.MARS_BARYCENTER]:    2.0,
  [NAIF.JUPITER_BARYCENTER]: 7.0,
  [NAIF.SATURN_BARYCENTER]:  14.0,
});

const HELIO_PLANETS = [
  { id: NAIF.MERCURY_BARYCENTER, name: '水星' },
  { id: NAIF.VENUS_BARYCENTER,   name: '金星' },
  { id: NAIF.EARTH,              name: '地球' },
  { id: NAIF.MARS_BARYCENTER,    name: '火星' },
  { id: NAIF.JUPITER_BARYCENTER, name: '木星' },
  { id: NAIF.SATURN_BARYCENTER,  name: '土星' },
  { id: NAIF.URANUS_BARYCENTER,  name: '天王星' },
  { id: NAIF.NEPTUNE_BARYCENTER, name: '海王星' },
  { id: NAIF.PLUTO_BARYCENTER,   name: '冥王星' },
];

const HELIO_NAIF_MAP = Object.freeze({
  '1':   NAIF.MERCURY_BARYCENTER,
  '2':   NAIF.VENUS_BARYCENTER,
  '399': NAIF.EARTH,
  '4':   NAIF.MARS_BARYCENTER,
  '5':   NAIF.JUPITER_BARYCENTER,
  '6':   NAIF.SATURN_BARYCENTER,
  '7':   NAIF.URANUS_BARYCENTER,
  '8':   NAIF.NEPTUNE_BARYCENTER,
  '9':   NAIF.PLUTO_BARYCENTER,
});

// ── ユーティリティ ────────────────────────────────────────────────────────

/** ハウス番号を計算する（純粋関数） */
function getHouseNum(lon, cusps) {
  for (let i = 0; i < 12; i++) {
    const c1 = cusps[i];
    const c2 = cusps[(i + 1) % 12];
    const inHouse = c2 > c1
      ? lon >= c1 && lon < c2
      : lon >= c1 || lon < c2;
    if (inHouse) return i + 1;
  }
  return 1;
}

/** 太陽黄経の角度中点を求める（純粋ヘルパー） */
function solarAngularMidpoint(lonA, lonB) {
  let d = lonB - lonA;
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return normAngle(lonA + d / 2);
}

// ── イベントハンドラ登録 ──────────────────────────────────────────────────

function _registerHandlers() {

  // 住所検索ハンドラ登録
  ['transit'].forEach(attachGeocodeHandler);

  // ── ホロスコープ計算（3-1-1） ─────────────────────────────────────
  document.getElementById('form-natal')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-natal')) return;

    const jdUtc   = jstInputToJdUtc(document.getElementById('natal-datetime').value);
    const jdTdb   = jdUtcToTdb(jdUtc);
    const lat     = parseFloat(document.getElementById('natal-lat').value);
    const lon     = parseFloat(document.getElementById('natal-lon').value);
    const hSystem = document.getElementById('natal-house').value;
    const zodiac  = document.getElementById('natal-zodiac').value;

    const ayanamshaVal =
      zodiac === 'sidereal-lahiri'  ? ayanamsha(jdTdb, AYANAMSHA.LAHIRI)        :
      zodiac === 'sidereal-fagan'   ? ayanamsha(jdTdb, AYANAMSHA.FAGAN_BRADLEY) :
      0;

    let cusps, angles;
    try {
      const hFn = HOUSE_FN_MAP[hSystem] ?? housesPlacidus;
      ({ cusps, angles } = hFn(jdUtc, lat, lon));
    } catch (err) {
      showResult('result-natal', `ハウス計算エラー: ${err.message}`, true);
      return;
    }

    const DT_NATAL = 1 / 24;
    const planets = [];
    for (const { id: naifId, name } of GEOCENTRIC_PLANETS) {
      try {
        let { lon: pLon, lat: pLat } = _computeApparent(naifId, jdTdb);
        const lonNext = _computeApparent(naifId, jdTdb + DT_NATAL).lon;
        let spd = normAngularDiff(pLon, lonNext) / DT_NATAL;
        pLon = normAngle(pLon - ayanamshaVal);
        planets.push({ id: naifId, name, lon: pLon, lat: pLat, lonspeed: spd });
      } catch { /* skip */ }
    }
    { const { north, south } = moonNode(jdTdb);
      const nodeSpd = moonNodeSpeed(jdTdb);
      planets.push({ id: 'NORTH_NODE', name: '☊ ノースノード', lon: normAngle(north - ayanamshaVal), lat: 0, lonspeed: nodeSpd });
      planets.push({ id: 'SOUTH_NODE', name: '☋ サウスノード', lon: normAngle(south - ayanamshaVal), lat: 0, lonspeed: -nodeSpd }); }

    let syzRow = '';
    try {
      const sunFn  = jd => { const r = _computeApparent(NAIF.SUN,  jd); return { lon: r.lon }; };
      const moonFn = jd => { const r = _computeApparent(NAIF.MOON, jd); return { lon: r.lon }; };
      const syz = calcSyzygy(sunFn, moonFn, jdTdb);
      if (syz) {
        const typeLabel = syz.type === 'new_moon' ? '🌑 朔（新月）' : '🌕 望（満月）';
        const syzLon    = normAngle(syz.lon - ayanamshaVal);
        syzRow = `<tr style="border-top:1px solid var(--border);color:var(--text-muted)">
          <td>シジジー<br><span style="font-size:10px">${typeLabel}</span></td>
          <td>—</td>
          <td>${lonToSign(syzLon)}</td>
          <td>${trunc3(syzLon)}°</td>
          <td>—</td>
        </tr>`;
      }
    } catch { /* BSP 範囲外などでは無視 */ }

    const aspects = getAllAspects(
      planets.map(p => ({ id: p.id, lon: p.lon, speed: 0 })),
      MAJOR_ASPECTS
    );

    let adjustedCusps;
    if (hSystem === 'whole' && ayanamshaVal !== 0) {
      const sidAsc = normAngle(angles[0] - ayanamshaVal);
      const sidAscSignStart = Math.floor(sidAsc / 30) * 30;
      adjustedCusps = Array.from({ length: 12 }, (_, i) => normAngle(sidAscSignStart + i * 30));
    } else {
      adjustedCusps = cusps.map(c => normAngle(c - ayanamshaVal));
    }
    const planetRows = planets.map(p => {
      const hNum   = getHouseNum(p.lon, adjustedCusps);
      const isRetro = p.lonspeed != null && p.lonspeed < 0;
      const rxMark  = isRetro ? ' <span style="color:#f4a460;font-size:10px" title="逆行中">℞</span>' : '';
      return `<tr><td>${p.name}${rxMark}</td><td>H${hNum}</td><td>${lonToSign(p.lon)}</td><td>${trunc3(p.lon)}°</td><td>${trunc3(p.lat)}°</td></tr>`;
    }).join('') + syzRow;

    const houseRows = adjustedCusps.map((c, i) =>
      `<tr><td>H${i + 1}</td><td>${lonToSign(c)}</td><td>${trunc3(c)}°</td></tr>`
    ).join('');

    const [ascDeg, mcDeg] = angles;
    const ASPECT_SYMBOL = { 0: '☌ コンジャンクション', 60: '⚹ セクスタイル', 90: '□ スクエア', 120: '△ トライン', 180: '☍ オポジション' };
    const planetNameById = Object.fromEntries(planets.map(p => [p.id, p.name]));
    const aspectRows = aspects.slice(0, 20).map(a =>
      `<tr><td>${planetNameById[a.planet1] ?? a.planet1}</td><td>${ASPECT_SYMBOL[a.type] ?? `${a.type}°`}</td><td>${planetNameById[a.planet2] ?? a.planet2}</td><td>${a.orb.toFixed(2)}°</td></tr>`
    ).join('');

    const zodiacLabel = zodiac === 'tropical' ? 'トロピカル' : zodiac === 'sidereal-lahiri' ? 'サイデリアル・ラーヒリー' : 'サイデリアル・フェーガン';
    const coordSuffix = _settings.coordSystem === 'j2000' ? ' / J2000.0' : ' / of-date';
    showResult('result-natal', `
      <h4 style="margin:0 0 8px;font-size:13px">▼ 惑星位置（${zodiacLabel}${coordSuffix}）</h4>
      <table class="result-table">
        <thead><tr><th>天体</th><th>ハウス</th><th>星座</th><th>黄経</th><th>黄緯</th></tr></thead>
        <tbody>${planetRows}</tbody>
      </table>
      <h4 style="margin:12px 0 8px;font-size:13px">▼ ハウスカスプ（${hSystem}）</h4>
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 6px">
        ASC: ${lonToSign(normAngle(ascDeg - ayanamshaVal))} &nbsp;|&nbsp; MC: ${lonToSign(normAngle(mcDeg - ayanamshaVal))} &nbsp;|&nbsp; DSC: ${lonToSign(normAngle(ascDeg - ayanamshaVal + 180))} &nbsp;|&nbsp; IC: ${lonToSign(normAngle(mcDeg - ayanamshaVal + 180))}
      </p>
      <table class="result-table">
        <thead><tr><th>ハウス</th><th>星座</th><th>黄経</th></tr></thead>
        <tbody>${houseRows}</tbody>
      </table>
      <h4 style="margin:12px 0 8px;font-size:13px">▼ メジャーアスペクト（上位20件）</h4>
      <table class="result-table">
        <thead><tr><th>天体A</th><th>アスペクト</th><th>天体B</th><th>オーブ</th></tr></thead>
        <tbody>${aspectRows}</tbody>
      </table>`);
  });

  // ── 3-1-2: 期間トランジット ───────────────────────────────────────────
  document.getElementById('form-modern-transit')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-modern-transit')) return;

    const startVal = document.getElementById('transit-start').value;
    const endVal   = document.getElementById('transit-end').value;
    const lat      = parseFloat(document.getElementById('transit-lat').value);
    const lon      = parseFloat(document.getElementById('transit-lon').value);
    const hSystem  = document.getElementById('transit-house').value;
    const zodiac   = document.getElementById('transit-zodiac').value;

    const startJdTdb = jstInputToJdTdb(startVal);
    const endJdTdb   = jstInputToJdTdb(endVal);

    if (endJdTdb <= startJdTdb) {
      showResult('result-modern-transit', '終了日時は開始日時より後にしてください。', true);
      return;
    }

    const ayanamshaVal =
      zodiac === 'sidereal-lahiri' ? ayanamsha(startJdTdb, AYANAMSHA.LAHIRI)        :
      zodiac === 'sidereal-fagan'  ? ayanamsha(startJdTdb, AYANAMSHA.FAGAN_BRADLEY) :
      0;

    const periodDays = endJdTdb - startJdTdb;

    let midLon, method;
    if (periodDays <= 31) {
      const lonStart = normAngle(_computeApparent(NAIF.SUN, startJdTdb).lon - ayanamshaVal);
      const lonEnd   = normAngle(_computeApparent(NAIF.SUN, endJdTdb).lon   - ayanamshaVal);
      midLon = solarAngularMidpoint(lonStart, lonEnd);
      method = '角度中点基準法';
    } else {
      const numSamples = calculateOptimalSampleCount(periodDays, 'Sun');
      const sampleLons = [];
      for (let i = 0; i < numSamples; i++) {
        const sampleJd  = startJdTdb + (periodDays * i / (numSamples - 1));
        const sampleLon = normAngle(_computeApparent(NAIF.SUN, sampleJd).lon - ayanamshaVal);
        sampleLons.push(sampleLon);
      }
      midLon = circularMeanLongitude(sampleLons);
      method = '運動学的平均法';
    }

    function sunLonDev(jdTdb) {
      const l = normAngle(_computeApparent(NAIF.SUN, jdTdb).lon - ayanamshaVal);
      let d = l - midLon;
      if (d >  180) d -= 360;
      if (d < -180) d += 360;
      return d;
    }
    let midJdTdb;
    const d0 = sunLonDev(startJdTdb), d1 = sunLonDev(endJdTdb);
    if (d0 * d1 > 0) {
      midJdTdb = (startJdTdb + endJdTdb) / 2;
    } else {
      let lo = startJdTdb, hi = endJdTdb;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (sunLonDev(lo) * sunLonDev(mid) <= 0) hi = mid; else lo = mid;
        if (hi - lo < 0.5 / 86400) break;
      }
      midJdTdb = (lo + hi) / 2;
    }

    const midJdUtc = jdTtToUtc(midJdTdb);
    let cusps, angles;
    try {
      const hFn = HOUSE_FN_MAP[hSystem] ?? housesPlacidus;
      ({ cusps, angles } = hFn(midJdUtc, lat, lon));
    } catch (err) {
      showResult('result-modern-transit', `ハウス計算エラー: ${err.message}`, true);
      return;
    }

    const adjustedCusps = cusps.map(c => normAngle(c - ayanamshaVal));
    const planets = [];
    for (const { id: naifId, name } of GEOCENTRIC_PLANETS) {
      try {
        let { lon: pLon, lat: pLat } = _computeApparent(naifId, midJdTdb);
        pLon = normAngle(pLon - ayanamshaVal);
        planets.push({ id: naifId, name, lon: pLon, lat: pLat });
      } catch { /* skip */ }
    }
    { const { north, south } = moonNode(midJdTdb);
      planets.push({ id: 'NORTH_NODE', name: '☊ ノースノード', lon: normAngle(north - ayanamshaVal), lat: 0 });
      planets.push({ id: 'SOUTH_NODE', name: '☋ サウスノード', lon: normAngle(south - ayanamshaVal), lat: 0 }); }

    const aspects = getAllAspects(
      planets.map(p => ({ id: p.id, lon: p.lon, speed: 0 })),
      MAJOR_ASPECTS
    );

    const ASPECT_SYMBOL = { 0: '☌ コンジャンクション', 60: '⚹ セクスタイル', 90: '□ スクエア', 120: '△ トライン', 180: '☍ オポジション' };
    const planetNameById = Object.fromEntries(planets.map(p => [p.id, p.name]));
    const zodiacLabel = zodiac === 'tropical' ? 'トロピカル' : zodiac === 'sidereal-lahiri' ? 'サイデリアル・ラーヒリー' : 'サイデリアル・フェーガン';
    const coordSuffix = _settings.coordSystem === 'j2000' ? ' / J2000.0' : ' / of-date';
    const midDateStr  = jdToJstStr(midJdTdb);
    const [ascDeg, mcDeg] = angles;

    const planetRows = planets.map(p => {
      const hNum = getHouseNum(p.lon, adjustedCusps);
      return `<tr><td>${p.name}</td><td>H${hNum}</td><td>${lonToSign(p.lon)}</td><td>${trunc3(p.lon)}°</td><td>${trunc3(p.lat)}°</td></tr>`;
    }).join('');
    const houseRows = adjustedCusps.map((c, i) =>
      `<tr><td>H${i + 1}</td><td>${lonToSign(c)}</td><td>${trunc3(c)}°</td></tr>`
    ).join('');
    const aspectRows = aspects.slice(0, 20).map(a =>
      `<tr><td>${planetNameById[a.planet1] ?? a.planet1}</td><td>${ASPECT_SYMBOL[a.type] ?? `${a.type}°`}</td><td>${planetNameById[a.planet2] ?? a.planet2}</td><td>${a.orb.toFixed(2)}°</td></tr>`
    ).join('');

    showResult('result-modern-transit', `
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
        <strong>手法:</strong> ${method}<br>
        <strong>入力期間:</strong> ${startVal.replace('T', ' ')} 〜 ${endVal.replace('T', ' ')} JST（${periodDays.toFixed(1)}日間）<br>
        <strong>太陽中点黄経:</strong> ${midLon.toFixed(3)}° → <strong>代表日時:</strong> ${midDateStr}<br>
        ASC: ${lonToSign(normAngle(ascDeg - ayanamshaVal))} &nbsp;|&nbsp; MC: ${lonToSign(normAngle(mcDeg - ayanamshaVal))} &nbsp;|&nbsp; DSC: ${lonToSign(normAngle(ascDeg - ayanamshaVal + 180))} &nbsp;|&nbsp; IC: ${lonToSign(normAngle(mcDeg - ayanamshaVal + 180))}
      </p>
      <h4 style="margin:0 0 8px;font-size:13px">▼ 惑星位置（${zodiacLabel}${coordSuffix}）</h4>
      <table class="result-table">
        <thead><tr><th>天体</th><th>ハウス</th><th>星座</th><th>黄経</th><th>黄緯</th></tr></thead>
        <tbody>${planetRows}</tbody>
      </table>
      <h4 style="margin:12px 0 8px;font-size:13px">▼ ハウスカスプ（${hSystem}）</h4>
      <table class="result-table">
        <thead><tr><th>ハウス</th><th>星座</th><th>黄経</th></tr></thead>
        <tbody>${houseRows}</tbody>
      </table>
      <h4 style="margin:12px 0 8px;font-size:13px">▼ メジャーアスペクト（上位20件）</h4>
      <table class="result-table">
        <thead><tr><th>天体A</th><th>アスペクト</th><th>天体B</th><th>オーブ</th></tr></thead>
        <tbody>${aspectRows}</tbody>
      </table>`);
  });

  // ── 3-1-3: 惑星星座運行計算（現代） ──────────────────────────────────
  document.getElementById('form-modern-ingress')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-modern-ingress')) return;

    const startStr = document.getElementById('modern-ingress-start').value;
    const endStr   = document.getElementById('modern-ingress-end').value;
    const selVal   = document.getElementById('modern-ingress-planet').value;

    const startJD = dateStrToJdUtcMidJst(startStr);
    const endJD   = dateStrToJdUtcMidJst(endStr) + 1.0;

    if (endJD - startJD > 366 * 3) {
      showResult('result-modern-ingress', '計算期間は最大3年以内にしてください。', true);
      return;
    }

    const targets = selVal === 'all'
      ? GEOCENTRIC_PLANETS
      : GEOCENTRIC_PLANETS.filter(p => String(p.id) === selVal);

    if (targets.length === 0) {
      showResult('result-modern-ingress', '惑星が見つかりません。', true);
      return;
    }

    showLoading('result-modern-ingress', '計算中…', '惑星の星座境界通過を二分探索');
    await yieldFrame();

    const SIGN_BOUNDARIES = Array.from({ length: 12 }, (_, i) => i * 30);
    const allCrossings = [];

    for (const planet of targets) {
      const stepDays = MODERN_INGRESS_STEP[planet.id] ?? 1.0;
      const calcFn   = jd => _computeApparent(planet.id, jdUtcToTdb(jd));
      const crossings = detectBoundaryCrossings(calcFn, SIGN_BOUNDARIES, startJD, endJD, {
        stepDays,
        precisionHours: 0.01,
      });
      for (const c of crossings) {
        allCrossings.push({ ...c, planetName: planet.name });
      }
    }
    allCrossings.sort((a, b) => a.jd - b.jd);

    if (allCrossings.length === 0) {
      showResult('result-modern-ingress',
        `<p style="color:var(--text-muted)">指定期間にイングレスなし（${startStr} 〜 ${endStr}）</p>`);
      return;
    }

    const rows = allCrossings.map(c => {
      const sign    = ZODIAC_SIGNS_JP[Math.floor(c.boundary / 30) % 12];
      const retro   = c.lonspeed < 0;
      const dir     = retro ? '逆行 ℞' : '順行';
      const dirColor = retro ? '#f4a460' : 'var(--accent)';
      return `<tr>
        <td>${c.planetName}</td>
        <td>${jdToJstStr(c.jd)}</td>
        <td>${sign}</td>
        <td>${c.boundary}°</td>
        <td style="color:${dirColor}">${dir}</td>
        <td style="text-align:center">${c.lonspeed >= 0 ? '+' : ''}${c.lonspeed.toFixed(4)}°/日</td>
      </tr>`;
    }).join('');

    const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    showResult('result-modern-ingress', `
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
        期間: ${startStr} 〜 ${endStr}　|　座標系: ${coordLabel}　|　${allCrossings.length} 件
      </p>
      <table class="result-table">
        <thead><tr>
          <th>惑星</th><th>日時 (JST)</th><th>入座星座</th><th>境界黄経</th>
          <th>方向</th><th style="text-align:center">角速度 (°/日)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  });

  // ── 3-1-4: アスペクト計算 ─────────────────────────────────────────────
  document.getElementById('form-modern-aspects')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-modern-aspects')) return;

    const dtVal  = document.getElementById('aspects-datetime').value;
    const orbVal = parseFloat(document.getElementById('aspects-orb').value);
    const jdTdb  = jstInputToJdTdb(dtVal);

    const DT = 1 / 24;
    const planets = [];
    for (const { id: naifId, name } of GEOCENTRIC_PLANETS) {
      try {
        const { lon: pLon } = _computeApparent(naifId, jdTdb);
        const lonPrev = _computeApparent(naifId, jdTdb - DT).lon;
        const lonNext = _computeApparent(naifId, jdTdb + DT).lon;
        let speed = lonNext - lonPrev;
        if (speed >  180) speed -= 360;
        if (speed < -180) speed += 360;
        speed = speed / (2 * DT);
        planets.push({ id: naifId, name, lon: pLon, speed });
      } catch { /* skip */ }
    }
    { const { north, south } = moonNode(jdTdb);
      const spd = moonNodeSpeed(jdTdb);
      planets.push({ id: 'NORTH_NODE', name: '☊ ノースノード', lon: north, speed: spd });
      planets.push({ id: 'SOUTH_NODE', name: '☋ サウスノード', lon: south, speed: spd }); }

    const aspList = [];
    for (let i = 0; i < planets.length; i++) {
      for (let j = i + 1; j < planets.length; j++) {
        const pA = planets[i], pB = planets[j];
        let sep = Math.abs(pA.lon - pB.lon) % 360;
        if (sep > 180) sep = 360 - sep;
        for (const def of ASPECT_DEFS_FULL) {
          const orb = Math.abs(sep - def.type);
          if (orb <= orbVal) {
            let movement = '';
            const relSpeed = pA.speed - pB.speed;
            const diff = pA.lon - pB.lon;
            let normDiff = diff;
            if (normDiff >  180) normDiff -= 360;
            if (normDiff < -180) normDiff += 360;
            if      (relSpeed * normDiff < 0) movement = '接近';
            else if (relSpeed * normDiff > 0) movement = '離脱';
            aspList.push({ nameA: pA.name, nameB: pB.name, ...def, orb, movement });
          }
        }
      }
    }
    aspList.sort((a, b) => a.orb - b.orb);

    const coordSuffix = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    const movColor = m => m === '接近' ? 'var(--accent)' : m === '離脱' ? 'var(--text-muted)' : '';
    const aspRows = aspList.map(a =>
      `<tr>
        <td>${a.nameA}</td>
        <td>${a.symbol} ${a.name}</td>
        <td>${a.nameB}</td>
        <td>${a.orb.toFixed(2)}°</td>
        <td style="color:${movColor(a.movement)}">${a.movement}</td>
      </tr>`
    ).join('');

    showResult('result-modern-aspects', `
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
        ${dtVal.replace('T', ' ')} JST　|　座標系: ${coordSuffix}　|　オーブ ±${orbVal}°　|　${aspList.length} 件
      </p>
      <table class="result-table">
        <thead><tr>
          <th>天体A</th><th>アスペクト</th><th>天体B</th><th>オーブ</th><th>状態</th>
        </tr></thead>
        <tbody>${aspRows || '<tr><td colspan="5" style="color:var(--text-muted)">アスペクトなし</td></tr>'}</tbody>
      </table>`);
  });

  // ── 3-2-1: 中世西洋占星術ホロスコープ ────────────────────────────────
  document.getElementById('form-medieval-chart')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-medieval-chart')) return;

    const dtVal = document.getElementById('medieval-datetime').value;
    const lat   = parseFloat(document.getElementById('medieval-lat').value);
    const lon   = parseFloat(document.getElementById('medieval-lon').value);

    const jdUtc   = jstInputToJdUtc(dtVal);
    const jdTdb   = jdUtcToTdb(jdUtc);
    const observer = { lat, lon, elev: 0 };

    let cusps, angles;
    try {
      ({ cusps, angles } = housesCampanus(jdUtc, lat, lon));
    } catch (err) {
      showResult('result-medieval-chart', `ハウス計算エラー: ${err.message}`, true);
      return;
    }

    const DT = 1 / 24;
    const planets = [];
    for (const { id: naifId, name } of MEDIEVAL_PLANETS) {
      try {
        const { lon: pLon, lat: pLat } = _computeApparent(naifId, jdTdb, { jdUtc, observer });
        const lonPrev = _computeApparent(naifId, jdTdb - DT, { jdUtc: jdUtc - DT, observer }).lon;
        const lonNext = _computeApparent(naifId, jdTdb + DT, { jdUtc: jdUtc + DT, observer }).lon;
        let speed = lonNext - lonPrev;
        if (speed >  180) speed -= 360;
        if (speed < -180) speed += 360;
        speed = speed / (2 * DT);
        planets.push({ id: naifId, name, lon: pLon, lat: pLat, speed });
      } catch { /* skip */ }
    }

    const CLASSICAL_ASPECTS = [0, 60, 90, 120, 180];
    const ASPECT_ORB        = 8;
    const ASPECT_SYMBOL_MED = {
      0: '☌ 合', 60: '⚹ セクスタイル', 90: '□ スクエア', 120: '△ トライン', 180: '☍ 対',
    };
    const aspectsMed = [];
    for (let i = 0; i < planets.length; i++) {
      for (let j = i + 1; j < planets.length; j++) {
        let sep = Math.abs(planets[i].lon - planets[j].lon) % 360;
        if (sep > 180) sep = 360 - sep;
        for (const asp of CLASSICAL_ASPECTS) {
          const orb = Math.abs(sep - asp);
          if (orb <= ASPECT_ORB) {
            aspectsMed.push({ nameA: planets[i].name, nameB: planets[j].name, asp, orb, sep });
          }
        }
      }
    }

    let syzRowMed = '';
    try {
      const sunFnM  = jd => { const r = _computeApparent(NAIF.SUN,  jd); return { lon: r.lon }; };
      const moonFnM = jd => { const r = _computeApparent(NAIF.MOON, jd); return { lon: r.lon }; };
      const syz = calcSyzygy(sunFnM, moonFnM, jdTdb);
      if (syz) {
        const typeLabel = syz.type === 'new_moon' ? '🌑 朔' : '🌕 望';
        syzRowMed = `<tr style="border-top:1px solid var(--border);color:var(--text-muted)">
          <td>シジジー ${typeLabel}</td>
          <td>—</td>
          <td>${lonToSign(syz.lon)}</td>
          <td>${syz.lon.toFixed(3)}°</td>
          <td style="text-align:center">—</td>
        </tr>`;
      }
    } catch { /* BSP 範囲外などでは無視 */ }

    const coordLabel = _settings.coordSystem === 'j2000' ? ' / J2000.0' : ' / of-date';
    const [ascDeg, mcDeg] = angles;

    const planetRows = planets.map(p => {
      const hNum  = getHouseNum(p.lon, cusps);
      const retro = p.speed < 0
        ? ' <span style="color:#f4a460;font-size:10px" title="逆行中">℞</span>'
        : '';
      return `<tr>
        <td>${p.name}${retro}</td>
        <td>H${hNum}</td>
        <td>${lonToSign(p.lon)}</td>
        <td>${p.lon.toFixed(3)}°</td>
        <td style="text-align:center">${p.speed >= 0 ? '+' : ''}${p.speed.toFixed(4)}°/日</td>
      </tr>`;
    }).join('') + syzRowMed;

    const houseRows = cusps.map((c, i) =>
      `<tr><td>H${i + 1}</td><td>${lonToSign(c)}</td><td>${c.toFixed(3)}°</td></tr>`
    ).join('');

    const aspRows = aspectsMed.map(a =>
      `<tr><td>${a.nameA}</td><td>${ASPECT_SYMBOL_MED[a.asp] ?? `${a.asp}°`}</td><td>${a.nameB}</td><td>${a.orb.toFixed(2)}°</td></tr>`
    ).join('');

    showResult('result-medieval-chart', `
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
        ${dtVal.replace('T', ' ')} JST　緯度 ${lat}°　経度 ${lon}°　カンパヌス式・トロピカル${coordLabel}<br>
        ASC: ${lonToSign(ascDeg)} &nbsp;|&nbsp; MC: ${lonToSign(mcDeg)} &nbsp;|&nbsp;
        DSC: ${lonToSign(normAngle(ascDeg + 180))} &nbsp;|&nbsp; IC: ${lonToSign(normAngle(mcDeg + 180))}
      </p>
      <h4 style="margin:0 0 8px;font-size:13px">▼ 惑星位置（7惑星）</h4>
      <table class="result-table">
        <thead><tr>
          <th>天体</th><th>ハウス</th><th>星座</th><th>黄経</th><th style="text-align:center">角速度 (°/日)</th>
        </tr></thead>
        <tbody>${planetRows}</tbody>
      </table>
      <h4 style="margin:12px 0 8px;font-size:13px">▼ ハウスカスプ（カンパヌス式）</h4>
      <table class="result-table">
        <thead><tr><th>ハウス</th><th>星座</th><th>黄経</th></tr></thead>
        <tbody>${houseRows}</tbody>
      </table>
      <h4 style="margin:12px 0 8px;font-size:13px">▼ 古典5アスペクト（オーブ 8°以内）</h4>
      <table class="result-table">
        <thead><tr><th>天体A</th><th>アスペクト</th><th>天体B</th><th>オーブ</th></tr></thead>
        <tbody>${aspRows || '<tr><td colspan="4" style="color:var(--text-muted)">アスペクトなし</td></tr>'}</tbody>
      </table>`);
  });

  // ── 3-2-2: 中世イングレス ─────────────────────────────────────────────
  document.getElementById('form-medieval-ingress')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-medieval-ingress')) return;

    const startStr = document.getElementById('medieval-ingress-start').value;
    const endStr   = document.getElementById('medieval-ingress-end').value;
    const selVal   = document.getElementById('medieval-ingress-planet').value;

    const startJD = dateStrToJdUtcMidJst(startStr);
    const endJD   = dateStrToJdUtcMidJst(endStr) + 1.0;

    if (endJD - startJD > 366 * 2) {
      showResult('result-medieval-ingress', '計算期間は最大2年以内にしてください。', true);
      return;
    }

    const targets = selVal === 'all'
      ? MEDIEVAL_PLANETS
      : MEDIEVAL_PLANETS.filter(p => String(p.id) === selVal);

    if (targets.length === 0) {
      showResult('result-medieval-ingress', '惑星が見つかりません。', true);
      return;
    }

    showLoading('result-medieval-ingress', '計算中…', '惑星の星座境界通過を二分探索');
    await yieldFrame();

    const SIGN_BOUNDARIES = Array.from({ length: 12 }, (_, i) => i * 30);
    const allCrossings = [];

    for (const planet of targets) {
      const stepDays = MEDIEVAL_INGRESS_STEP[planet.id] ?? 1.0;
      const calcFn   = jd => _computeApparent(planet.id, jdUtcToTdb(jd));
      const crossings = detectBoundaryCrossings(calcFn, SIGN_BOUNDARIES, startJD, endJD, {
        stepDays,
        precisionHours: 0.01,
      });
      for (const c of crossings) {
        allCrossings.push({ ...c, planetName: planet.name });
      }
    }
    allCrossings.sort((a, b) => a.jd - b.jd);

    if (allCrossings.length === 0) {
      showResult('result-medieval-ingress',
        `<p style="color:var(--text-muted)">指定期間にイングレスなし（${startStr} 〜 ${endStr}）</p>`);
      return;
    }

    const rows = allCrossings.map(c => {
      const sign    = ZODIAC_SIGNS_JP[Math.floor(c.boundary / 30) % 12];
      const retro   = c.lonspeed < 0;
      const dir     = retro ? '逆行 ℞' : '順行';
      const dirColor = retro ? '#f4a460' : 'var(--accent)';
      return `<tr>
        <td>${c.planetName}</td>
        <td>${jdToJstStr(c.jd)}</td>
        <td>${sign}</td>
        <td>${c.boundary}°</td>
        <td style="color:${dirColor}">${dir}</td>
        <td style="text-align:center">${c.lonspeed >= 0 ? '+' : ''}${c.lonspeed.toFixed(4)}°/日</td>
      </tr>`;
    }).join('');

    const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    showResult('result-medieval-ingress', `
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
        期間: ${startStr} 〜 ${endStr}　|　座標系: ${coordLabel}　|　${allCrossings.length} 件
      </p>
      <table class="result-table">
        <thead><tr>
          <th>惑星</th><th>日時 (JST)</th><th>入座星座</th><th>境界黄経</th>
          <th>方向</th><th style="text-align:center">角速度 (°/日)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  });

  // ── 3-3-1: ヘリオ占星術チャート ──────────────────────────────────────
  document.getElementById('form-helio-chart')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-helio-chart')) return;

    const dtVal  = document.getElementById('helio-datetime').value;
    const zodiac = document.getElementById('helio-zodiac').value;
    const orbVal = parseFloat(document.getElementById('helio-orb').value);
    const jdTdb  = jstInputToJdTdb(dtVal);

    const ayanamshaVal =
      zodiac === 'sidereal-lahiri' ? ayanamsha(jdTdb, AYANAMSHA.LAHIRI)        :
      zodiac === 'sidereal-fagan'  ? ayanamsha(jdTdb, AYANAMSHA.FAGAN_BRADLEY) :
      0;

    const positions = [];
    for (const { id: naifId, name } of HELIO_PLANETS) {
      try {
        const { lon } = _computeHeliocentric(naifId, jdTdb);
        const adjLon = normAngle(lon - ayanamshaVal);
        positions.push({ name, lon: adjLon });
      } catch { /* skip */ }
    }

    const aspList = [];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const pA = positions[i], pB = positions[j];
        let sep = Math.abs(pA.lon - pB.lon) % 360;
        if (sep > 180) sep = 360 - sep;
        for (const def of ASPECT_DEFS_FULL) {
          const orb = Math.abs(sep - def.type);
          if (orb <= orbVal) aspList.push({ nameA: pA.name, nameB: pB.name, ...def, orb });
        }
      }
    }
    aspList.sort((a, b) => a.orb - b.orb);

    const zodiacLabel = zodiac === 'tropical' ? 'トロピカル' : zodiac === 'sidereal-lahiri' ? 'サイデリアル・ラーヒリー' : 'サイデリアル・フェーガン';
    const coordSuffix = _settings.coordSystem === 'j2000' ? ' / J2000.0' : ' / of-date';

    const posRows = positions.map(p =>
      `<tr><td>${p.name}</td><td>${lonToSign(p.lon)}</td><td>${p.lon.toFixed(3)}°</td></tr>`
    ).join('');
    const aspRows = aspList.map(a =>
      `<tr><td>${a.nameA}</td><td>${a.symbol} ${a.name}</td><td>${a.nameB}</td><td>${a.orb.toFixed(2)}°</td></tr>`
    ).join('');

    showResult('result-helio-chart', `
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
        ${dtVal.replace('T', ' ')} JST　|　地心投影日心　|　${zodiacLabel}${coordSuffix}　|　オーブ ±${orbVal}°
      </p>
      <h4 style="margin:0 0 8px;font-size:13px">▼ 惑星黄道座標（地心投影日心）</h4>
      <table class="result-table">
        <thead><tr><th>天体</th><th>星座</th><th>黄経</th></tr></thead>
        <tbody>${posRows}</tbody>
      </table>
      <h4 style="margin:12px 0 8px;font-size:13px">▼ アスペクト（${aspList.length} 件）</h4>
      <table class="result-table">
        <thead><tr><th>天体A</th><th>アスペクト</th><th>天体B</th><th>オーブ</th></tr></thead>
        <tbody>${aspRows || '<tr><td colspan="4" style="color:var(--text-muted)">アスペクトなし</td></tr>'}</tbody>
      </table>`);
  });

  // ── 3-3-2: 日心アスペクト時系列 ──────────────────────────────────────
  document.getElementById('form-helio-ts')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-helio-ts')) return;

    const startStr = document.getElementById('helio-ts-start').value;
    const endStr   = document.getElementById('helio-ts-end').value;
    const selA     = document.getElementById('helio-ts-a').value;
    const selB     = document.getElementById('helio-ts-b').value;

    if (selA === selB) {
      showResult('result-helio-ts', '惑星 A と B が同じです。異なる惑星を選択してください。', true);
      return;
    }

    const naifA = HELIO_NAIF_MAP[selA];
    const naifB = HELIO_NAIF_MAP[selB];
    const nameA = HELIO_PLANETS.find(p => p.id === naifA)?.name ?? selA;
    const nameB = HELIO_PLANETS.find(p => p.id === naifB)?.name ?? selB;

    const aspAngles = [...document.getElementById('helio-aspects-check')
      .querySelectorAll('input[type=checkbox]:checked')]
      .map(cb => parseInt(cb.value));

    if (aspAngles.length === 0) {
      showResult('result-helio-ts', 'アスペクトを1つ以上選択してください。', true);
      return;
    }

    const startJD = dateStrToJdUtcMidJst(startStr);
    const endJD   = dateStrToJdUtcMidJst(endStr) + 1.0;

    if (endJD - startJD > 366 * 5) {
      showResult('result-helio-ts', '計算期間は最大5年以内にしてください。', true);
      return;
    }

    showLoading('result-helio-ts', '計算中…', '日心アスペクトの通過時刻を二分探索');
    await yieldFrame();

    const calcFnA = jd => _computeHeliocentric(naifA, jdUtcToTdb(jd), { lonOnly: true });
    const calcFnB = jd => _computeHeliocentric(naifB, jdUtcToTdb(jd), { lonOnly: true });

    const allEvents = [];
    for (const aspAngle of aspAngles) {
      showLoading('result-helio-ts', '計算中…', `${aspAngle}° アスペクトを検索中`);
      await yieldFrame();

      const events = detectAspectCrossings(calcFnA, calcFnB, aspAngle, startJD, endJD, {
        stepDays: 0.5,
        precisionHours: 0.01,
      });
      const def = ASPECT_DEFS[aspAngle] ?? { name: `${aspAngle}°`, symbol: '' };
      for (const ev of events) {
        allEvents.push({ ...ev, ...def, aspAngle });
      }
    }
    allEvents.sort((a, b) => a.jd - b.jd);

    if (allEvents.length === 0) {
      showResult('result-helio-ts',
        `<p style="color:var(--text-muted)">指定期間にアスペクトなし（${startStr} 〜 ${endStr}）</p>`);
      return;
    }

    const rows = allEvents.map(ev =>
      `<tr>
        <td>${jdToJstStr(ev.jd)}</td>
        <td>${nameA}</td>
        <td>${ev.symbol} ${ev.name}（${ev.aspAngle}°）</td>
        <td>${nameB}</td>
        <td>${ev.lonA.toFixed(3)}°</td>
        <td>${ev.lonB.toFixed(3)}°</td>
      </tr>`
    ).join('');

    const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    showResult('result-helio-ts', `
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
        ${nameA} × ${nameB}　|　日心座標・${coordLabel}　|　${startStr} 〜 ${endStr}　|　${allEvents.length} 件
      </p>
      <table class="result-table">
        <thead><tr>
          <th>日時 (JST)</th><th>天体A</th><th>アスペクト</th><th>天体B</th>
          <th>黄経A</th><th>黄経B</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  });

}
