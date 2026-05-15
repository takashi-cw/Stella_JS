/**
 * ui-astro-calc.js — 天文計算メニュー UI ハンドラ群
 *
 * 担当セクション（元 app.js L898–L1901 相当）:
 *   - 逆行期間計算（2種: 占星術向け / 天文学向け）
 *   - 逆行連続物理量計算
 *   - 惑星間アスペクト時系列
 *   - 太陽黄経暦（1° 刻み）
 *   - 任意境界角度通過検出
 *   - ヘリオセントリック計算（日心座標）
 *   - 惑星位置計算（地心・現在時刻）
 *
 * 使用方法:
 *   import { init } from './ui-astro-calc.js';
 *   init({ computeApparent, computeHeliocentric, requireBsp, settings });
 */

import {
  NAIF, AVG_SPEEDS, AU_KM, jdUtcToTdb, normAngularDiff,
} from './index.js';

import {
  datetimeLocalToJdTdb, jstInputToJdTdb, jdToJstStr,
  trunc3, lonToSign, lonToIauConstellation,
  showResult, showLoading, yieldFrame,
  dateStrToJdUtcMidJst,
  makeRetroCalcFn, detectAllStations, groupRetrogradePeriods,
  GEOCENTRIC_PLANETS, ASPECT_DEFS,
  detectBoundaryCrossings, detectAspectCrossings,
} from './ui-helpers.js';

// ── モジュールレベルの依存 ─────────────────────────────────────────────────
// init() で注入される BSP 依存関数と設定オブジェクトを保持する
let _computeApparent;
let _computeHeliocentric;
let _requireBsp;
let _settings;

/**
 * モジュールの初期化 — イベントハンドラを登録する
 * @param {{ computeApparent, computeHeliocentric, requireBsp, settings }} deps
 */
export function init(deps) {
  _computeApparent    = deps.computeApparent;
  _computeHeliocentric = deps.computeHeliocentric;
  _requireBsp         = deps.requireBsp;
  _settings           = deps.settings;
  _registerHandlers();
}

// ── 定数 ──────────────────────────────────────────────────────────────────
// GEOCENTRIC_PLANETS は ui-helpers.js から import 済み

// select の value は NAIF barycenter コードと一致する（1=水星, 2=金星...）
const RETRO_PLANET_INFO = Object.freeze({
  1: { naifId: NAIF.MERCURY_BARYCENTER, name: '水星',   speedKey: 'Mercury' },
  2: { naifId: NAIF.VENUS_BARYCENTER,   name: '金星',   speedKey: 'Venus'   },
  4: { naifId: NAIF.MARS_BARYCENTER,    name: '火星',   speedKey: 'Mars'    },
  5: { naifId: NAIF.JUPITER_BARYCENTER, name: '木星',   speedKey: 'Jupiter' },
  6: { naifId: NAIF.SATURN_BARYCENTER,  name: '土星',   speedKey: 'Saturn'  },
  7: { naifId: NAIF.URANUS_BARYCENTER,  name: '天王星', speedKey: 'Uranus'  },
  8: { naifId: NAIF.NEPTUNE_BARYCENTER, name: '海王星', speedKey: 'Neptune' },
  9: { naifId: NAIF.PLUTO_BARYCENTER,   name: '冥王星', speedKey: 'Pluto'   },
});

// ASPECT_DEFS は ui-helpers.js から import 済み

const ASP_PLANET_MAP = Object.freeze({
  [NAIF.SUN]:               { name: '太陽',   speedKey: 'Sun'     },
  [NAIF.MOON]:              { name: '月',     speedKey: 'Moon'    },
  [NAIF.MERCURY_BARYCENTER]:{ name: '水星',   speedKey: 'Mercury' },
  [NAIF.VENUS_BARYCENTER]:  { name: '金星',   speedKey: 'Venus'   },
  [NAIF.MARS_BARYCENTER]:   { name: '火星',   speedKey: 'Mars'    },
  [NAIF.JUPITER_BARYCENTER]:{ name: '木星',   speedKey: 'Jupiter' },
  [NAIF.SATURN_BARYCENTER]: { name: '土星',   speedKey: 'Saturn'  },
  [NAIF.URANUS_BARYCENTER]: { name: '天王星', speedKey: 'Uranus'  },
  [NAIF.NEPTUNE_BARYCENTER]:{ name: '海王星', speedKey: 'Neptune' },
  [NAIF.PLUTO_BARYCENTER]:  { name: '冥王星', speedKey: 'Pluto'   },
});

