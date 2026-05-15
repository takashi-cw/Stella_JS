/**
 * Stella-JS — アプリケーションオーケストレーター
 *
 * 責務:
 *   - BSP ファイルの読み込みと BspReader の初期化
 *   - タブ / サブメニューの切り替え（ナビゲーション）
 *   - 各機能モジュールへの依存注入と init() 呼び出し
 *
 * 計算エンジン: src/index.js
 * UI モジュール:
 *   src/ui-helpers.js      — 共有 UI ヘルパー・純粋計算関数
 *   src/download.js        — ダウンロード系
 *   src/ui-astro-calc.js   — 天文計算ハンドラ群
 *   src/ui-astro.js        — 占星術計算ハンドラ群
 *   src/ui-eastern.js      — 東洋占術計算ハンドラ群
 *   src/ui-observation.js  — 天体観測系ハンドラ群
 *   src/ui-settings.js     — 設定・暦変換
 */

import {
  loadBsp, parseBsp,
  AU_KM,
  dateToJd, jdUtcToTdb,
  icrsToEcliptic, icrsToJ2000Ecliptic,
  applyAberration, observerGCRS, applyLightDeflection,
  BSP_PATH_PROD,
  NAIF,
} from './index.js';
import { assertInCoverage } from './core/bsp-validator.js';

import { attachGeocodeHandler, showResult } from './ui-helpers.js';
import { init as initAstroCalc  } from './ui-astro-calc.js';
import { init as initAstro      } from './ui-astro.js';
import { init as initEastern    } from './ui-eastern.js';
import { init as initObservation} from './ui-observation.js';
import { init as initSettings, loadChangelog } from './ui-settings.js';

// ── グローバル設定 ────────────────────────────────────────────────────────
const settings = {
  coordSystem: 'of-date',
};

// ── BSP 読み込み状態 ──────────────────────────────────────────────────────
let bspFile = null;

const bspStatusEl = document.getElementById('bsp-status');

async function initBsp(path) {
  const buffer = await loadBsp(path);
  bspFile = parseBsp(buffer);
  bspStatusEl.textContent = `BSP: ✓ 読み込み完了（${path}）`;
  bspStatusEl.className = 'status-badge status-ok';
  return bspFile;
}

function showBspError(msg) {
  bspStatusEl.textContent = `BSP: ✗ 読み込み失敗 — ${msg}`;
  bspStatusEl.className = 'status-badge status-error';
  bspFile = null;
}

// ── BSP 未ロード時のガード ────────────────────────────────────────────────
function requireBsp(resultElId) {
  if (!bspFile) {
    showResult(resultElId, '⚠️ BSP ファイルが読み込まれていません。設定タブで再読み込みしてください。', true);
    return false;
  }
  return true;
}

// ── 天体視位置計算 ────────────────────────────────────────────────────────
const C_KM_PER_DAY = 299792.458 * 86400;

/**
 * 天体の視位置を計算する（settings.coordSystem に従う）
 *
 * of-date: 光行時間 + トポセントリック + 光偏差 + 年周光行差 + 歳差章動
 * j2000:   光行時間のみ（歳差・章動・光行差なし）
 */
function computeApparent(naifId, jdTdb, opts = {}) {
  const { jdUtc = null, observer = null, aberration = true } = opts;

  assertInCoverage(jdTdb, bspFile);

  const geoPos  = bspFile.computePosition(naifId, NAIF.EARTH, jdTdb);
  const geoDist = Math.sqrt(geoPos[0] ** 2 + geoPos[1] ** 2 + geoPos[2] ** 2);
  const tau     = geoDist / C_KM_PER_DAY;

  const earthSSB  = bspFile.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb);
  const targetSSB = bspFile.computePosition(naifId,     NAIF.SSB, jdTdb - tau);
  let ax = targetSSB[0] - earthSSB[0];
  let ay = targetSSB[1] - earthSSB[1];
  let az = targetSSB[2] - earthSSB[2];

  if (observer && jdUtc != null) {
    const [ox, oy, oz] = observerGCRS(
      observer.lat, observer.lon, observer.elev ?? 0, jdUtc
    );
    ax -= ox;
    ay -= oy;
    az -= oz;
  }

  if (settings.coordSystem === 'j2000') {
    return icrsToJ2000Ecliptic(ax, ay, az);
  }

  if (!aberration) {
    return icrsToEcliptic(ax, ay, az, jdTdb);
  }

  let bx = ax, by = ay, bz = az;
  if (naifId !== NAIF.SUN) {
    const sunSSB = bspFile.computePosition(NAIF.SUN, NAIF.SSB, jdTdb);
    const sunX = sunSSB[0] - earthSSB[0];
    const sunY = sunSSB[1] - earthSSB[1];
    const sunZ = sunSSB[2] - earthSSB[2];
    const defl = applyLightDeflection(ax, ay, az, sunX, sunY, sunZ);
    const dist0 = Math.sqrt(ax * ax + ay * ay + az * az);
    bx = defl.x * dist0;
    by = defl.y * dist0;
    bz = defl.z * dist0;
  }

  const dt = 0.5 / 86400;
  const eP = bspFile.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb + dt);
  const eM = bspFile.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb - dt);
  const vx = (eP[0] - eM[0]) / (2 * dt);
  const vy = (eP[1] - eM[1]) / (2 * dt);
  const vz = (eP[2] - eM[2]) / (2 * dt);

  const abr  = applyAberration(bx, by, bz, vx, vy, vz);
  const dist = Math.sqrt(bx * bx + by * by + bz * bz);
  return icrsToEcliptic(abr.x * dist, abr.y * dist, abr.z * dist, jdTdb);
}

