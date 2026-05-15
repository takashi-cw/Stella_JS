/**
 * ui-observation.js — 天体観測モード UI ハンドラ群
 *
 * 担当セクション（元 app.js L3982–L4812 相当）:
 *   1. 月相イベント
 *   2. 月相連続変化
 *   3. 太陽の出没時刻
 *   4. 月の出没時刻
 *   5. 天体風景（高度・方位）
 *   7. 24節気カレンダー
 *   基準物理天体暦（惑星物理位置）
 *
 * 使用方法:
 *   import { init } from './ui-observation.js';
 *   init({ computeApparent, computeFromCenter, requireBsp, settings });
 */

import {
  NAIF, jdUtcToTdb, dateToJd,
  obliquity, eclipticToEquatorial, altitudeAzimuth,
} from './index.js';

import {
  dateStrToJdUtcMidJst, azDir, jdToJstStr, jstInputToJdTdb,
  showResult, showLoading, yieldFrame, setProgress,
} from './ui-helpers.js';

import { buildTxtContent, downloadTxt } from './download.js';

// ── モジュールレベルの依存 ────────────────────────────────────────────────
let _computeApparent;
let _computeFromCenter;
let _requireBsp;
let _settings;

/**
 * モジュールの初期化 — イベントハンドラを登録する
 */
export function init(deps) {
  _computeApparent    = deps.computeApparent;
  _computeFromCenter  = deps.computeFromCenter;
  _requireBsp         = deps.requireBsp;
  _settings           = deps.settings;
  _registerHandlers();
}

// ── 月相定数 ──────────────────────────────────────────────────────────────

const PHASE_NAMES_8 = Object.freeze([
  '新月', '三日月', '上弦の月', '十三夜月', '満月', '寝待月', '下弦の月', '有明月',
]);
const PHASE_ANGLES_8 = Object.freeze([0, 45, 90, 135, 180, 225, 270, 315]);
const PHASE_ILLUM_8  = Object.freeze([0.0, 14.6, 50.0, 85.4, 100.0, 85.4, 50.0, 14.6]);
const PHASE_DESC_8   = Object.freeze([
  '朔（月-太陽 合）', '月-太陽角 45°', '上弦（月-太陽角 90°）', '月-太陽角 135°',
  '望（月-太陽 衝）', '月-太陽角 225°', '下弦（月-太陽角 270°）', '月-太陽角 315°',
]);
const SYNODIC_MONTH = 29.530589;

// ── 24節気定数 ─────────────────────────────────────────────────────────────

const SOLAR_TERMS_24 = Object.freeze([
  { lon: 315, name: '立春', kana: 'りっしゅん', en: 'Start of Spring'      },
  { lon: 330, name: '雨水', kana: 'うすい',     en: 'Rain Water'           },
  { lon: 345, name: '啓蟄', kana: 'けいちつ',   en: 'Awakening of Insects' },
  { lon:   0, name: '春分', kana: 'しゅんぶん', en: 'Vernal Equinox'       },
  { lon:  15, name: '清明', kana: 'せいめい',   en: 'Clear and Bright'     },
  { lon:  30, name: '穀雨', kana: 'こくう',     en: 'Grain Rain'           },
  { lon:  45, name: '立夏', kana: 'りっか',     en: 'Start of Summer'      },
  { lon:  60, name: '小満', kana: 'しょうまん', en: 'Grain Buds'           },
  { lon:  75, name: '芒種', kana: 'ぼうしゅ',   en: 'Grain in Ear'         },
  { lon:  90, name: '夏至', kana: 'げし',       en: 'Summer Solstice'      },
  { lon: 105, name: '小暑', kana: 'しょうしょ', en: 'Minor Heat'           },
  { lon: 120, name: '大暑', kana: 'たいしょ',   en: 'Major Heat'           },
  { lon: 135, name: '立秋', kana: 'りっしゅう', en: 'Start of Autumn'      },
  { lon: 150, name: '処暑', kana: 'しょしょ',   en: 'End of Heat'          },
  { lon: 165, name: '白露', kana: 'はくろ',     en: 'White Dew'            },
  { lon: 180, name: '秋分', kana: 'しゅうぶん', en: 'Autumnal Equinox'     },
  { lon: 195, name: '寒露', kana: 'かんろ',     en: 'Cold Dew'             },
  { lon: 210, name: '霜降', kana: 'そうこう',   en: "Frost's Descent"      },
  { lon: 225, name: '立冬', kana: 'りっとう',   en: 'Start of Winter'      },
  { lon: 240, name: '小雪', kana: 'しょうせつ', en: 'Minor Snow'           },
  { lon: 255, name: '大雪', kana: 'たいせつ',   en: 'Major Snow'           },
  { lon: 270, name: '冬至', kana: 'とうじ',     en: 'Winter Solstice'      },
  { lon: 285, name: '小寒', kana: 'しょうかん', en: 'Minor Cold'           },
  { lon: 300, name: '大寒', kana: 'だいかん',   en: 'Major Cold'           },
]);