/** 24節気: 黄経（度）→ { name, nodeType } */
const SOLAR_TERMS_BY_LON = Object.freeze({
  0:   { name: '春分', nodeType: '中気' },
  15:  { name: '清明', nodeType: '節'   },
  30:  { name: '穀雨', nodeType: '中気' },
  45:  { name: '立夏', nodeType: '節'   },
  60:  { name: '小満', nodeType: '中気' },
  75:  { name: '芒種', nodeType: '節'   },
  90:  { name: '夏至', nodeType: '中気' },
  105: { name: '小暑', nodeType: '節'   },
  120: { name: '大暑', nodeType: '中気' },
  135: { name: '立秋', nodeType: '節'   },
  150: { name: '処暑', nodeType: '中気' },
  165: { name: '白露', nodeType: '節'   },
  180: { name: '秋分', nodeType: '中気' },
  195: { name: '寒露', nodeType: '節'   },
  210: { name: '霜降', nodeType: '中気' },
  225: { name: '立冬', nodeType: '節'   },
  240: { name: '小雪', nodeType: '中気' },
  255: { name: '大雪', nodeType: '節'   },
  270: { name: '冬至', nodeType: '中気' },
  285: { name: '小寒', nodeType: '節'   },
  300: { name: '大寒', nodeType: '中気' },
  315: { name: '立春', nodeType: '節'   },
  330: { name: '雨水', nodeType: '中気' },
  345: { name: '啓蟄', nodeType: '節'   },
});

const BOUNDARY_PRESETS = Object.freeze({
  30:  { label: '30° 刻み（12分割）', values: Array.from({ length: 12 }, (_, i) => i * 30)  },
  45:  { label: '45° 刻み（8分割）',  values: Array.from({ length: 8  }, (_, i) => i * 45)  },
  60:  { label: '60° 刻み（6分割）',  values: Array.from({ length: 6  }, (_, i) => i * 60)  },
  90:  { label: '90° 刻み（4分割）',  values: Array.from({ length: 4  }, (_, i) => i * 90)  },
});

const BOUNDARY_PLANETS = [
  { id: NAIF.SUN,               name: '太陽',   speedKey: 'Sun'     },
  { id: NAIF.MOON,              name: '月',     speedKey: 'Moon'    },
  { id: NAIF.MERCURY_BARYCENTER,name: '水星',   speedKey: 'Mercury' },
  { id: NAIF.VENUS_BARYCENTER,  name: '金星',   speedKey: 'Venus'   },
  { id: NAIF.MARS_BARYCENTER,   name: '火星',   speedKey: 'Mars'    },
  { id: NAIF.JUPITER_BARYCENTER,name: '木星',   speedKey: 'Jupiter' },
  { id: NAIF.SATURN_BARYCENTER, name: '土星',   speedKey: 'Saturn'  },
  { id: NAIF.URANUS_BARYCENTER, name: '天王星', speedKey: 'Uranus'  },
  { id: NAIF.NEPTUNE_BARYCENTER,name: '海王星', speedKey: 'Neptune' },
  { id: NAIF.PLUTO_BARYCENTER,  name: '冥王星', speedKey: 'Pluto'   },
];

// 太陽は中心なので除外。月は地球 EMB に含む。
const HELIOCENTRIC_PLANETS = [
  { id: NAIF.MERCURY_BARYCENTER, name: '水星' },
  { id: NAIF.VENUS_BARYCENTER,   name: '金星' },
  { id: NAIF.EMB,                name: '地球（EMB）' },
  { id: NAIF.MARS_BARYCENTER,    name: '火星' },
  { id: NAIF.JUPITER_BARYCENTER, name: '木星' },
  { id: NAIF.SATURN_BARYCENTER,  name: '土星' },
  { id: NAIF.URANUS_BARYCENTER,  name: '天王星' },
  { id: NAIF.NEPTUNE_BARYCENTER, name: '海王星' },
  { id: NAIF.PLUTO_BARYCENTER,   name: '冥王星' },
];

// ── 純粋関数（HTML ビルダー・計算） ──────────────────────────────────────────