/**
 * 天体の日心位置と公転速度を計算する
 * 日心座標なので光行時間補正・光行差は適用しない。
 */
function computeHeliocentric(naifId, jdTdb, opts = {}) {
  const pos = bspFile.computePosition(naifId, NAIF.SUN, jdTdb);
  const [x, y, z] = pos;

  const ecl = settings.coordSystem === 'j2000'
    ? icrsToJ2000Ecliptic(x, y, z)
    : icrsToEcliptic(x, y, z, jdTdb);

  if (opts.lonOnly) return { lon: ecl.lon };

  const DT_DAY = 1 / 24;
  const p1 = bspFile.computePosition(naifId, NAIF.SUN, jdTdb - DT_DAY / 2);
  const p2 = bspFile.computePosition(naifId, NAIF.SUN, jdTdb + DT_DAY / 2);
  const ddx = p2[0] - p1[0], ddy = p2[1] - p1[1], ddz = p2[2] - p1[2];
  const speedKmS = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) / 3600;

  return { lon: ecl.lon, lat: ecl.lat, dist: ecl.dist / AU_KM, speedKmS };
}

/**
 * 任意の観測中心から見た天体位置（光行時間補正あり、光行差なし）
 */
function computeFromCenter(naifId, centerNaifId, jdTdb) {
  const geoPos  = bspFile.computePosition(naifId, centerNaifId, jdTdb);
  const geoDist = Math.sqrt(geoPos[0] ** 2 + geoPos[1] ** 2 + geoPos[2] ** 2);
  const tau     = geoDist / C_KM_PER_DAY;

  const centerSSB = bspFile.computePosition(centerNaifId, NAIF.SSB, jdTdb);
  const targetSSB = bspFile.computePosition(naifId, NAIF.SSB, jdTdb - tau);
  const ax = targetSSB[0] - centerSSB[0];
  const ay = targetSSB[1] - centerSSB[1];
  const az = targetSSB[2] - centerSSB[2];

  const ecl = settings.coordSystem === 'j2000'
    ? icrsToJ2000Ecliptic(ax, ay, az)
    : icrsToEcliptic(ax, ay, az, jdTdb);

  return { lon: ecl.lon, lat: ecl.lat, dist: ecl.dist / AU_KM };
}

// ── 初期 BSP 読み込み ─────────────────────────────────────────────────────
initBsp(BSP_PATH_PROD)
  .catch(e => showBspError(e.message));

// ── 設定の適用ボタン ──────────────────────────────────────────────────────
document.getElementById('settings-apply-btn').addEventListener('click', async () => {
  const coordSel   = document.getElementById('settings-coord');
  const statusEl   = document.getElementById('settings-apply-status');
  const bspPath    = BSP_PATH_PROD;
  const bspLabel   = 'de440s-modern.bsp（標準版）';
  const coordLabel = coordSel.value === 'j2000' ? 'J2000.0' : 'of-date（推奨）';

  settings.coordSystem = coordSel.value;

  statusEl.textContent = '読み込み中...';
  statusEl.style.color = 'var(--text-muted)';
  bspStatusEl.textContent = 'BSP: 読み込み中...';
  bspStatusEl.className = 'status-badge status-loading';

  try {
    await initBsp(bspPath);
    const now = new Date();
    const ts  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    statusEl.innerHTML = `✅ 適用しました（${ts}）<br>天体暦: ${bspLabel} &nbsp;|&nbsp; 座標系: ${coordLabel}`;
    statusEl.style.color = 'var(--accent)';
  } catch (e) {
    showBspError(e.message);
    statusEl.textContent = `❌ 読み込み失敗: ${e.message}`;
    statusEl.style.color = 'var(--error, #ef4444)';
  }
});

// ── ナビゲーション ────────────────────────────────────────────────────────

function showWelcome() {
  document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-welcome')?.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
  resetBreadcrumb();
}

(function initStandaloneMode() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (isStandalone) document.body.classList.add('is-standalone');
})();

const BC_CATEGORY_LABELS = {
  'astro':       '📊 天文計算',
  'observation': '🔭 天体観測',
  'astrology':   '🔮 占星術計算',
  'ephemeris':   '📋 基準物理天体暦',
  'cal-conv':    '📅 暦変換計算',
  'ai-sim':      '🤝 AI相談シミュレーター',
  'settings':    '⚙️ 設定',
};