// ── 天体風景 — 天体リスト ─────────────────────────────────────────────────

const LANDSCAPE_BODIES = Object.freeze([
  { id: NAIF.SUN,                name: '太陽'   },
  { id: NAIF.MOON,               name: '月'     },
  { id: NAIF.MERCURY_BARYCENTER, name: '水星'   },
  { id: NAIF.VENUS_BARYCENTER,   name: '金星'   },
  { id: NAIF.MARS_BARYCENTER,    name: '火星'   },
  { id: NAIF.JUPITER_BARYCENTER, name: '木星'   },
  { id: NAIF.SATURN_BARYCENTER,  name: '土星'   },
  { id: NAIF.URANUS_BARYCENTER,  name: '天王星' },
  { id: NAIF.NEPTUNE_BARYCENTER, name: '海王星' },
  { id: NAIF.PLUTO_BARYCENTER,   name: '冥王星' },
]);

// ── 物理天体暦 定数 ───────────────────────────────────────────────────────

const PHYS_PLANETS_ALL = Object.freeze([
  { id: NAIF.SUN,                name: '太陽'   },
  { id: NAIF.MOON,               name: '月'     },
  { id: NAIF.MERCURY_BARYCENTER, name: '水星'   },
  { id: NAIF.VENUS_BARYCENTER,   name: '金星'   },
  { id: NAIF.EARTH,              name: '地球'   },
  { id: NAIF.MARS_BARYCENTER,    name: '火星'   },
  { id: NAIF.JUPITER_BARYCENTER, name: '木星'   },
  { id: NAIF.SATURN_BARYCENTER,  name: '土星'   },
  { id: NAIF.URANUS_BARYCENTER,  name: '天王星' },
  { id: NAIF.NEPTUNE_BARYCENTER, name: '海王星' },
  { id: NAIF.PLUTO_BARYCENTER,   name: '冥王星' },
]);

const PHYS_STEP_JD    = { '1h': 1 / 24, '6h': 0.25, '1d': 1.0, '3d': 3.0, '7d': 7.0 };
const PHYS_STEP_LABEL = { '1h': '1時間', '6h': '6時間', '1d': '1日', '3d': '3日', '7d': '7日' };

// ── BSP 依存計算関数 ──────────────────────────────────────────────────────

function _bodyAltitude(naifId, jdUtc, lat, lon, elev = 0) {
  const jdTdb       = jdUtcToTdb(jdUtc);
  const observer    = { lat, lon, elev };
  const body        = _computeApparent(naifId, jdTdb, { jdUtc, observer });
  const eps         = obliquity(jdTdb);
  const { ra, dec } = eclipticToEquatorial(body.lon, body.lat, eps);
  return altitudeAzimuth(ra, dec, jdUtc, lat, lon).alt;
}

function _bodyAltAz(naifId, jdUtc, lat, lon, elev = 0) {
  const jdTdb       = jdUtcToTdb(jdUtc);
  const observer    = { lat, lon, elev };
  const body        = _computeApparent(naifId, jdTdb, { jdUtc, observer });
  const eps         = obliquity(jdTdb);
  const { ra, dec } = eclipticToEquatorial(body.lon, body.lat, eps);
  const { alt, az } = altitudeAzimuth(ra, dec, jdUtc, lat, lon);
  return { alt, az, dist: body.dist, eclLon: body.lon };
}