/**
 * 1惑星分の逆行期間テーブル HTML を生成する（純粋関数）
 */
function buildRetroTable(info, periods, coordLabel, startStr, endStr) {
  if (periods.length === 0) {
    return `<p style="color:var(--text-muted);margin:4px 0 12px">
              ${info.name}：この期間に逆行は検出されませんでした。</p>`;
  }

  let rows = '';
  periods.forEach(({ start, end }, i) => {
    const startTxt = start
      ? `${jdToJstStr(start.jd)}<br><span style="color:var(--text-muted)">${lonToSign(start.lon)}</span>`
      : `<span style="color:var(--text-muted)">（期間開始前）</span>`;
    const endTxt = end
      ? `${jdToJstStr(end.jd)}<br><span style="color:var(--text-muted)">${lonToSign(end.lon)}</span>`
      : `<span style="color:var(--text-muted)">（期間終了後）</span>`;

    const durationTxt = (start && end) ? `${(end.jd - start.jd).toFixed(1)} 日` : '—';
    const rangeTxt    = (start && end) ? `${normAngularDiff(start.lon, end.lon).toFixed(3)}°` : '—';

    rows += `<tr>
      <td>${i + 1}</td>
      <td>${startTxt}</td>
      <td>${endTxt}</td>
      <td>${rangeTxt}</td>
      <td>${durationTxt}</td>
    </tr>`;
  });

  return `
    <p style="margin:0 0 4px;font-size:12px;color:var(--text-muted)">
      ${info.name} / ${coordLabel} / ${startStr} 〜 ${endStr}　${periods.length} 件検出
    </p>
    <table class="result-table" style="margin-bottom:16px">
      <thead>
        <tr><th>#</th><th>逆行開始（留 D→R）</th><th>逆行終了（留 R→D）</th><th>逆行幅(°)</th><th>期間</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * 1惑星分の物理量逆行テーブル HTML を生成する（純粋関数）
 */
function buildRetroPhysicalTable(info, periods, calcFn, coordLabel, startStr, endStr) {
  if (periods.length === 0) {
    return `<p style="color:var(--text-muted);margin:4px 0 12px">
              ${info.name}：この期間に逆行は検出されませんでした。</p>`;
  }

  let rows = '';
  periods.forEach(({ start, end }, i) => {
    const startDate = start ? jdToJstStr(start.jd) : '（期間開始前）';
    const endDate   = end   ? jdToJstStr(end.jd)   : '（期間終了後）';
    const startLon  = start ? `${trunc3(start.lon)}°` : '—';
    const endLon    = end   ? `${trunc3(end.lon)}°`   : '—';
    const startSpd  = start ? `${trunc3(calcFn(start.jd + 0.5).lonspeed)}` : '—';
    const endSpd    = end   ? `${trunc3(calcFn(end.jd   - 0.5).lonspeed)}` : '—';

    let peakSpd = '—';
    if (start && end) {
      let minSpd = Infinity;
      for (let jd = start.jd + 1; jd < end.jd; jd += 1) {
        const spd = calcFn(jd).lonspeed;
        if (spd < minSpd) minSpd = spd;
      }
      peakSpd = isFinite(minSpd) ? `${trunc3(minSpd)}` : '—';
    }

    const delta    = (start && end) ? `${normAngularDiff(start.lon, end.lon).toFixed(3)}°` : '—';
    const duration = (start && end) ? `${(end.jd - start.jd).toFixed(2)} 日` : '—';

    rows += `<tr>
      <td>${i + 1}</td>
      <td>${startDate}</td><td>${startLon}</td><td>${startSpd}</td>
      <td>${endDate}</td><td>${endLon}</td><td>${endSpd}</td>
      <td>${peakSpd}</td><td>${delta}</td><td>${duration}</td>
    </tr>`;
  });

  return `
    <p style="margin:0 0 4px;font-size:12px;color:var(--text-muted)">
      ${info.name} / ${coordLabel} / ${startStr} 〜 ${endStr}　${periods.length} 件検出
    </p>
    <div style="overflow-x:auto;margin-bottom:16px">
    <table class="result-table">
      <thead>
        <tr>
          <th>#</th>
          <th>D→R 日時</th><th>黄経(°)</th><th>角速度前(°/d)</th>
          <th>R→D 日時</th><th>黄経(°)</th><th>角速度後(°/d)</th>
          <th>ピーク逆行速度(°/d)</th><th>逆行幅(°)</th><th>期間</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

/**
 * 1逆行期間分の連続物理量テーブル HTML を生成する（純粋関数）
 */
function buildRetroContinuousSection(info, period, calcFn, stepDays, rangeStartJD, rangeEndJD, periodIndex) {
  const fromJD = period.start ? period.start.jd : rangeStartJD;
  const toJD   = period.end   ? period.end.jd   : rangeEndJD;

  const fromLabel = period.start ? jdToJstStr(period.start.jd) : '（期間開始前）';
  const toLabel   = period.end   ? jdToJstStr(period.end.jd)   : '（期間終了後）';

  let rows = '';
  for (let jd = fromJD; jd <= toJD + stepDays * 0.01; jd += stepDays) {
    const clamped = Math.min(jd, toJD);
    const { lon, lonspeed } = calcFn(clamped);
    rows += `<tr>
      <td>${jdToJstStr(clamped)}</td>
      <td>${trunc3(lon)}</td>
      <td>${trunc3(lonspeed)}</td>
    </tr>`;
    if (clamped >= toJD) break;
  }

  return `
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600">
      ${info.name} 逆行 #${periodIndex + 1}　${fromLabel} → ${toLabel}
    </p>
    <table class="result-table" style="margin-bottom:14px">
      <thead><tr><th>日時（JST）</th><th>黄経(°)</th><th>角速度(°/day)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// detectAspectCrossings は ui-helpers.js から import 済み

/**
 * 太陽黄経暦（1° 刻み、360行）を算出する関数
 *
 * @param {number} year  対象年（1900〜2100）
 * @returns {Array<{lon, jd, jst, termName, nodeType, sign, speed, dwell, dwellHours}>}
 */
function calculateSolarAlmanac(year) {
  const SUN    = NAIF.SUN;
  const precJD = 0.5 / 86400;

  const jdJan1Utc = dateStrToJdUtcMidJst(`${year}-01-01`);
  const lonStart  = _computeApparent(SUN, jdUtcToTdb(jdJan1Utc)).lon;
  const startDeg  = Math.ceil(lonStart) % 360;

  const degrees = Array.from({ length: 360 }, (_, i) => (startDeg + i) % 360);

  function dev(jdUtc, target) {
    const lon = _computeApparent(SUN, jdUtcToTdb(jdUtc)).lon;
    return ((lon - target + 180 + 360) % 360) - 180;
  }

  function angDiff(from, to) {
    let d = to - from;
    if (d >  180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  const crossings = [];
  let jdPrev = jdJan1Utc;

  for (const target of degrees) {
    let lo = jdPrev - 0.1, loD = dev(lo, target), hi = jdPrev + 3.0;
    for (let iter = 0; iter < 60; iter++) {
      if (hi - lo < precJD) break;
      const mid  = (lo + hi) / 2;
      const midD = dev(mid, target);
      if (loD * midD <= 0) { hi = mid; } else { lo = mid; loD = midD; }
    }
    const crossJD = (lo + hi) / 2;
    crossings.push({ lon: target, jd: crossJD });
    jdPrev = crossJD;
  }

  return crossings.map((c, idx) => {
    const { lon, jd } = c;

    const lonAfter  = _computeApparent(SUN, jdUtcToTdb(jd + 0.5)).lon;
    const lonBefore = _computeApparent(SUN, jdUtcToTdb(jd - 0.5)).lon;
    const speed = Math.round(angDiff(lonBefore, lonAfter) * 10000) / 10000;

    let dwellStr = '—', dwellHours = 0;
    if (idx > 0) {
      dwellHours = (jd - crossings[idx - 1].jd) * 24;
      const dDays = Math.floor(dwellHours / 24);
      const dH    = Math.floor(dwellHours % 24);
      const dM    = Math.floor((dwellHours % 1) * 60);
      dwellStr = `${dDays}日${String(dH).padStart(2, '0')}h${String(dM).padStart(2, '0')}m`;
    }

    const term = SOLAR_TERMS_BY_LON[lon] ?? null;

    return {
      lon,
      jd,
      jst:       jdToJstStr(jd),
      termName:  term?.name     ?? null,
      nodeType:  term?.nodeType ?? null,
      sign:      lonToIauConstellation(lon),
      speed,
      dwell:     dwellStr,
      dwellHours: Math.round(dwellHours * 100) / 100,
    };
  });
}

// detectBoundaryCrossings は ui-helpers.js から import 済み

// ── イベントハンドラ登録 ────────────────────────────────────────────────────

function _registerHandlers() {

  // ── カスタム境界角度の表示切り替え ────────────────────────────────
  document.getElementById('boundary-preset')?.addEventListener('change', e => {
    document.getElementById('boundary-custom-row').style.display =
      e.target.value === 'custom' ? '' : 'none';
  });

  // ── 逆行期間計算（占星術向け） ──────────────────────────────────────
  document.getElementById('form-retro')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-retro')) return;

    const planetVal = document.getElementById('retro-planet').value;
    const startStr  = document.getElementById('retro-start').value;
    const endStr    = document.getElementById('retro-end').value;
    const startJD   = datetimeLocalToJdTdb(startStr);
    const endJD     = datetimeLocalToJdTdb(endStr);

    if (endJD <= startJD) {
      showResult('result-retro', '終了日時が開始日時以前です。', true);
      return;
    }

    const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    const targets = planetVal === 'all'
      ? Object.values(RETRO_PLANET_INFO)
      : [RETRO_PLANET_INFO[parseInt(planetVal, 10)]].filter(Boolean);

    if (targets.length === 0) {
      showResult('result-retro', '対応していない天体です。', true);
      return;
    }

    let html = '';
    for (const info of targets) {
      const calcFn  = makeRetroCalcFn(info.naifId, _computeApparent, { aberration: false });
      const stations = detectAllStations(calcFn, startJD, endJD);
      const periods  = groupRetrogradePeriods(stations);
      html += buildRetroTable(info, periods, coordLabel, startStr, endStr);
    }

    showResult('result-retro', html);
  });

  // ── 逆行計算 #3: 物理量逆行計算（天文学用） ────────────────────────
  document.getElementById('form-retro-physical')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-retro-physical')) return;

    const planetVal  = document.getElementById('retro-phys-planet').value;
    const startStr   = document.getElementById('retro-phys-start').value;
    const endStr     = document.getElementById('retro-phys-end').value;
    const startJD    = datetimeLocalToJdTdb(startStr);
    const endJD      = datetimeLocalToJdTdb(endStr);
    if (endJD <= startJD) { showResult('result-retro-physical', '終了日時が開始日時以前です。', true); return; }

    const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    const targets = planetVal === 'all'
      ? Object.values(RETRO_PLANET_INFO)
      : [RETRO_PLANET_INFO[parseInt(planetVal, 10)]].filter(Boolean);

    let html = '';
    for (const info of targets) {
      const calcFn   = makeRetroCalcFn(info.naifId, _computeApparent, { aberration: false });
      const stations = detectAllStations(calcFn, startJD, endJD);
      const periods  = groupRetrogradePeriods(stations);
      html += buildRetroPhysicalTable(info, periods, calcFn, coordLabel, startStr, endStr);
    }
    showResult('result-retro-physical', html);
  });

  // ── 逆行計算 #4: 逆行連続物理量計算 ────────────────────────────────
  document.getElementById('form-retro-continuous')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-retro-continuous')) return;

    const planetVal = document.getElementById('retro-cont-planet').value;
    const startStr  = document.getElementById('retro-cont-start').value;
    const endStr    = document.getElementById('retro-cont-end').value;
    const stepDays  = parseFloat(document.getElementById('retro-cont-step').value);
    const startJD   = datetimeLocalToJdTdb(startStr);
    const endJD     = datetimeLocalToJdTdb(endStr);
    if (endJD <= startJD) { showResult('result-retro-continuous', '終了日時が開始日時以前です。', true); return; }

    const info = RETRO_PLANET_INFO[parseInt(planetVal, 10)];
    if (!info) { showResult('result-retro-continuous', '対応していない天体です。', true); return; }

    const calcFn   = makeRetroCalcFn(info.naifId, _computeApparent, { aberration: false });
    const stations = detectAllStations(calcFn, startJD, endJD);
    const periods  = groupRetrogradePeriods(stations);

    if (periods.length === 0) {
      showResult('result-retro-continuous',
        `<p style="color:var(--text-muted)">${info.name}：この期間に逆行は検出されませんでした。</p>`);
      return;
    }

    const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    let html = `<p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">
      ${info.name} / ${coordLabel} / ステップ ${stepDays < 1 ? `${Math.round(stepDays * 24)}時間` : `${stepDays}日`}
      / ${periods.length} 件の逆行期間</p>`;

    periods.forEach((period, i) => {
      html += buildRetroContinuousSection(info, period, calcFn, stepDays, startJD, endJD, i);
    });

    showResult('result-retro-continuous', html);
  });

  // ── 惑星間アスペクト時系列 ──────────────────────────────────────────
  document.getElementById('form-aspects-ts')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-aspects-ts')) return;

    const naifA    = parseInt(document.getElementById('asp-ts-planet-a').value, 10);
    const naifB    = parseInt(document.getElementById('asp-ts-planet-b').value, 10);
    const startStr = document.getElementById('asp-ts-start').value;
    const endStr   = document.getElementById('asp-ts-end').value;
    const startJD  = datetimeLocalToJdTdb(startStr);
    const endJD    = datetimeLocalToJdTdb(endStr);

    if (naifA === naifB) {
      showResult('result-aspects-ts', '天体 A と天体 B が同じです。異なる天体を選択してください。', true);
      return;
    }
    if (endJD <= startJD) {
      showResult('result-aspects-ts', '終了日時が開始日時以前です。', true);
      return;
    }

    const checkedTypes = [...document.querySelectorAll('input[name="asp-ts-type"]:checked')]
      .map(el => parseInt(el.value, 10));
    if (checkedTypes.length === 0) {
      showResult('result-aspects-ts', 'アスペクト種を1つ以上選択してください。', true);
      return;
    }

    const infoA = ASP_PLANET_MAP[naifA];
    const infoB = ASP_PLANET_MAP[naifB];

    const spdA    = AVG_SPEEDS[infoA.speedKey] ?? 0.5;
    const spdB    = AVG_SPEEDS[infoB.speedKey] ?? 0.5;
    const relSpd  = Math.abs(spdA - spdB) || 0.001;
    const stepDays = Math.min(20, Math.max(0.3, 4 / relSpd));

    const calcFnA = jd => _computeApparent(naifA, jd, { aberration: false });
    const calcFnB = jd => _computeApparent(naifB, jd, { aberration: false });

    const events = [];
    for (const aspKey of checkedTypes) {
      const def = ASPECT_DEFS[aspKey];
      if (!def) continue;
      const crossings = detectAspectCrossings(calcFnA, calcFnB, aspKey, startJD, endJD, {
        stepDays,
        precisionHours: 0.01,
      });
      for (const c of crossings) {
        events.push({ ...c, aspKey, def });
      }
    }

    events.sort((a, b) => a.jd - b.jd);

    if (events.length === 0) {
      showResult('result-aspects-ts',
        `<p style="color:var(--text-muted)">${infoA.name} – ${infoB.name}：この期間に選択したアスペクトは検出されませんでした。</p>`);
      return;
    }

    const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
    const rows = events.map((ev, i) => `<tr>
      <td>${i + 1}</td>
      <td>${jdToJstStr(ev.jd)}</td>
      <td>${ev.def.symbol} ${ev.def.name}</td>
      <td>${trunc3(ev.lonA)}°</td>
      <td>${trunc3(ev.lonB)}°</td>
      <td>${trunc3(ev.sep)}°</td>
    </tr>`).join('');

    showResult('result-aspects-ts', `
      <p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">
        ${infoA.name} – ${infoB.name} / ${coordLabel} / ${startStr} 〜 ${endStr}　${events.length} 件検出
      </p>
      <table class="result-table">
        <thead>
          <tr>
            <th>#</th>
            <th>日時（JST）</th>
            <th>アスペクト</th>
            <th>${infoA.name} λ(°)</th>
            <th>${infoB.name} λ(°)</th>
            <th>分離角(°)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`);
  });

  // ── 太陽黄経暦（1° 刻み） ─────────────────────────────────────────
  document.getElementById('form-solar-cal')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-solar-cal')) return;

    const year = parseInt(document.getElementById('solar-cal-year').value, 10);
    if (isNaN(year) || year < 1900 || year > 2100) {
      showResult('result-solar-cal', '年は 1900〜2100 の範囲で入力してください。', true);
      return;
    }

    showLoading('result-solar-cal', '計算中…', `${year} 年の二十四節気を二分探索（24 回）`);
    await yieldFrame();

    setTimeout(() => {
      try {
        const rows = calculateSolarAlmanac(year);
        const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';

        const tableRows = rows.map((r, i) => {
          const termCell  = r.termName ? `<strong>${r.termName}</strong>` : '—';
          const nodeCell  = r.nodeType ?? '—';
          const isSekkiRow = r.termName ? ' style="background:rgba(139,92,246,0.12)"' : '';
          return `<tr${isSekkiRow}>
            <td>${r.lon}°</td>
            <td>${r.jst}</td>
            <td>${termCell}</td>
            <td>${nodeCell}</td>
            <td>${r.sign}</td>
            <td>${r.speed > 0 ? '+' : ''}${r.speed}</td>
            <td>${r.dwell}</td>
          </tr>`;
        }).join('');

        showResult('result-solar-cal', `
          <p style="margin:0 0 4px;font-size:12px;color:var(--text-muted)">
            太陽黄経暦 ${year} / ${coordLabel} / ${rows.length} 行
          </p>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 6px">
            星座は IAU 境界（13星座・蛇遣座含む）による。J2000.0 近似値。
          </p>
          <table class="result-table">
            <thead>
              <tr>
                <th>黄経</th>
                <th>通過日時（JST）</th>
                <th>節気</th>
                <th>区分</th>
                <th>IAU 星座</th>
                <th>速度（°/日）</th>
                <th>滞在時間</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>`);
      } catch (err) {
        showResult('result-solar-cal', `計算エラー: ${err.message}`, true);
      }
    }, 50);
  });

  // ── 任意境界角度通過検出 ────────────────────────────────────────────
  document.getElementById('form-boundary')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-boundary')) return;

    const planetVal = document.getElementById('boundary-planet').value;
    const presetVal = document.getElementById('boundary-preset').value;
    const startStr  = document.getElementById('boundary-start').value;
    const endStr    = document.getElementById('boundary-end').value;
    const startJD   = datetimeLocalToJdTdb(startStr);
    const endJD     = datetimeLocalToJdTdb(endStr);

    if (endJD <= startJD) {
      showResult('result-boundary', '終了日時が開始日時以前です。', true);
      return;
    }

    let boundaries, presetLabel;
    if (presetVal === 'custom') {
      const raw = document.getElementById('boundary-custom').value.trim();
      try {
        boundaries  = [...new Set(raw.split(',').map(x => ((parseFloat(x) % 360) + 360) % 360))].sort((a, b) => a - b);
        presetLabel = `カスタム（${boundaries.length}点）`;
      } catch {
        showResult('result-boundary', 'カスタム角度の形式が不正です（例: 0,15,30,90）', true);
        return;
      }
      if (boundaries.length === 0) {
        showResult('result-boundary', '境界角度を1つ以上入力してください。', true);
        return;
      }
    } else {
      const preset = BOUNDARY_PRESETS[parseInt(presetVal, 10)];
      boundaries  = preset.values;
      presetLabel = preset.label;
    }

    const targetPlanets = planetVal === 'all'
      ? BOUNDARY_PLANETS
      : BOUNDARY_PLANETS.filter(p => p.id === parseInt(planetVal, 10));

    const hasMoon = targetPlanets.some(p => p.id === NAIF.MOON);
    const stepDays = hasMoon ? 0.1 : 0.25;

    const allEvents = [];
    for (const planet of targetPlanets) {
      const calcFn = jd => _computeApparent(planet.id, jd, { aberration: false });
      const crossings = detectBoundaryCrossings(calcFn, boundaries, startJD, endJD, {
        stepDays,
        precisionHours: 0.01,
      });
      for (const c of crossings) {
        allEvents.push({ ...c, planet });
      }
    }
    allEvents.sort((a, b) => a.jd - b.jd);

    const coordLabel = _settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';

    if (allEvents.length === 0) {
      showResult('result-boundary',
        `<p style="color:var(--text-muted)">指定期間内に境界通過は検出されませんでした。</p>`);
      return;
    }

    const rows = allEvents.map((ev, i) => {
      const isRetro = ev.lonspeed < 0;
      return `<tr>
        <td>${i + 1}</td>
        <td>${jdToJstStr(ev.jd)}</td>
        <td>${ev.planet.name}</td>
        <td>${ev.boundary.toFixed(1)}°</td>
        <td>${trunc3(ev.lon)}°</td>
        <td>${ev.lonspeed >= 0 ? '+' : ''}${trunc3(ev.lonspeed)}</td>
        <td>${isRetro ? '℞' : ''}</td>
      </tr>`;
    }).join('');

    showResult('result-boundary', `
      <p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">
        ${presetLabel} / ${coordLabel} / ${startStr} 〜 ${endStr}　${allEvents.length} 件検出
      </p>
      <table class="result-table">
        <thead>
          <tr>
            <th>#</th>
            <th>日時（JST）</th>
            <th>天体</th>
            <th>境界</th>
            <th>黄経 (°)</th>
            <th>角速度 (°/day)</th>
            <th>逆行</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`);
  });

  // ── ヘリオセントリック計算 ────────────────────────────────────────
  document.getElementById('form-helio')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-helio')) return;

    const jdTdb = jstInputToJdTdb(document.getElementById('helio-sci-datetime').value);
    const coordLabel = _settings.coordSystem === 'j2000' ? '黄経（J2000.0）' : '黄経（of-date）';

    let rows = '';
    for (const { id: naifId, name } of HELIOCENTRIC_PLANETS) {
      try {
        const { lon, lat, dist, speedKmS } = _computeHeliocentric(naifId, jdTdb);
        rows += `<tr>
          <td>${name}</td>
          <td>${lonToIauConstellation(lon)}</td>
          <td>${trunc3(lon)}°</td>
          <td>${trunc3(lat)}°</td>
          <td>${trunc3(dist)}</td>
          <td>${(Math.trunc(speedKmS * 1000) / 1000).toFixed(3)}</td>
        </tr>`;
      } catch (err) {
        rows += `<tr><td>${name}</td><td colspan="5" style="color:var(--text-muted)">計算不可: ${err.message}</td></tr>`;
      }
    }

    showResult('result-helio', `
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 6px">
        星座は IAU 境界（13星座・蛇遣座含む）による。J2000.0 近似値。
      </p>
      <table class="result-table">
        <thead><tr><th>天体</th><th>IAU 星座</th><th>${coordLabel}</th><th>黄緯</th><th>太陽からの距離 (AU)</th><th>公転速度 (km/s)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  });

  // ── 惑星位置計算（地心） ────────────────────────────────────────────
  document.getElementById('form-planet-pos')?.addEventListener('submit', e => {
    e.preventDefault();
    if (!_requireBsp('result-planet-pos')) return;

    const jdTdb = jstInputToJdTdb(document.getElementById('planet-datetime').value);

    let rows = '';
    for (const { id: naifId, name } of GEOCENTRIC_PLANETS) {
      try {
        const { lon, lat, dist } = _computeApparent(naifId, jdTdb, { aberration: false });
        const distAu = dist / AU_KM;
        rows += `<tr>
          <td>${name}</td>
          <td>${lonToIauConstellation(lon)}</td>
          <td>${trunc3(lon)}°</td>
          <td>${trunc3(lat)}°</td>
          <td>${trunc3(distAu)}</td>
        </tr>`;
      } catch (err) {
        rows += `<tr><td>${name}</td><td colspan="4" style="color:var(--text-muted)">計算不可: ${err.message}</td></tr>`;
      }
    }

    const coordLabel = _settings.coordSystem === 'j2000'
      ? '黄経（J2000.0）'
      : '黄経（IAU of-date / astrometric）';
    showResult('result-planet-pos', `
      <p style="font-size:11px;color:var(--text-muted);margin:0 0 6px">
        星座は IAU 境界（13星座・蛇遣座含む）による。J2000.0 近似値。光行差補正なし（Python/Skyfield astrometric 対応）。
      </p>
      <table class="result-table">
        <thead><tr><th>天体</th><th>IAU 星座</th><th>${coordLabel}</th><th>黄緯</th><th>地球からの距離 (AU)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  });

}