let _bcCurrentTabId = null;

function updateBreadcrumb(tabId, menuText) {
  const bc     = document.getElementById('breadcrumb');
  const catEl  = document.getElementById('bc-category');
  const menuEl = document.getElementById('bc-menu');
  const sep2   = document.querySelector('#breadcrumb .bc-sep2');
  if (!bc || !catEl || !menuEl) return;
  _bcCurrentTabId = tabId;
  catEl.textContent  = BC_CATEGORY_LABELS[tabId] ?? tabId;
  menuEl.textContent = menuText ?? '';
  if (sep2) sep2.style.visibility = menuText ? 'visible' : 'hidden';
  bc.classList.add('bc-visible');
}

function resetBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  if (bc) bc.classList.remove('bc-visible');
  _bcCurrentTabId = null;
}

document.getElementById('breadcrumb-home')?.addEventListener('click', showWelcome);

document.getElementById('bc-category')?.addEventListener('click', () => {
  if (!_bcCurrentTabId) return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.add('open');
  document.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
  document.querySelector(`.nav-group[data-tab="${_bcCurrentTabId}"]`)?.classList.add('open');
});

document.querySelector('header h1')?.addEventListener('click', showWelcome);

document.querySelectorAll('.feature-card:not(.is-coming)').forEach(card => {
  card.addEventListener('click', () => {
    const tabId = card.dataset.tab;
    const subId = card.dataset.sub;

    document.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
    document.querySelector(`.nav-group[data-tab="${tabId}"]`)?.classList.add('open');

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`.nav-item[data-tab="${tabId}"][data-sub="${subId}"]`)?.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    document.getElementById(`tab-${tabId}`)?.classList.add('active');

    const section = document.getElementById(`tab-${tabId}`);
    if (section) {
      section.querySelectorAll(':scope > .sub-content').forEach(s => s.classList.remove('active'));
      document.getElementById(subId)?.classList.add('active');
    }

    if (subId === 'settings-changelog') loadChangelog();

    const navItem = document.querySelector(`.nav-item[data-tab="${tabId}"][data-sub="${subId}"]`);
    updateBreadcrumb(tabId, navItem?.textContent.trim() ?? '');
  });
});

document.getElementById('menu-toggle')?.addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

function closeSidebarOnMobile() {
  if (window.innerWidth <= 600) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

document.querySelectorAll('.nav-group-hd').forEach(hd => {
  hd.addEventListener('click', () => {
    hd.closest('.nav-group').classList.toggle('open');
  });
});

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tabId = item.dataset.tab;
    const subId = item.dataset.sub;

    closeSidebarOnMobile();

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    document.getElementById(`tab-${tabId}`)?.classList.add('active');

    const section = document.getElementById(`tab-${tabId}`);
    if (section) {
      section.querySelectorAll(':scope > .sub-content').forEach(s => s.classList.remove('active'));
      document.getElementById(subId)?.classList.add('active');
    }

    if (subId === 'settings-changelog') loadChangelog();

    updateBreadcrumb(tabId, item.textContent.trim());
  });
});

document.querySelectorAll('.sub-btn-2').forEach(btn => {
  btn.addEventListener('click', () => {
    const parent = btn.closest('.sub-content');
    parent.querySelectorAll('.sub-btn-2').forEach(b => b.classList.remove('active'));
    parent.querySelectorAll('.sub-content-2').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    const target = parent.querySelector(`#${btn.dataset.sub2}`);
    if (target) target.classList.add('active');
  });
});

// ── 未実装フォームのデフォルト送信を停止 ─────────────────────────────────
[
].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('submit', e => {
    e.preventDefault();
    const resultId = id.replace('form-', 'result-');
    const resultEl = document.getElementById(resultId);
    if (resultEl) {
      resultEl.innerHTML = '<p style="color:var(--text-muted)">この機能は実装予定です。</p>';
      resultEl.className = 'result-area visible';
    }
  });
});

// ── カスタム境界角度の表示切り替え ────────────────────────────────────────
document.getElementById('boundary-preset')?.addEventListener('change', e => {
  document.getElementById('boundary-custom-row').style.display =
    e.target.value === 'custom' ? 'flex' : 'none';
});

// ── 住所ジオコーディング（Nominatim / OpenStreetMap） ─────────────────────
['natal', 'sunrise', 'moonrise', 'landscape', 'medieval'].forEach(attachGeocodeHandler);

// ── 各モジュールを初期化（依存を注入） ────────────────────────────────────
const _deps = {
  computeApparent,
  computeHeliocentric,
  computeFromCenter,
  requireBsp,
  settings,
};

initAstroCalc(_deps);
initAstro(_deps);
initEastern({ computeApparent, requireBsp });
initObservation({ computeApparent, computeFromCenter, requireBsp, settings });
initSettings();