function _findRiseTransitSet(naifId, dayJdUtc, lat, lon, horizon = -0.833) {
  const STEP = 15 / 1440;

  const samples = [];
  for (let t = dayJdUtc; t <= dayJdUtc + 1.0; t += STEP) {
    samples.push({ jd: t, alt: _bodyAltitude(naifId, t, lat, lon) });
  }

  let maxAlt = -Infinity, maxIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].alt > maxAlt) { maxAlt = samples[i].alt; maxIdx = i; }
  }
  let transitJd = samples[maxIdx].jd, transitAlt = maxAlt;
  if (maxIdx > 0 && maxIdx < samples.length - 1) {
    const a1 = samples[maxIdx - 1].alt;
    const a2 = samples[maxIdx].alt;
    const a3 = samples[maxIdx + 1].alt;
    const denom = 2 * (a1 - 2 * a2 + a3);
    if (Math.abs(denom) > 1e-9) {
      transitJd  = samples[maxIdx].jd + (a1 - a3) / denom * STEP;
      transitAlt = _bodyAltitude(naifId, transitJd, lat, lon);
    }
  }

  const minAlt     = Math.min(...samples.map(s => s.alt));
  const polarDay   = minAlt  > horizon;
  const polarNight = maxAlt  < horizon;

  function bisect(lo, hi) {
    if ((_bodyAltitude(naifId, lo, lat, lon) - horizon) *
        (_bodyAltitude(naifId, hi, lat, lon) - horizon) > 0) return null;
    let a = lo, b = hi;
    for (let i = 0; i < 50; i++) {
      const mid = (a + b) / 2;
      if ((_bodyAltitude(naifId, a, lat, lon) - horizon) *
          (_bodyAltitude(naifId, mid, lat, lon) - horizon) <= 0) {
        b = mid;
      } else {
        a = mid;
      }
      if (b - a < 0.5 / 86400) break;
    }
    return (a + b) / 2;
  }

  let riseJd = null, setJd = null;
  for (let i = 0; i < samples.length - 1 && samples[i].jd <= transitJd; i++) {
    if (samples[i].alt - horizon < 0 && samples[i + 1].alt - horizon > 0) {
      riseJd = bisect(samples[i].jd, samples[i + 1].jd);
      break;
    }
  }
  for (let i = samples.length - 2; i >= 0 && samples[i + 1].jd >= transitJd; i--) {
    if (samples[i].alt - horizon > 0 && samples[i + 1].alt - horizon < 0) {
      setJd = bisect(samples[i].jd, samples[i + 1].jd);
      break;
    }
  }

  return { riseJd, transitJd, transitAlt, setJd, polarDay, polarNight };
}

// ── 純粋計算関数 ──────────────────────────────────────────────────────────

function _calculateMoonPhases(startJdUtc, endJdUtc) {
  const SUN = NAIF.SUN, MOON = NAIF.MOON;

  function phaseAngle(jd) {
    const t  = jdUtcToTdb(jd);
    const mL = _computeApparent(MOON, t).lon;
    const sL = _computeApparent(SUN, t).lon;
    return ((mL - sL) % 360 + 360) % 360;
  }
  function dev(jd, target) {
    return ((phaseAngle(jd) - target + 180 + 360) % 360) - 180;
  }

  const STEP = 3.5;
  const events = [];

  for (let jd = startJdUtc; jd < endJdUtc; jd += STEP) {
    const nj = Math.min(jd + STEP, endJdUtc);
    for (let k = 0; k < PHASE_ANGLES_8.length; k++) {
      const target = PHASE_ANGLES_8[k];
      const d0 = dev(jd, target), d1 = dev(nj, target);
      if (d0 * d1 >= 0 || Math.abs(d1 - d0) >= 180) continue;
      let lo = jd, hi = nj;
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (dev(lo, target) * dev(mid, target) <= 0) hi = mid; else lo = mid;
        if (hi - lo < 0.5 / 86400) break;
      }
      const eJd = (lo + hi) / 2;
      if (eJd < startJdUtc || eJd > endJdUtc) continue;
      events.push({
        jd: eJd, phaseIdx: k,
        phaseName:    PHASE_NAMES_8[k],
        angle:        target,
        illumination: PHASE_ILLUM_8[k],
        moonAge:      target / 360 * SYNODIC_MONTH,
        description:  PHASE_DESC_8[k],
      });
    }
  }
  events.sort((a, b) => a.jd - b.jd);
  return events;
}

function _calculateMoonPhaseContinuous(startJdUtc, endJdUtc, intervalHours) {
  const SUN = NAIF.SUN, MOON = NAIF.MOON;
  const stepJd = intervalHours / 24;
  const records = [];
  let prevIdx = null;

  for (let jd = startJdUtc; jd <= endJdUtc; jd += stepJd) {
    const t     = jdUtcToTdb(jd);
    const mL    = _computeApparent(MOON, t).lon;
    const sL    = _computeApparent(SUN,  t).lon;
    const angle = ((mL - sL) % 360 + 360) % 360;
    const illum = (1 - Math.cos(angle * Math.PI / 180)) / 2 * 100;
    const age   = angle / 360 * SYNODIC_MONTH;
    const phIdx = Math.floor(angle / 45) % 8;
    records.push({
      jd, angle, illum, moonAge: age, phaseIdx: phIdx,
      phaseName:    PHASE_NAMES_8[phIdx],
      isTransition: prevIdx !== null && phIdx !== prevIdx,
    });
    prevIdx = phIdx;
  }
  return records;
}

function _calculateSolarTerms(year) {
  const SUN = NAIF.SUN;

  function dev(jdUtc, target) {
    const lon = _computeApparent(SUN, jdUtcToTdb(jdUtc)).lon;
    return ((lon - target + 180 + 360) % 360) - 180;
  }

  const searchStart = dateStrToJdUtcMidJst(`${year - 1}-12-20`);
  const searchEnd   = dateStrToJdUtcMidJst(`${year + 1}-01-10`);
  const yearStart   = dateStrToJdUtcMidJst(`${year}-01-01`);
  const yearEnd     = dateStrToJdUtcMidJst(`${year}-12-31`) + 1.0;
  const STEP = 10;
  const events = [];

  for (let jd = searchStart; jd < searchEnd; jd += STEP) {
    const nj = Math.min(jd + STEP, searchEnd);
    for (const term of SOLAR_TERMS_24) {
      const d0 = dev(jd, term.lon), d1 = dev(nj, term.lon);
      if (d0 * d1 >= 0 || Math.abs(d1 - d0) >= 180) continue;
      let lo = jd, hi = nj;
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (dev(lo, term.lon) * dev(mid, term.lon) <= 0) hi = mid; else lo = mid;
        if (hi - lo < 0.5 / 86400) break;
      }
      const eJd = (lo + hi) / 2;
      if (eJd < yearStart || eJd > yearEnd) continue;
      events.push({ jd: eJd, ...term });
    }
  }
  events.sort((a, b) => a.jd - b.jd);
  return events;
}

// ── イベントハンドラ登録 ──────────────────────────────────────────────────

function _registerHandlers() {

  const ICONS = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

  // ── 1. 月相イベント ──────────────────────────────────────────────────
  document.getElementById('form-moon-phase')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-moon-phase')) return;

    const startStr = document.getElementById('moon-phase-start').value;
    const endStr   = document.getElementById('moon-phase-end').value;

    showLoading('result-moon-phase', '計算中…');
    await yieldFrame();

    try {
      const startJd = dateStrToJdUtcMidJst(startStr);
      const endJd   = dateStrToJdUtcMidJst(endStr) + 1.0;
      const events  = _calculateMoonPhases(startJd, endJd);

      if (events.length === 0) {
        document.getElementById('result-moon-phase').innerHTML =
          '<p>指定期間内に月相イベントはありませんでした。</p>';
        return;
      }

      const rows = events.map((ev, i) => {
        const s = jdToJstStr(ev.jd);
        return `<tr>
          <td>${i + 1}</td>
          <td>${s.substring(0, 10)}</td>
          <td>${s.substring(11, 22)}</td>
          <td>${ICONS[ev.phaseIdx]} ${ev.phaseName}</td>
          <td style="text-align:right">${ev.moonAge.toFixed(1)}</td>
          <td style="text-align:right">${ev.angle}°</td>
          <td style="text-align:right">${ev.illumination.toFixed(1)}%</td>
          <td style="font-size:11px;color:var(--text-muted)">${ev.description}</td>
        </tr>`;
      }).join('');

      document.getElementById('result-moon-phase').innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
          期間: ${startStr} 〜 ${endStr} JST　合計 ${events.length} 件
        </p>
        <table class="result-table">
          <thead><tr>
            <th>No.</th><th>日付</th><th>時刻 (JST)</th><th>月相</th>
            <th>月齢 [日]</th><th>位相角</th><th>照度率</th><th>説明</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch (err) {
      document.getElementById('result-moon-phase').innerHTML =
        `<p style="color:var(--error)">エラー: ${err.message}</p>`;
    }
  });

  // ── 2. 月相連続変化 ──────────────────────────────────────────────────
  document.getElementById('form-moon-cont')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-moon-cont')) return;

    const startStr  = document.getElementById('moon-cont-start').value;
    const endStr    = document.getElementById('moon-cont-end').value;
    const intervalH = Number(document.getElementById('moon-cont-interval').value);

    showLoading('result-moon-cont', '計算中…');
    await yieldFrame();

    try {
      const startJd = dateStrToJdUtcMidJst(startStr);
      const endJd   = dateStrToJdUtcMidJst(endStr) + 1.0;
      const records = _calculateMoonPhaseContinuous(startJd, endJd, intervalH);

      const rows = records.map(r => {
        const s = jdToJstStr(r.jd);
        const border = r.isTransition ? ' style="border-top:2px solid var(--accent)"' : '';
        return `<tr${border}>
          <td>${s.substring(0, 16)}</td>
          <td>${ICONS[r.phaseIdx]} ${r.phaseName}</td>
          <td style="text-align:right">${r.angle.toFixed(1)}°</td>
          <td style="text-align:right">${r.illum.toFixed(1)}%</td>
          <td style="text-align:right">${r.moonAge.toFixed(1)}</td>
        </tr>`;
      }).join('');

      document.getElementById('result-moon-cont').innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
          期間: ${startStr} 〜 ${endStr} JST　間隔: ${intervalH}時間ごと　${records.length} 件
        </p>
        <table class="result-table">
          <thead><tr>
            <th>日時 (JST)</th><th>月相</th><th>位相角</th><th>照度率</th><th>月齢 [日]</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch (err) {
      document.getElementById('result-moon-cont').innerHTML =
        `<p style="color:var(--error)">エラー: ${err.message}</p>`;
    }
  });

  // ── 3. 太陽の出没時刻 ────────────────────────────────────────────────
  document.getElementById('form-sunrise')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-sunrise')) return;

    const startStr = document.getElementById('sunrise-start').value;
    const endStr   = document.getElementById('sunrise-end').value;
    const lat      = Number(document.getElementById('sunrise-lat').value);
    const lon      = Number(document.getElementById('sunrise-lon').value);
    const resultEl = document.getElementById('result-sunrise');

    const dayCount = Math.round((new Date(endStr) - new Date(startStr)) / 86400000) + 1;
    if (dayCount > 365) {
      resultEl.innerHTML = '<p style="color:var(--warning)">期間は365日以内に設定してください。</p>';
      resultEl.className = 'result-area visible';
      return;
    }

    showLoading('result-sunrise', '計算中…', `${dayCount}日分を計算`);
    await yieldFrame();

    try {
      const SUN  = NAIF.SUN;
      const rows = [];
      let cur = new Date(startStr + 'T00:00:00Z');
      const end = new Date(endStr + 'T00:00:00Z');

      while (cur <= end) {
        const ds    = cur.toISOString().substring(0, 10);
        const dayJd = dateStrToJdUtcMidJst(ds);
        const rs    = _findRiseTransitSet(SUN, dayJd, lat, lon);

        const rStr = rs.riseJd  ? jdToJstStr(rs.riseJd).substring(11, 19)    : (rs.polarDay ? '白夜' : '極夜');
        const tStr = jdToJstStr(rs.transitJd).substring(11, 19);
        const sStr = rs.setJd   ? jdToJstStr(rs.setJd).substring(11, 19)     : (rs.polarDay ? '白夜' : '極夜');
        const aStr = `${rs.transitAlt.toFixed(1)}°`;

        rows.push(`<tr>
          <td>${ds.replace(/-/g, '/')}</td>
          <td>${rStr}</td><td>${tStr}</td>
          <td style="text-align:center">${aStr}</td>
          <td>${sStr}</td>
        </tr>`);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      resultEl.innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
          期間: ${startStr} 〜 ${endStr} JST　緯度 ${lat}°　経度 ${lon}°
        </p>
        <table class="result-table">
          <thead><tr>
            <th>日付</th><th>日の出</th><th>南中</th><th style="text-align:center">南中高度</th><th>日の入</th>
          </tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>`;
    } catch (err) {
      document.getElementById('result-sunrise').innerHTML =
        `<p style="color:var(--error)">エラー: ${err.message}</p>`;
    }
  });

  // ── 4. 月の出没時刻 ──────────────────────────────────────────────────
  document.getElementById('form-moonrise')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-moonrise')) return;

    const startStr = document.getElementById('moonrise-start').value;
    const endStr   = document.getElementById('moonrise-end').value;
    const lat      = Number(document.getElementById('moonrise-lat').value);
    const lon      = Number(document.getElementById('moonrise-lon').value);
    const resultEl = document.getElementById('result-moonrise');

    const dayCount = Math.round((new Date(endStr) - new Date(startStr)) / 86400000) + 1;
    if (dayCount > 90) {
      resultEl.innerHTML = '<p style="color:var(--warning)">月の出没は90日以内に設定してください。</p>';
      resultEl.className = 'result-area visible';
      return;
    }

    showLoading('result-moonrise', '計算中…', `${dayCount}日分を計算`);
    await yieldFrame();

    try {
      const MOON = NAIF.MOON;
      const rows = [];
      let cur = new Date(startStr + 'T00:00:00Z');
      const end = new Date(endStr + 'T00:00:00Z');

      while (cur <= end) {
        const ds    = cur.toISOString().substring(0, 10);
        const dayJd = dateStrToJdUtcMidJst(ds);
        const rs    = _findRiseTransitSet(MOON, dayJd, lat, lon);

        const rStr = rs.riseJd ? jdToJstStr(rs.riseJd).substring(11, 19) : (rs.polarDay ? '常時' : '---');
        const tStr = jdToJstStr(rs.transitJd).substring(11, 19);
        const sStr = rs.setJd  ? jdToJstStr(rs.setJd).substring(11, 19)  : (rs.polarDay ? '常時' : '---');
        const aStr = `${rs.transitAlt.toFixed(1)}°`;

        rows.push(`<tr>
          <td>${ds.replace(/-/g, '/')}</td>
          <td>${rStr}</td><td>${tStr}</td>
          <td style="text-align:center">${aStr}</td>
          <td>${sStr}</td>
        </tr>`);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      resultEl.innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
          期間: ${startStr} 〜 ${endStr} JST　緯度 ${lat}°　経度 ${lon}°
        </p>
        <table class="result-table">
          <thead><tr>
            <th>日付</th><th>月の出</th><th>南中</th><th style="text-align:center">南中高度</th><th>月の入</th>
          </tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>`;
    } catch (err) {
      document.getElementById('result-moonrise').innerHTML =
        `<p style="color:var(--error)">エラー: ${err.message}</p>`;
    }
  });

  // ── 5. 天体風景（高度・方位） ─────────────────────────────────────────
  document.getElementById('form-landscape')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-landscape')) return;

    const dtStr    = document.getElementById('landscape-datetime').value;
    const lat      = Number(document.getElementById('landscape-lat').value);
    const lon      = Number(document.getElementById('landscape-lon').value);

    showLoading('result-landscape', '計算中…');
    await yieldFrame();

    try {
      const [datePart, timePart = '00:00'] = dtStr.split('T');
      const [y, m, d] = datePart.split('-').map(Number);
      const [hh, mm]  = timePart.split(':').map(Number);
      const jdUtcVal  = dateToJd(y, m, d + (hh - 9 + mm / 60) / 24);

      const results = LANDSCAPE_BODIES.map(body => {
        const { alt, az, dist, eclLon } = _bodyAltAz(body.id, jdUtcVal, lat, lon);
        return { name: body.name, alt, az, dist, eclLon };
      });
      const above = results.filter(r => r.alt >= 0).length;

      const rows = results.map(r => {
        return `<tr>
          <td>${r.name}</td>
          <td style="color:${r.alt >= 0 ? 'var(--accent)' : 'var(--text-muted)'}">
            ${r.alt >= 0 ? '地平線上' : '地平線下'}
          </td>
          <td style="text-align:center">${r.alt >= 0 ? '+' : ''}${r.alt.toFixed(2)}°</td>
          <td>${azDir(r.az)}</td>
          <td style="text-align:center">${r.az.toFixed(2)}°</td>
        </tr>`;
      }).join('');

      document.getElementById('result-landscape').innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
          日時: ${dtStr.replace('T', ' ')} JST　緯度 ${lat}°　経度 ${lon}°<br>
          地平線上: ${above} 個 / 地平線下: ${results.length - above} 個
        </p>
        <table class="result-table">
          <thead><tr>
            <th>天体</th><th>状態</th><th style="text-align:center">高度</th><th>方角</th><th style="text-align:center">方位角</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch (err) {
      document.getElementById('result-landscape').innerHTML =
        `<p style="color:var(--error)">エラー: ${err.message}</p>`;
    }
  });

  // ── 7. 24節気カレンダー ──────────────────────────────────────────────
  document.getElementById('form-sekki')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-sekki')) return;

    const year     = Number(document.getElementById('sekki-year').value);

    showLoading('result-sekki', '計算中…');
    await yieldFrame();

    try {
      const events = _calculateSolarTerms(year);
      const KEY_LONS = new Set([0, 90, 180, 270]);

      const rows = events.map((ev, i) => {
        const s     = jdToJstStr(ev.jd);
        const isKey = KEY_LONS.has(ev.lon);
        const rowStyle = isKey ? ' style="background:rgba(100,120,255,0.12)"' : '';
        return `<tr${rowStyle}>
          <td>${i + 1}</td>
          <td>${s.substring(0, 10)}</td>
          <td>${s.substring(11, 22)}</td>
          <td style="font-weight:${isKey ? 'bold' : 'normal'}">${ev.name}</td>
          <td style="font-size:11px;color:var(--text-muted)">${ev.kana}</td>
          <td style="text-align:right">${ev.lon}°</td>
          <td style="font-size:11px;color:var(--text-muted)">${ev.en}</td>
        </tr>`;
      }).join('');

      document.getElementById('result-sekki').innerHTML = `
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
          ${year}年 24節気一覧　計 ${events.length} 件（春分・夏至・秋分・冬至 太字）
        </p>
        <table class="result-table">
          <thead><tr>
            <th>No.</th><th>日付</th><th>時刻 (JST)</th><th>節気</th>
            <th>読み</th><th>黄経</th><th>英語名</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch (err) {
      document.getElementById('result-sekki').innerHTML =
        `<p style="color:var(--error)">エラー: ${err.message}</p>`;
    }
  });

  // ── 物理天体暦（惑星位置） ────────────────────────────────────────────
  document.getElementById('form-phys-planet')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-phys-planet')) return;

    const centerNaifId = NAIF.EARTH;
    const centerLabel  = '地心（地球）';
    const centerName   = '地球';

    const startVal  = document.getElementById('phys-start').value;
    const endVal    = document.getElementById('phys-end').value;
    const stepKey   = document.getElementById('phys-step').value;
    const planetVal = document.getElementById('phys-planet').value;

    const stepJd    = PHYS_STEP_JD[stepKey]    ?? 1.0;
    const stepLabel = PHYS_STEP_LABEL[stepKey] ?? '1日';

    const startJdTdb = jstInputToJdTdb(startVal);
    const endJdTdb   = jstInputToJdTdb(endVal);

    if (endJdTdb <= startJdTdb) {
      showResult('result-phys-planet', '終了日時は開始日時より後に設定してください。', true);
      return;
    }

    let selectedPlanets;
    if (planetVal === 'all') {
      selectedPlanets = PHYS_PLANETS_ALL.filter(p => p.id !== NAIF.EARTH);
    } else {
      const pid   = parseInt(planetVal, 10);
      const found = PHYS_PLANETS_ALL.find(p => p.id === pid);
      if (!found) { showResult('result-phys-planet', '対象天体が不明です。', true); return; }
      selectedPlanets = [found];
    }

    const nSteps    = Math.floor((endJdTdb - startJdTdb) / stepJd + 0.001) + 1;
    const totalRows = nSteps * selectedPlanets.length;
    if (totalRows > 5000 && !confirm(
      `推定出力行数: ${totalRows.toLocaleString()} 行\n` +
      (totalRows > 20000 ? '非常に多い行数です。計算に時間がかかる場合があります。\n' : '') +
      '続行しますか？'
    )) return;

    showLoading('result-phys-planet', '計算中… 0%', selectedPlanets[0].name);
    await yieldFrame();

    const coordSuffix = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';

    const rows = [];
    let completedSteps = 0;
    let lastYieldTime  = Date.now();

    for (const planet of selectedPlanets) {
      const positions = [];
      for (let i = 0; i < nSteps; i++) {
        const jd = startJdTdb + i * stepJd;
        try {
          const pos = _computeFromCenter(planet.id, centerNaifId, jd);
          positions.push({ jd, lon: pos.lon, lat: pos.lat, dist: pos.dist });
        } catch {
          positions.push({ jd, lon: null, lat: null, dist: null });
        }

        completedSteps++;
        const now = Date.now();
        if (now - lastYieldTime > 100) {
          setProgress('result-phys-planet', (completedSteps / totalRows) * 100, planet.name);
          await yieldFrame();
          lastYieldTime = Date.now();
        }
      }
      setProgress('result-phys-planet', (completedSteps / totalRows) * 100, planet.name);
      await yieldFrame();

      for (let i = 0; i < positions.length; i++) {
        const cur = positions[i];
        if (cur.lon === null) continue;

        let speed = 0;
        const prev = i > 0 ? positions[i - 1] : null;
        const next = i < positions.length - 1 ? positions[i + 1] : null;

        if (prev?.lon != null && next?.lon != null) {
          let d = next.lon - prev.lon;
          if (d >  180) d -= 360;
          if (d < -180) d += 360;
          speed = d / (2 * stepJd);
        } else if (next?.lon != null) {
          let d = next.lon - cur.lon;
          if (d >  180) d -= 360;
          if (d < -180) d += 360;
          speed = d / stepJd;
        } else if (prev?.lon != null) {
          let d = cur.lon - prev.lon;
          if (d >  180) d -= 360;
          if (d < -180) d += 360;
          speed = d / stepJd;
        }

        rows.push({
          jst:    jdToJstStr(cur.jd),
          planet: planet.name,
          lon:    cur.lon,
          speed,
          lat:    cur.lat,
          dist:   cur.dist,
        });
      }
    }

    if (rows.length === 0) {
      showResult('result-phys-planet', 'データが取得できませんでした（天体暦の範囲外の可能性があります）。', true);
      return;
    }

    const coordLabel   = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    const planetsLabel = planetVal === 'all'
      ? `全惑星（${selectedPlanets.map(p => p.name).join('・')}）`
      : selectedPlanets[0].name;
    const txtMeta = {
      ephemeris:   `JPL DE天体再定義暦『${centerName}基準物理天体暦』`,
      center:      centerLabel,
      coordLabel:  `${coordLabel} 黄道`,
      aberration:  'なし（幾何学的位置・光行時間補正のみ）※年周光行差未補正のため視位置と最大約20"差あり',
      planets:     planetsLabel,
      step:        stepLabel,
      period:      `${startVal.replace('T', ' ')} 〜 ${endVal.replace('T', ' ')} JST`,
    };
    const txtContent = buildTxtContent(rows, txtMeta);

    const startTag    = startVal.replace('T', '_').replace(/[-:]/g, '');
    const endTag      = endVal.replace('T', '_').replace(/[-:]/g, '');
    const txtFilename = `planet_physics_${centerName}_${coordLabel}_${stepKey}_${startTag}_${endTag}.txt`;

    const previewRows = rows.slice(0, 100);
    const tableRows   = previewRows.map(r =>
      `<tr>
        <td style="white-space:nowrap">${r.jst}</td>
        <td>${r.planet}</td>
        <td>${r.lon.toFixed(4)}</td>
        <td style="color:${r.speed < 0 ? 'var(--accent)' : 'inherit'}">${(r.speed >= 0 ? '+' : '') + r.speed.toFixed(4)}</td>
        <td>${(r.lat >= 0 ? '+' : '') + r.lat.toFixed(4)}</td>
        <td>${r.dist.toFixed(6)}</td>
      </tr>`
    ).join('');

    const moreMsg = rows.length > 100
      ? `<p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">▲ 先頭 100 行を表示（全 ${rows.length.toLocaleString()} 行）。.txt ダウンロードで全件取得。</p>`
      : '';

    showResult('result-phys-planet', `
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 10px">
        <strong>天体暦:</strong> JPL DE天体再定義暦『${centerName}基準物理天体暦』<br>
        <strong>観測中心:</strong> ${centerLabel} &nbsp;|&nbsp;
        <strong>座標系:</strong> ${coordLabel} 黄道 &nbsp;|&nbsp;
        <strong>ステップ:</strong> ${stepLabel} &nbsp;|&nbsp;
        <strong>出力:</strong> ${rows.length.toLocaleString()} 行
      </p>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <button id="btn-phys-txt" class="dl-btn">⬇ .txt ダウンロード（全件）</button>
        <span style="font-size:11px;color:var(--text-muted)">UTF-8 タブ区切り</span>
      </div>
      <table class="result-table">
        <thead>
          <tr><th>JST日時</th><th>天体</th><th>黄経(deg)</th><th>角速度(deg/day)</th><th>黄緯(deg)</th><th>距離(AU)</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${moreMsg}`);

    document.getElementById('btn-phys-txt')?.addEventListener('click', () => {
      downloadTxt(txtFilename, txtContent);
    });
  });

}
