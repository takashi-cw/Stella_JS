/**
 * Stella-JS — UI アプリケーションロジック
 *
 * 責務:
 *   - タブ / サブメニューの切り替え
 *   - BSP ファイルの読み込みと BspReader の初期化
 *   - 各フォームの submit ハンドラー登録（エンジンの呼び出し）
 *
 * エンジン（計算）は src/index.js に集約。
 * このファイルは「副作用（DOM 操作・fetch）の集約場所」。
 */

import {
  loadBsp, parseBsp,
  AU_KM,
  dateToJd, jdToDate, jdUtcToTdb,
  astroYearToHistorical, historicalYearToAstro,
  icrsToEcliptic,
  icrsToJ2000Ecliptic,
  applyAberration,
  annualAberration,
  observerGCRS,
  applyLightDeflection,
  normAngle, normAngularDiff,
  siderealTime, eclipticToEquatorial, altitudeAzimuth,
  obliquity,
  calculateAyanamsha,
  housesPlacidus, housesKoch, housesEqual,
  housesWholeSigns, housesRegiomontanus, housesCampanus,
  getAllAspects, MAJOR_ASPECTS,
  detectStationPoint, AVG_SPEEDS, calcSyzygy,
  getLunarDate,
  BSP_PATH_DEV, BSP_PATH_PROD,
  NAIF,
} from './index.js';
import { assertInCoverage } from './core/bsp-validator.js';

// アヤナムシャ種別（precession.js の内部定数と合わせる）
const AYANAMSHA = { LAHIRI: 'lahiri', FAGAN_BRADLEY: 'fagan_bradley' };

/** calculateAyanamsha のラッパー — offsetDeg（度数）を返す */
function ayanamsha(jdTdb, type) {
  const year = 2000 + (jdTdb - 2451545.0) / 365.25;
  const result = calculateAyanamsha(type, year);
  return result?.offsetDeg ?? 0;
}

// ── グローバル設定 ────────────────────────────────────────────────
/**
 * アプリ全体の設定状態
 *   coordSystem: 'of-date' | 'j2000'
 */
const settings = {
  coordSystem: 'of-date',
};

// ── BSP 読み込み状態 ──────────────────────────────────────────────
let bspFile = null;

const bspStatusEl = document.getElementById('bsp-status');

/** BSP を読み込み、成功時はバッジを更新して BspFile を返す。失敗時は throw する */
async function initBsp(path) {
  const buffer = await loadBsp(path);  // ArrayBuffer を取得（失敗時は throw）
  bspFile = parseBsp(buffer);          // BspFile インスタンスに変換
  bspStatusEl.textContent = `BSP: ✓ 読み込み完了（${path}）`;
  bspStatusEl.className = 'status-badge status-ok';
  return bspFile;
}

/** BSP 読み込み失敗時のエラー表示 */
function showBspError(msg) {
  bspStatusEl.textContent = `BSP: ✗ 読み込み失敗 — ${msg}`;
  bspStatusEl.className = 'status-badge status-error';
  bspFile = null;
}

// ── 天体視位置計算（光行時間補正 + 年周光行差） ────────────────────────────
/** 光速 [km/day] */
const C_KM_PER_DAY = 299792.458 * 86400;

/**
 * 天体の視位置を計算する（settings.coordSystem に従って座標系を切り替える）
 *
 * [of-date モード] Python/Skyfield の apparent() + ecliptic_frame に相当:
 *   1. 幾何学的位置から光行時間 τ を推定
 *   2. 天体位置を jdTdb-τ で再評価（地球は jdTdb で固定）→ 実体位置
 *   3. トポセントリック補正（observer 指定時）: 測心ベクトルから観測者 GCRS 位置を引く
 *   4. 光偏差補正（太陽以外の天体で observer 指定時）
 *   5. 速度ベクトル法光行差 → ICRS 視方向
 *   6. ICRS → of-date 黄道（Capitaine 歳差 + IAU 2000B 章動）
 *
 * [j2000 モード] 光行時間補正のみ。歳差・章動・光行差なし。
 *
 * @param {number} naifId   天体の NAIF コード
 * @param {number} jdTdb    観測 JD（TDB）
 * @param {object} [opts]   オプション
 * @param {number} [opts.jdUtc]              UTC JD（observer 指定時に使用）
 * @param {object} [opts.observer]           観測地（省略時: 地心）
 * @param {number} [opts.observer.lat]       観測緯度（度、北緯正）
 * @param {number} [opts.observer.lon]       観測経度（度、東経正）
 * @param {number} [opts.observer.elev=0]   標高（km）
 * @returns {{ lon: number, lat: number, dist: number }}
 */
function computeApparent(naifId, jdTdb, opts = {}) {
  const { jdUtc = null, observer = null } = opts;

  // ── 0. 天体暦カバー範囲チェック ──────────────────────────────────
  //    範囲外なら RangeError を throw → 呼び出し元の try/catch が拾う
  assertInCoverage(jdTdb, bspFile);

  // ── 1. 幾何学的距離 → 光行時間 τ [day] ──────────────────────────
  const geoPos = bspFile.computePosition(naifId, NAIF.EARTH, jdTdb);
  const geoDist = Math.sqrt(geoPos[0] ** 2 + geoPos[1] ** 2 + geoPos[2] ** 2);
  const tau = geoDist / C_KM_PER_DAY;

  // ── 2. 実体位置: 天体(t-τ) − 地球(t) [ICRS, km] ──────────────
  const earthSSB  = bspFile.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb);
  const targetSSB = bspFile.computePosition(naifId,     NAIF.SSB, jdTdb - tau);
  let ax = targetSSB[0] - earthSSB[0];
  let ay = targetSSB[1] - earthSSB[1];
  let az = targetSSB[2] - earthSSB[2];

  // ── 3. トポセントリック補正（observer 指定時）──────────────────
  //    地心 ICRS ベクトルから観測者の GCRS 位置ベクトルを引く
  //    月: 最大 ~57' の差 → 補正後 < 1"
  if (observer && jdUtc != null) {
    const [ox, oy, oz] = observerGCRS(
      observer.lat, observer.lon, observer.elev ?? 0, jdUtc
    );
    ax -= ox;
    ay -= oy;
    az -= oz;
  }

  if (settings.coordSystem === 'j2000') {
    // ── J2000.0 モード: 傾斜角回転のみ（歳差・章動・光行差なし） ──
    return icrsToJ2000Ecliptic(ax, ay, az);
  }

  // ── of-date モード（デフォルト） ────────────────────────────────
  // 4. 光偏差補正（太陽以外の天体のみ）
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

  // 5. 年周光行差補正（速度ベクトル法 / ICRS 空間）
  //    地球重心速度を有限差分で取得（±0.5秒ステップ）
  const dt = 0.5 / 86400;
  const eP = bspFile.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb + dt);
  const eM = bspFile.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb - dt);
  const vx = (eP[0] - eM[0]) / (2 * dt);
  const vy = (eP[1] - eM[1]) / (2 * dt);
  const vz = (eP[2] - eM[2]) / (2 * dt);

  const abr = applyAberration(bx, by, bz, vx, vy, vz);

  // 6. 光行差補正済み ICRS → of-date 黄道（歳差行列 + 章動）
  const dist = Math.sqrt(bx * bx + by * by + bz * bz);
  return icrsToEcliptic(abr.x * dist, abr.y * dist, abr.z * dist, jdTdb);
}

/**
 * 天体の日心位置と公転速度を計算する（純粋ヘルパー）
 *
 * 日心座標なので光行時間補正・光行差は適用しない。
 * 座標系は settings.coordSystem に従う。
 *
 * @param {number} naifId  惑星の NAIF コード（太陽以外）
 * @param {number} jdTdb   観測 JD（TDB）
 * @returns {{ lon: number, lat: number, dist: number, speedKmS: number }}
 *   dist は AU、speedKmS は公転速度 km/s
 */
function computeHeliocentric(naifId, jdTdb) {
  const pos = bspFile.computePosition(naifId, NAIF.SUN, jdTdb);
  const [x, y, z] = pos;

  const ecl = settings.coordSystem === 'j2000'
    ? icrsToJ2000Ecliptic(x, y, z)
    : icrsToEcliptic(x, y, z, jdTdb);

  // 公転速度: 1時間中心差分（|Δr| / 3600 s → km/s）
  const DT_DAY = 1 / 24;
  const p1 = bspFile.computePosition(naifId, NAIF.SUN, jdTdb - DT_DAY / 2);
  const p2 = bspFile.computePosition(naifId, NAIF.SUN, jdTdb + DT_DAY / 2);
  const ddx = p2[0] - p1[0], ddy = p2[1] - p1[1], ddz = p2[2] - p1[2];
  const speedKmS = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) / 3600;

  return { lon: ecl.lon, lat: ecl.lat, dist: ecl.dist / AU_KM, speedKmS };
}

// ── 任意中心からの天体位置（多重心・Planet-Physics 用） ─────────────────────

/**
 * 任意の観測中心から見た天体位置を計算する（光行時間補正あり）
 * Python spacefield の calc_ut_centered 相当。
 * 光行差補正は省略（物理量として地点間の幾何学的位置関係を返す）。
 *
 * @param {number} naifId       ターゲット NAIF コード
 * @param {number} centerNaifId 観測中心 NAIF コード
 * @param {number} jdTdb        JD（TDB）
 * @returns {{ lon: number, lat: number, dist: number }}  lon/lat: 度, dist: AU
 */
function computeFromCenter(naifId, centerNaifId, jdTdb) {
  // 1. 幾何学的距離 → 光行時間 τ [day]
  const geoPos  = bspFile.computePosition(naifId, centerNaifId, jdTdb);
  const geoDist = Math.sqrt(geoPos[0] ** 2 + geoPos[1] ** 2 + geoPos[2] ** 2);
  const tau     = geoDist / C_KM_PER_DAY;

  // 2. 光行時間補正位置: 天体(t-τ) − 観測中心(t) [ICRS, km]
  const centerSSB = bspFile.computePosition(centerNaifId, NAIF.SSB, jdTdb);
  const targetSSB = bspFile.computePosition(naifId, NAIF.SSB, jdTdb - tau);
  const ax = targetSSB[0] - centerSSB[0];
  const ay = targetSSB[1] - centerSSB[1];
  const az = targetSSB[2] - centerSSB[2];

  // 3. ICRS → 黄道座標（settings.coordSystem に従う）
  const ecl = settings.coordSystem === 'j2000'
    ? icrsToJ2000Ecliptic(ax, ay, az)
    : icrsToEcliptic(ax, ay, az, jdTdb);

  return { lon: ecl.lon, lat: ecl.lat, dist: ecl.dist / AU_KM };
}

// ── Planet-Physics 定数 ───────────────────────────────────────────────

const PHYS_CENTER_OPTIONS = [
  { naifId: NAIF.EARTH,               label: '地心（地球）',  name: '地球'   },
  { naifId: NAIF.MERCURY_BARYCENTER,  label: '水星重心',      name: '水星'   },
  { naifId: NAIF.VENUS_BARYCENTER,    label: '金星重心',      name: '金星'   },
  { naifId: NAIF.MARS_BARYCENTER,     label: '火星重心',      name: '火星'   },
  { naifId: NAIF.JUPITER_BARYCENTER,  label: '木星重心',      name: '木星'   },
  { naifId: NAIF.SATURN_BARYCENTER,   label: '土星重心',      name: '土星'   },
  { naifId: NAIF.URANUS_BARYCENTER,   label: '天王星重心',    name: '天王星' },
  { naifId: NAIF.NEPTUNE_BARYCENTER,  label: '海王星重心',    name: '海王星' },
  { naifId: NAIF.PLUTO_BARYCENTER,    label: '冥王星重心',    name: '冥王星' },
  { naifId: NAIF.MOON,                label: '月重心',        name: '月'     },
];

const PHYS_PLANETS_ALL = [
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
];

const PHYS_STEP_JD = { '1h': 1 / 24, '6h': 0.25, '1d': 1.0, '3d': 3.0, '7d': 7.0 };
const PHYS_STEP_LABEL = { '1h': '1時間', '6h': '6時間', '1d': '1日', '3d': '3日', '7d': '7日' };

// ── CSV ダウンロードユーティリティ ───────────────────────────────────────

/**
 * 2次元配列を CSV ファイルとしてブラウザからダウンロードする
 * @param {string}     filename  ダウンロード時のファイル名
 * @param {string[][]} data      1行目をヘッダーとする 2次元文字列配列
 */
function downloadCsv(filename, data) {
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
function buildTxtContent(rows, meta) {
  const lines = [];
  // メタ情報ヘッダー
  lines.push(`# 生成: りんご力学 / 時刻表記: JST (UTC+9)`);
  lines.push(`# 天体暦: ${meta.ephemeris}`);
  lines.push(`# 観測中心: ${meta.center}`);
  lines.push(`# 座標系: ${meta.coordLabel}`);
  lines.push(`# 天体: ${meta.planets}`);
  lines.push(`# ステップ: ${meta.step}`);
  lines.push(`# 期間: ${meta.period}`);
  lines.push(`# ---`);
  lines.push(`# CC BY-NC-SA 4.0 https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ja`);
  lines.push(`# 開発者: オンラインカウンセリングルーム「しがたかしホッとライン」運営 志賀高史`);
  lines.push(`# https://www.shigatkashi.com`);
  lines.push('');
  // 列ヘッダー（タブ区切り）
  lines.push(['JST日時', '天体', '黄経(deg)', '角速度(deg/day)', '黄緯(deg)', '距離(AU)'].join('\t'));
  // データ行
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
function downloadTxt(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── 逆行計算ユーティリティ ──────────────────────────────────────────

/**
 * datetime-local 文字列（"YYYY-MM-DDTHH:MM"）を JD TDB に変換する
 * JST → UTC 変換（-9h）を含む
 * @param {string} datetimeStr
 * @returns {number} JD TDB
 */
function datetimeLocalToJdTdb(datetimeStr) {
  const [datePart, timePart = '00:00'] = datetimeStr.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm]  = timePart.split(':').map(Number);
  const utcHour   = hh - 9; // JST → UTC
  return jdUtcToTdb(dateToJd(y, m, d + utcHour / 24 + mm / 1440));
}

/**
 * JD を JST 日時文字列（ミリ秒付き）に変換する
 *
 * jdToDate は { year, month, day, hour, minute, second } を返す。
 * second は小数を含む（例: 30.456）。
 *
 * @param {number} jd
 * @returns {string} "YYYY/MM/DD HH:MM:SS.mmm JST"
 */
function jdToJstStr(jd) {
  const { year, month, day, hour, minute, second } = jdToDate(jd + 9 / 24);
  const s  = Math.floor(second);
  const ms = Math.round((second - s) * 1000);
  const p2 = n => String(n).padStart(2, '0');
  const p3 = n => String(n).padStart(3, '0');
  return `${year}/${p2(month)}/${p2(day)} ${p2(hour)}:${p2(minute)}:${p2(s)}.${p3(ms)} JST`;
}

/**
 * 逆行検出用 calcFn を生成する（bspFile と settings への closure）
 *
 * detectStationPoint が要求する { lon, lonspeed } を返す関数を返す。
 * lonspeed は 1時間前進差分による近似（°/day）。
 *
 * @param {number} naifId  惑星の NAIF コード
 * @returns {function(jd: number): { lon: number, lonspeed: number }}
 */
function makeRetroCalcFn(naifId) {
  const DT = 1.0 / 24; // 1 hour
  return function(jd) {
    const p0 = computeApparent(naifId, jd);
    const p1 = computeApparent(naifId, jd + DT);
    const lonspeed = normAngularDiff(p0.lon, p1.lon) / DT; // °/day
    return { lon: p0.lon, lonspeed };
  };
}

/**
 * 期間内の全留点を検出する（純粋関数）
 *
 * detectStationPoint を繰り返し呼び、見つかった留点の直後から
 * 次の留点を探すことで全留点を収集する。
 *
 * @param {function} calcFn
 * @param {number}   startJD
 * @param {number}   endJD
 * @returns {Array<{jd, lon, type, speedBefore, speedAfter}>}
 */
function detectAllStations(calcFn, startJD, endJD) {
  const stations = [];
  let from = startJD;
  while (from < endJD) {
    const st = detectStationPoint(calcFn, from, endJD, {
      stepDays: 1.0,
      precisionHours: 0.01, // ~36 秒精度
    });
    if (!st) break;
    stations.push(st);
    from = st.jd + 2; // 留点の翌々日から再スキャン
  }
  return stations;
}

/**
 * 留点リストを逆行期間（開始・終了ペア）に変換する（純粋関数）
 *
 * @param {Array} stations
 * @returns {Array<{start: object|null, end: object|null}>}
 *   start/end が null = 検索期間の外側に留点がある（部分的逆行）
 */
function groupRetrogradePeriods(stations) {
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

// 初期ロード: de440s-modern.bsp → de440s.bsp（開発用フル版）の順に試みる
const settingsBsp = document.getElementById('settings-bsp');
initBsp(BSP_PATH_PROD)
  .catch(() => initBsp('data/de440s.bsp'))
  .catch(e => showBspError(e.message));

// ── 設定の適用ボタン ─────────────────────────────────────────────────
document.getElementById('settings-apply-btn').addEventListener('click', async () => {
  const bspSel   = document.getElementById('settings-bsp');
  const coordSel = document.getElementById('settings-coord');
  const statusEl = document.getElementById('settings-apply-status');
  const bspPath  = bspSel.value === 'dev' ? 'data/de440s.bsp' : BSP_PATH_PROD;
  const bspLabel = bspSel.value === 'dev' ? 'de440s.bsp（フル）' : 'de440s-modern.bsp（標準版）';
  const coordLabel = coordSel.value === 'j2000' ? 'J2000.0' : 'of-date（推奨）';

  // 座標系は即時反映
  settings.coordSystem = coordSel.value;

  // BSP 再読み込み
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

// ── タブ切り替え ───────────────────────────────────────────────────
// ── ウェルカム画面へ戻るユーティリティ ────────────────────────────
function showWelcome() {
  document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
  document.getElementById('tab-welcome')?.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
}

// ── ウェルカム：ロゴクリック ──────────────────────────────────────
document.querySelector('header h1')?.addEventListener('click', showWelcome);

// ── ウェルカム：フィーチャーカードクリック ─────────────────────────
document.querySelectorAll('.feature-card:not(.is-coming)').forEach(card => {
  card.addEventListener('click', () => {
    const tabId = card.dataset.tab;
    const subId = card.dataset.sub;

    // 対応するグループを開く（他は閉じる）
    document.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
    document.querySelector(`.nav-group[data-tab="${tabId}"]`)?.classList.add('open');

    // nav-item アクティブ設定
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`.nav-item[data-tab="${tabId}"][data-sub="${subId}"]`)?.classList.add('active');

    // タブ切り替え
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    document.getElementById(`tab-${tabId}`)?.classList.add('active');

    // サブコンテンツ切り替え
    const section = document.getElementById(`tab-${tabId}`);
    if (section) {
      section.querySelectorAll(':scope > .sub-content').forEach(s => s.classList.remove('active'));
      document.getElementById(subId)?.classList.add('active');
    }

    if (subId === 'settings-changelog') loadChangelog();
  });
});

// ── ハンバーガーメニュー：サイドバー開閉（スマホ用） ──────────────
document.getElementById('menu-toggle')?.addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ── サイドバー：ナビアイテム選択後にスマホではサイドバーを閉じる ──
function closeSidebarOnMobile() {
  if (window.innerWidth <= 600) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

// ── サイドバー：アコーディオン開閉 ────────────────────────────────
document.querySelectorAll('.nav-group-hd').forEach(hd => {
  hd.addEventListener('click', () => {
    hd.closest('.nav-group').classList.toggle('open');
  });
});

// ── サイドバー：ナビアイテム選択 ───────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tabId = item.dataset.tab;
    const subId = item.dataset.sub;

    closeSidebarOnMobile();

    // nav-item アクティブ状態
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    // tab-content 切り替え
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    document.getElementById(`tab-${tabId}`)?.classList.add('active');

    // sub-content 切り替え
    const section = document.getElementById(`tab-${tabId}`);
    if (section) {
      section.querySelectorAll(':scope > .sub-content').forEach(s => s.classList.remove('active'));
      document.getElementById(subId)?.classList.add('active');
    }

    // 更新履歴は遅延読み込み
    if (subId === 'settings-changelog') loadChangelog();
  });
});

// ── サブメニュー切り替え（第2レベル） ──────────────────────────────
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

// ── 未実装フォームのデフォルト送信を一括停止 ───────────────────────
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

// ── カスタム境界角度の表示切り替え ────────────────────────────────
document.getElementById('boundary-preset').addEventListener('change', e => {
  document.getElementById('boundary-custom-row').style.display =
    e.target.value === 'custom' ? 'flex' : 'none';
});

// ── 住所ジオコーディング（Nominatim / OpenStreetMap） ───────────────
/**
 * 住所文字列から緯度・経度候補を取得する（純粋 fetch 関数）
 * @param {string} query - 住所文字列
 * @returns {Promise<Array<{lat:number, lon:number, displayName:string}>>}
 * Data: © OpenStreetMap contributors (ODbL)
 */
async function geocodeAddress(query) {
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
function attachGeocodeHandler(prefix) {
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

// 住所検索を使う全フォームに一括登録
['natal', 'sunrise', 'moonrise', 'landscape', 'medieval'].forEach(attachGeocodeHandler);

// ── ユーティリティ ─────────────────────────────────────────────────

/** JST の datetime-local 文字列 → TDB JD */
function jstInputToJdTdb(datetimeLocal) {
  const [datePart, timePart] = datetimeLocal.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = (timePart || '00:00').split(':').map(Number);
  // JST = UTC+9 → UTC
  const utcHour = hh - 9;
  const jdUtc = dateToJd(y, m, d + utcHour / 24 + mm / 1440);
  return jdUtcToTdb(jdUtc);
}


const ZODIAC_SIGNS_JP = [
  '牡羊座','牡牛座','双子座','蟹座','獅子座','乙女座',
  '天秤座','蠍座','射手座','山羊座','水瓶座','魚座'
];

// IAU 黄道星座の黄経境界（J2000.0 近似値、昇順）
// lon は度を100倍した整数（センチ度）で保持し、浮動小数点比較の誤差を排除する。
// 出典: Delporte (1930) "Délimitation scientifique des constellations" IAU 星座境界を
//       J2000.0 黄道座標に射影した近似値。蛇遣座（Oph）を含む13星座。
// 注意: 歳差により境界は ~0.014°/年 移動するが、1950–2100 年の範囲では ±1° 以内の誤差。
//
// 対応: 28.69° → 2869 centideg, 53.45° → 5345 …
const IAU_ZODIAC_BOUNDS = Object.freeze([
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
 * 占星術の均等 30° 分割（lonToSign）とは異なり、
 * IAU 星座境界（13星座・不等幅）を使う。
 *
 * 境界はセンチ度（×100 整数）で保持し浮動小数点誤差を排除。
 * 0°〜28.69° は魚座（351.65° から 0° をまたぐ）。
 *
 * @param {number} lon 黄経（度, J2000.0 または of-date）
 * @returns {string} "星座名 (Abbr)"
 */
function lonToIauConstellation(lon) {
  // センチ度（整数）に変換して比較を exact にする
  const n = Math.round(((lon % 360) + 360) % 360 * 100);
  let best = null;
  for (const b of IAU_ZODIAC_BOUNDS) {
    if (n >= b.lon) best = b;
  }
  // n < 2869（=28.69°）は魚座の折り返しゾーン（0°〜28.69°）
  if (!best) best = IAU_ZODIAC_BOUNDS[IAU_ZODIAC_BOUNDS.length - 1];
  return `${best.name} (${best.abbr})`;
}

/** 小数点以下3桁・切り捨て表示 */
function trunc3(n) {
  return (Math.trunc(n * 1000) / 1000).toFixed(3);
}

/** 占星術用: 黄経（度）→ 星座名 + 残り度数（均等 30° 分割） */
function lonToSign(lon) {
  const idx = Math.floor(lon / 30);
  const degInSign = Math.trunc((lon - idx * 30) * 1000) / 1000;
  return `${ZODIAC_SIGNS_JP[idx]} ${degInSign.toFixed(3)}°`;
}

/** 結果エリアに表示 */
function showResult(elId, html, isError = false) {
  const el = document.getElementById(elId);
  el.innerHTML = html;
  el.className = 'result-area visible' + (isError ? ' error' : '');
}

/**
 * 進捗バーつきのローディング表示を result-area に描画する。
 * @param {string} elId      result-area の要素 ID
 * @param {string} [label]   主メッセージ（省略時: "計算中…"）
 * @param {string} [sub]     サブメッセージ（省略時: なし）
 */
function showLoading(elId, label = '計算中…', sub = '') {
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
 * 確定した進捗 % をプログレスバーに反映する
 * showLoading で表示済みの要素に対して呼ぶ
 * @param {string} elId   result 要素の ID
 * @param {number} pct    0〜100 の進捗率
 * @param {string} sub    サブラベル（天体名など）
 */
function setProgress(elId, pct, sub = '') {
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
function yieldFrame() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** BSP が未ロードなら警告を出して false を返す */
function requireBsp(resultElId) {
  if (!bspFile) {
    showResult(resultElId, '⚠️ BSP ファイルが読み込まれていません。設定タブで再読み込みしてください。', true);
    return false;
  }
  return true;
}

// ── 惑星位置計算（地心） ──────────────────────────────────────────
// 地心計算で使う惑星 NAIF コード（DE440s 収録の barycenter コードを使用）
const GEOCENTRIC_PLANETS = [
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

// ── 月の交点（Lunar Nodes）────────────────────────────────────────────
// Python spacefield の calc_lunar_nodes に相当。
// BSP には収録されていないため Meeus IAU 式（多項式）で計算する。

/**
 * 月の昇交点（ノースノード）・降交点（サウスノード）の黄経を返す
 *
 * 平均交点（Mean Node）: Meeus "Astronomical Algorithms" Ch.22 の IAU 式
 *   Ω = 125.04452° − 1934.136261°T + 0.0020708°T² + T³/450000
 * 精度: 数秒〜数分（占星術用途に十分）
 * Python spacefield と同一式。
 *
 * @param {number} jdTdb  ユリウス日（TDB）
 * @returns {{ north: number, south: number }}  0〜360° の黄経
 */
function moonNode(jdTdb) {
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
function moonNodeSpeed(jdTdb) {
  const DT = 1;   // 1日差分
  const a = moonNode(jdTdb - DT).north;
  const b = moonNode(jdTdb + DT).north;
  let d = b - a;
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return d / (2 * DT);
}

// ── 逆行期間計算 ────────────────────────────────────────────────────
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

/**
 * 1惑星分の逆行期間テーブル HTML を生成する（純粋関数）
 * @param {object} info   RETRO_PLANET_INFO のエントリ
 * @param {Array}  periods groupRetrogradePeriods の戻り値
 * @param {string} coordLabel 座標系ラベル文字列
 * @param {string} startStr / endStr 表示用期間文字列
 * @returns {string} HTML
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

document.getElementById('form-retro').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-retro')) return;

  const planetVal = document.getElementById('retro-planet').value;
  const startStr  = document.getElementById('retro-start').value;
  const endStr    = document.getElementById('retro-end').value;
  const startJD   = datetimeLocalToJdTdb(startStr);
  const endJD     = datetimeLocalToJdTdb(endStr);

  if (endJD <= startJD) {
    showResult('result-retro', '終了日時が開始日時以前です。', true);
    return;
  }

  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
  const targets = planetVal === 'all'
    ? Object.values(RETRO_PLANET_INFO)
    : [RETRO_PLANET_INFO[parseInt(planetVal, 10)]].filter(Boolean);

  if (targets.length === 0) {
    showResult('result-retro', '対応していない天体です。', true);
    return;
  }

  let html = '';
  for (const info of targets) {
    const calcFn  = makeRetroCalcFn(info.naifId);
    const stations = detectAllStations(calcFn, startJD, endJD);
    const periods  = groupRetrogradePeriods(stations);
    html += buildRetroTable(info, periods, coordLabel, startStr, endStr);
  }

  showResult('result-retro', html);
});

// ── 逆行計算 #3: 物理量逆行計算（天文学用） ────────────────────────

/**
 * 1惑星分の物理量逆行テーブル HTML を生成する（純粋関数）
 *
 * 星座ラベルを使わず、生黄経(°)・角速度ω(°/day)・ピーク逆行速度を表示する。
 * ピーク逆行速度: 逆行期間の中間付近を1日刻みでサンプリングして最小ωを求める。
 *
 * @param {object}   info      RETRO_PLANET_INFO のエントリ
 * @param {Array}    periods   groupRetrogradePeriods の戻り値
 * @param {function} calcFn    makeRetroCalcFn の戻り値
 * @param {string}   coordLabel
 * @param {string}   startStr / endStr 表示用
 * @returns {string} HTML
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

    // ピーク逆行速度: 期間中間を1日刻みサンプリング
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

document.getElementById('form-retro-physical').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-retro-physical')) return;

  const planetVal  = document.getElementById('retro-phys-planet').value;
  const startStr   = document.getElementById('retro-phys-start').value;
  const endStr     = document.getElementById('retro-phys-end').value;
  const startJD    = datetimeLocalToJdTdb(startStr);
  const endJD      = datetimeLocalToJdTdb(endStr);
  if (endJD <= startJD) { showResult('result-retro-physical', '終了日時が開始日時以前です。', true); return; }

  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
  const targets = planetVal === 'all'
    ? Object.values(RETRO_PLANET_INFO)
    : [RETRO_PLANET_INFO[parseInt(planetVal, 10)]].filter(Boolean);

  let html = '';
  for (const info of targets) {
    const calcFn  = makeRetroCalcFn(info.naifId);
    const stations = detectAllStations(calcFn, startJD, endJD);
    const periods  = groupRetrogradePeriods(stations);
    html += buildRetroPhysicalTable(info, periods, calcFn, coordLabel, startStr, endStr);
  }
  showResult('result-retro-physical', html);
});

// ── 逆行計算 #4: 逆行連続物理量計算 ────────────────────────────────

/**
 * 1逆行期間分の連続物理量テーブル HTML を生成する（純粋関数）
 *
 * D→R 留から R→D 留まで、指定ステップで λ(°) / ω(°/day) を出力する。
 *
 * @param {object}   info
 * @param {{start, end}} period  逆行期間（start/end が null の場合は境界を範囲端で補完）
 * @param {function} calcFn
 * @param {number}   stepDays   出力ステップ（日）
 * @param {number}   rangeStartJD 検索範囲の開始（start=null 時の補完用）
 * @param {number}   rangeEndJD   検索範囲の終了（end=null 時の補完用）
 * @param {number}   periodIndex  表示用連番
 * @returns {string} HTML
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

document.getElementById('form-retro-continuous').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-retro-continuous')) return;

  const planetVal = document.getElementById('retro-cont-planet').value;
  const startStr  = document.getElementById('retro-cont-start').value;
  const endStr    = document.getElementById('retro-cont-end').value;
  const stepDays  = parseFloat(document.getElementById('retro-cont-step').value);
  const startJD   = datetimeLocalToJdTdb(startStr);
  const endJD     = datetimeLocalToJdTdb(endStr);
  if (endJD <= startJD) { showResult('result-retro-continuous', '終了日時が開始日時以前です。', true); return; }

  const info = RETRO_PLANET_INFO[parseInt(planetVal, 10)];
  if (!info) { showResult('result-retro-continuous', '対応していない天体です。', true); return; }

  const calcFn   = makeRetroCalcFn(info.naifId);
  const stations = detectAllStations(calcFn, startJD, endJD);
  const periods  = groupRetrogradePeriods(stations);

  if (periods.length === 0) {
    showResult('result-retro-continuous',
      `<p style="color:var(--text-muted)">${info.name}：この期間に逆行は検出されませんでした。</p>`);
    return;
  }

  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
  let html = `<p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">
    ${info.name} / ${coordLabel} / ステップ ${stepDays < 1 ? `${Math.round(stepDays * 24)}時間` : `${stepDays}日`}
    / ${periods.length} 件の逆行期間</p>`;

  periods.forEach((period, i) => {
    html += buildRetroContinuousSection(info, period, calcFn, stepDays, startJD, endJD, i);
  });

  showResult('result-retro-continuous', html);
});

// ── 惑星間アスペクト時系列 ──────────────────────────────────────────

/** アスペクト定義: 表示値 → { name, symbol, angles[] } */
const ASPECT_DEFS = Object.freeze({
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

/** 惑星 NAIF ID → { name, speedKey } */
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

/**
 * 2惑星間のアスペクト通過 JD を検出する（純粋関数）
 *
 * Python 版 angular_sep() と同方式（0〜180° 折りたたみ）を採用し、
 * 各アスペクトを1事象につき1件だけ検出する（対称角での誤検出を防止）。
 *
 * - 0°  : ((lonA − lonB + 180) % 360) − 180  → 合の前後で符号反転
 * - 180°: ((lonA − lonB) % 360) − 180         → 衝の前後で符号反転
 * - 他  : foldedSep(lonA, lonB) − target       → 折りたたみ後の単調偏差
 *
 * @param {function} calcFnA  JD → { lon } (天体 A の黄経)
 * @param {function} calcFnB  JD → { lon } (天体 B の黄経)
 * @param {number}   target   目標角度（度, 0〜180 の標準角）
 * @param {number}   startJD
 * @param {number}   endJD
 * @param {object}   [opts]
 * @param {number}   [opts.stepDays=1.0]        粗スキャンのステップ（日）
 * @param {number}   [opts.precisionHours=0.01] 二分探索の精度（時間）
 * @returns {Array<{ jd: number, lonA: number, lonB: number, sep: number }>}
 */
function detectAspectCrossings(calcFnA, calcFnB, target, startJD, endJD, opts = {}) {
  const stepDays = opts.stepDays   ?? 1.0;
  const precJD   = (opts.precisionHours ?? 0.01) / 24;

  // 折りたたみ角距離 [0, 180] — Python angular_sep() と同等
  function foldedSep(jd) {
    const diff = ((calcFnA(jd).lon - calcFnB(jd).lon) % 360 + 360) % 360;
    return diff <= 180 ? diff : 360 - diff;
  }

  // 符号反転でゼロ交差を検出する偏差関数
  function deviation(jd) {
    const lonA = calcFnA(jd).lon;
    const lonB = calcFnB(jd).lon;
    if (target === 0) {
      // 合: ((lonA − lonB + 180) % 360) − 180
      return ((lonA - lonB + 180 + 360) % 360) - 180;
    }
    if (target === 180) {
      // 衝: ((lonA − lonB) % 360) − 180
      return ((lonA - lonB + 360) % 360) - 180;
    }
    // 30°〜150°: 折りたたみ距離 − target（ラップアラウンド不要）
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
      results.push({
        jd:   crossJD,
        lonA,
        lonB,
        sep: diff <= 180 ? diff : 360 - diff,
      });
    }

    prevJD  = jd;
    prevDev = currDev;
  }

  return results;
}

document.getElementById('form-aspects-ts').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-aspects-ts')) return;

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

  // 選択されたアスペクト種を収集
  const checkedTypes = [...document.querySelectorAll('input[name="asp-ts-type"]:checked')]
    .map(el => parseInt(el.value, 10));
  if (checkedTypes.length === 0) {
    showResult('result-aspects-ts', 'アスペクト種を1つ以上選択してください。', true);
    return;
  }

  const infoA = ASP_PLANET_MAP[naifA];
  const infoB = ASP_PLANET_MAP[naifB];

  // スキャンステップ: 相対角速度から算出（最小 0.3 日、最大 20 日）
  const spdA    = AVG_SPEEDS[infoA.speedKey] ?? 0.5;
  const spdB    = AVG_SPEEDS[infoB.speedKey] ?? 0.5;
  const relSpd  = Math.abs(spdA - spdB) || 0.001;
  const stepDays = Math.min(20, Math.max(0.3, 4 / relSpd));

  const calcFnA = jd => computeApparent(naifA, jd);
  const calcFnB = jd => computeApparent(naifB, jd);

  // 全アスペクトを検出してまとめてソート
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

  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
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

// ── 8. 太陽黄経暦（1° 刻み連続物理量） ─────────────────────────────

/** 24節気: 黄経（度）→ { name, nodeType } — Python版 SOLAR_TERMS と同定義 */
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

/**
 * 太陽黄経暦（1° 刻み、360行）を算出する純粋関数。
 *
 * Python版 calculate_solar_longitude_almanac() と同アルゴリズム:
 *   1. 年初の太陽黄経を取得 → 最初の目標度数（切り上げ）
 *   2. 各 1° 通過時刻を二分探索で算出（deviation = ((lon−target+180)%360)−180）
 *   3. 速度 = ±0.5日差分（°/日）、滞在時間 = 前の度数からの経過時間
 *
 * @param {number} year  対象年（1900〜2100）
 * @returns {Array<{lon, jd, jst, termName, nodeType, sign, speed, dwell, dwellHours}>}
 */
function calculateSolarAlmanac(year) {
  const SUN    = NAIF.SUN;
  const precJD = 0.5 / 86400;  // 0.5秒精度（calculateSolarTerms と統一）

  // 年初 JD（1月1日 00:00 JST）— UTC ベースで管理し jdToJstStr と整合させる
  const jdJan1Utc = dateStrToJdUtcMidJst(`${year}-01-01`);
  const lonStart  = computeApparent(SUN, jdUtcToTdb(jdJan1Utc)).lon;
  const startDeg  = Math.ceil(lonStart) % 360;

  // 360° 分の目標度数リスト（年初の黄経から昇順）
  const degrees = Array.from({ length: 360 }, (_, i) => (startDeg + i) % 360);

  // deviation 関数: jdUtc を受け取り TDB に変換して評価
  function dev(jdUtc, target) {
    const lon = computeApparent(SUN, jdUtcToTdb(jdUtc)).lon;
    return ((lon - target + 180 + 360) % 360) - 180;
  }

  // 符号付き角度差（ラップアラウンド対応）
  function angDiff(from, to) {
    let d = to - from;
    if (d >  180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // 各度数の通過 JD（UTC）を順次二分探索
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
    const crossJD = (lo + hi) / 2;  // UTC JD
    crossings.push({ lon: target, jd: crossJD });
    jdPrev = crossJD;
  }

  // 各行の物理量を構築
  return crossings.map((c, idx) => {
    const { lon, jd } = c;

    // 速度（°/日）: ±0.5日差分（UTC JD を TDB に変換して評価）
    const lonAfter  = computeApparent(SUN, jdUtcToTdb(jd + 0.5)).lon;
    const lonBefore = computeApparent(SUN, jdUtcToTdb(jd - 0.5)).lon;
    const speed = Math.round(angDiff(lonBefore, lonAfter) * 10000) / 10000;

    // 滞在時間（前の度数からの経過時間）
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
      sign:      ZODIAC_SIGNS_JP[Math.floor(lon / 30) % 12],
      speed,
      dwell:     dwellStr,
      dwellHours: Math.round(dwellHours * 100) / 100,
    };
  });
}

document.getElementById('form-solar-cal').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireBsp('result-solar-cal')) return;

  const year = parseInt(document.getElementById('solar-cal-year').value, 10);
  if (isNaN(year) || year < 1900 || year > 2100) {
    showResult('result-solar-cal', '年は 1900〜2100 の範囲で入力してください。', true);
    return;
  }

  showLoading('result-solar-cal', '計算中…', `${year} 年の二十四節気を二分探索（24 回）`);
  await yieldFrame();

  // UIを更新してから重い計算を開始
  setTimeout(() => {
    try {
      const rows = calculateSolarAlmanac(year);
      const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';

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
        <p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">
          太陽黄経暦 ${year} / ${coordLabel} / ${rows.length} 行
        </p>
        <table class="result-table">
          <thead>
            <tr>
              <th>黄経</th>
              <th>通過日時（JST）</th>
              <th>節気</th>
              <th>区分</th>
              <th>星座</th>
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

// ── 7. 任意境界角度通過検出 ────────────────────────────────────────

/**
 * 指定した境界角度を天体が通過する JD を検出する（純粋関数）。
 *
 * Python版 bisect_boundary_chart と同アルゴリズム:
 *   deviation(lon) = ((lon − boundary + 180) % 360) − 180
 * これが符号反転する区間を二分探索で精密化する。
 *
 * @param {function} calcFn       JD → { lon } (天体の黄経)
 * @param {number[]} boundaries   境界角度リスト [0, 360)
 * @param {number}   startJD
 * @param {number}   endJD
 * @param {object}   [opts]
 * @param {number}   [opts.stepDays=0.25]       粗スキャンステップ（日）
 * @param {number}   [opts.precisionHours=0.01] 二分探索精度（時間）
 * @returns {Array<{ jd, boundary, lon, lonspeed }>}
 */
function detectBoundaryCrossings(calcFn, boundaries, startJD, endJD, opts = {}) {
  const stepDays = opts.stepDays      ?? 0.25;
  const precJD   = (opts.precisionHours ?? 0.01) / 24;

  // 二分探索用偏差関数（境界通過後の精密化のみに使用）
  function dev(lon, bnd) {
    return ((lon - bnd + 180 + 360) % 360) - 180;
  }

  // 符号付き角度差（ラップアラウンド対応）
  function angularDiff(from, to) {
    let d = to - from;
    if (d >  180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // Python版と同方式の粗スキャン検出（対角境界の誤検出を防止）
  // delta > 0: 順行、delta < 0: 逆行
  function crossedBoundary(prevLon, curLon, bnd) {
    const delta = angularDiff(prevLon, curLon);
    const d0    = dev(prevLon, bnd);
    const d1    = dev(curLon,  bnd);
    // 実際に境界を通過したときは |d0 - d1| ≈ |delta|（小さい値）
    // 対角境界(bnd+180°)での誤検出時は |d0 - d1| ≈ 360（大きい値）
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
        // 角速度: ±0.5時間の差分（0°/360° ラップアラウンド対応）
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

/** 境界角度プリセット定義 */
const BOUNDARY_PRESETS = Object.freeze({
  30:  { label: '30° 刻み（12分割）', values: Array.from({ length: 12 }, (_, i) => i * 30)  },
  45:  { label: '45° 刻み（8分割）',  values: Array.from({ length: 8  }, (_, i) => i * 45)  },
  60:  { label: '60° 刻み（6分割）',  values: Array.from({ length: 6  }, (_, i) => i * 60)  },
  90:  { label: '90° 刻み（4分割）',  values: Array.from({ length: 4  }, (_, i) => i * 90)  },
});

/** 境界通過検出で使う惑星リスト（全天体） */
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

// カスタム行の表示切り替え
document.getElementById('boundary-preset').addEventListener('change', e => {
  document.getElementById('boundary-custom-row').style.display =
    e.target.value === 'custom' ? '' : 'none';
});

document.getElementById('form-boundary').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-boundary')) return;

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

  // 境界角度を決定
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

  // 対象惑星を決定
  const targetPlanets = planetVal === 'all'
    ? BOUNDARY_PLANETS
    : BOUNDARY_PLANETS.filter(p => p.id === parseInt(planetVal, 10));

  // スキャンステップ：月は0.1日、他は0.25日
  const hasMoon = targetPlanets.some(p => p.id === NAIF.MOON);
  const stepDays = hasMoon ? 0.1 : 0.25;

  const allEvents = [];
  for (const planet of targetPlanets) {
    const calcFn = jd => computeApparent(planet.id, jd);
    const crossings = detectBoundaryCrossings(calcFn, boundaries, startJD, endJD, {
      stepDays,
      precisionHours: 0.01,
    });
    for (const c of crossings) {
      allEvents.push({ ...c, planet });
    }
  }
  allEvents.sort((a, b) => a.jd - b.jd);

  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';

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

// ── ヘリオセントリック計算（天文計算メニュー） ─────────────────────────────
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

document.getElementById('form-helio').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-helio')) return;

  const jdTdb = jstInputToJdTdb(document.getElementById('helio-sci-datetime').value);
  const coordLabel = settings.coordSystem === 'j2000' ? '黄経（J2000.0）' : '黄経（of-date）';

  let rows = '';
  for (const { id: naifId, name } of HELIOCENTRIC_PLANETS) {
    try {
      const { lon, lat, dist, speedKmS } = computeHeliocentric(naifId, jdTdb);
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

document.getElementById('form-planet-pos').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-planet-pos')) return;

  const jdTdb = jstInputToJdTdb(document.getElementById('planet-datetime').value);

  let rows = '';
  for (const { id: naifId, name } of GEOCENTRIC_PLANETS) {
    try {
      const { lon, lat, dist } = computeApparent(naifId, jdTdb);
      const distAu = dist / AU_KM;
      rows += `<tr>
        <td>${name}</td>
        <td>${lonToSign(lon)}</td>
        <td>${trunc3(lon)}°</td>
        <td>${trunc3(lat)}°</td>
        <td>${trunc3(distAu)}</td>
      </tr>`;
    } catch (err) {
      rows += `<tr><td>${name}</td><td colspan="4" style="color:var(--text-muted)">計算不可: ${err.message}</td></tr>`;
    }
  }

  const coordLabel = settings.coordSystem === 'j2000'
    ? '黄経（J2000.0）'
    : '黄経（IAU of-date）';
  showResult('result-planet-pos', `
    <table class="result-table">
      <thead><tr><th>天体</th><th>IAU 星座</th><th>${coordLabel}</th><th>黄緯</th><th>地球からの距離 (AU)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
});

// ── ホロスコープ計算（3-1-1） ─────────────────────────────────────
const HOUSE_FN_MAP = {
  placidus:      housesPlacidus,
  koch:          housesKoch,
  equal:         housesEqual,
  whole:         housesWholeSigns,
  regiomontanus: housesRegiomontanus,
  campanus:      housesCampanus,
};

document.getElementById('form-natal').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-natal')) return;

  const jdTdb   = jstInputToJdTdb(document.getElementById('natal-datetime').value);
  const lat     = parseFloat(document.getElementById('natal-lat').value);
  const lon     = parseFloat(document.getElementById('natal-lon').value);
  const hSystem = document.getElementById('natal-house').value;
  const zodiac  = document.getElementById('natal-zodiac').value;

  const ayanamshaVal =
    zodiac === 'sidereal-lahiri'  ? ayanamsha(jdTdb, AYANAMSHA.LAHIRI)        :
    zodiac === 'sidereal-fagan'   ? ayanamsha(jdTdb, AYANAMSHA.FAGAN_BRADLEY) :
    0;

  // ハウス計算
  let cusps, angles;
  try {
    const hFn = HOUSE_FN_MAP[hSystem] ?? housesPlacidus;
    ({ cusps, angles } = hFn(jdTdb, lat, lon));
  } catch (err) {
    showResult('result-natal', `ハウス計算エラー: ${err.message}`, true);
    return;
  }

  // 惑星位置（光行時間補正 + 年周光行差適用）+ 角速度（逆行判定用）
  const DT_NATAL = 1 / 24;  // 1 時間差分（°/day 換算）
  const planets = [];
  for (const { id: naifId, name } of GEOCENTRIC_PLANETS) {
    try {
      let { lon: pLon, lat: pLat } = computeApparent(naifId, jdTdb);
      const lonNext = computeApparent(naifId, jdTdb + DT_NATAL).lon;
      let spd = normAngularDiff(pLon, lonNext) / DT_NATAL;  // °/day
      pLon = normAngle(pLon - ayanamshaVal);
      planets.push({ id: naifId, name, lon: pLon, lat: pLat, lonspeed: spd });
    } catch { /* skip */ }
  }
  // 月の交点（Meeus IAU 式・BSP 不要）— 速度は別関数で取得
  { const { north, south } = moonNode(jdTdb);
    const nodeSpd = moonNodeSpeed(jdTdb);  // °/day（通常 < 0）
    planets.push({ id: 'NORTH_NODE', name: '☊ ノースノード', lon: normAngle(north - ayanamshaVal), lat: 0, lonspeed: nodeSpd });
    planets.push({ id: 'SOUTH_NODE', name: '☋ サウスノード', lon: normAngle(south - ayanamshaVal), lat: 0, lonspeed: -nodeSpd }); }

  // シジジー計算（直前の朔/望）
  let syzRow = '';
  try {
    const NAIF_SUN  = NAIF.SUN;
    const NAIF_MOON = NAIF.MOON;
    const sunFn  = jd => { const r = computeApparent(NAIF_SUN,  jd); return { lon: r.lon }; };
    const moonFn = jd => { const r = computeApparent(NAIF_MOON, jd); return { lon: r.lon }; };
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

  // アスペクト
  const aspects = getAllAspects(
    planets.map(p => ({ id: p.id, lon: p.lon, speed: 0 })),
    MAJOR_ASPECTS
  );

  // 惑星のハウス番号を求める（カスプ配列から）
  function getHouseNum(lon, cusps) {
    for (let i = 0; i < 12; i++) {
      const c1 = cusps[i];
      const c2 = cusps[(i + 1) % 12];
      // カスプをまたぐ場合（例: H12 が 330°→20°）を考慮
      const inHouse = c2 > c1
        ? lon >= c1 && lon < c2
        : lon >= c1 || lon < c2;
      if (inHouse) return i + 1;
    }
    return 1;
  }

  // 表示
  const adjustedCusps = cusps.map(c => normAngle(c - ayanamshaVal));
  const planetRows = planets.map(p => {
    const hNum   = getHouseNum(p.lon, adjustedCusps);
    const isRetro = p.lonspeed != null && p.lonspeed < 0;
    const rxMark  = isRetro ? ' <span style="color:#f4a460;font-size:10px" title="逆行中">℞</span>' : '';
    return `<tr><td>${p.name}${rxMark}</td><td>H${hNum}</td><td>${lonToSign(p.lon)}</td><td>${trunc3(p.lon)}°</td><td>${trunc3(p.lat)}°</td></tr>`;
  }).join('') + syzRow;

  const houseRows = adjustedCusps.map((c, i) =>
    `<tr><td>H${i + 1}</td><td>${lonToSign(c)}</td><td>${trunc3(c)}°</td></tr>`
  ).join('');

  // angles = [asc, mc, desc, ic]（配列）
  const [ascDeg, mcDeg] = angles;
  const ASPECT_SYMBOL = { 0: '☌ コンジャンクション', 60: '⚹ セクスタイル', 90: '□ スクエア', 120: '△ トライン', 180: '☍ オポジション' };
  const MOVEMENT_JP   = { applying: '接近', separating: '離脱', exact: '正確', stationary: '留', none: '-' };

  const planetNameById = Object.fromEntries(planets.map(p => [p.id, p.name]));
  const aspectRows = aspects.slice(0, 20).map(a =>
    `<tr><td>${planetNameById[a.planet1] ?? a.planet1}</td><td>${ASPECT_SYMBOL[a.type] ?? `${a.type}°`}</td><td>${planetNameById[a.planet2] ?? a.planet2}</td><td>${a.orb.toFixed(2)}°</td></tr>`
  ).join('');

  const zodiacLabel = zodiac === 'tropical' ? 'トロピカル' : zodiac === 'sidereal-lahiri' ? 'サイデリアル・ラーヒリー' : 'サイデリアル・フェーガン';
  const coordSuffix = settings.coordSystem === 'j2000' ? ' / J2000.0' : ' / of-date';
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

// ── 3-1-2: 期間トランジット ──────────────────────────────────────────────────
// 太陽黄経の角度中点を二分探索して代表日時を求め、その瞬間のホロスコープを計算する

/**
 * 太陽黄経の角度中点を求める（純粋ヘルパー）
 * 360°/0°境界を跨ぐ場合を正しく処理する
 * @param {number} lonA - 開始時の太陽黄経（度）
 * @param {number} lonB - 終了時の太陽黄経（度）
 * @returns {number} 角度中点（0〜360°）
 */
function solarAngularMidpoint(lonA, lonB) {
  // 符号付き差分で方向を求め、半分進んだ位置
  let d = lonB - lonA;
  if (d >  180) d -= 360;
  if (d < -180) d += 360;
  return normAngle(lonA + d / 2);
}

['transit'].forEach(attachGeocodeHandler);

document.getElementById('form-modern-transit').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-modern-transit')) return;

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

  // 太陽黄経の角度中点を求める
  const lonStart  = normAngle(computeApparent(NAIF.SUN, startJdTdb).lon - ayanamshaVal);
  const lonEnd    = normAngle(computeApparent(NAIF.SUN, endJdTdb).lon   - ayanamshaVal);
  const midLon    = solarAngularMidpoint(lonStart, lonEnd);

  // 二分探索: 太陽が midLon を通過する JD（期間内）
  function sunLonDev(jdTdb) {
    const lon = normAngle(computeApparent(NAIF.SUN, jdTdb).lon - ayanamshaVal);
    let d = lon - midLon;
    if (d >  180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }
  let midJdTdb;
  const d0 = sunLonDev(startJdTdb), d1 = sunLonDev(endJdTdb);
  if (d0 * d1 > 0) {
    // 期間内に通過しない（逆行などの特殊ケース）→ 期間の数値中点を使用
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

  const periodDays = endJdTdb - startJdTdb;
  const method = periodDays <= 31 ? '角度中点基準法' : '角度中点基準法（31日超）';

  // ハウス計算
  let cusps, angles;
  try {
    const hFn = HOUSE_FN_MAP[hSystem] ?? housesPlacidus;
    ({ cusps, angles } = hFn(midJdTdb, lat, lon));
  } catch (err) {
    showResult('result-modern-transit', `ハウス計算エラー: ${err.message}`, true);
    return;
  }

  const adjustedCusps = cusps.map(c => normAngle(c - ayanamshaVal));

  function getHouseNum(pLon, hCusps) {
    for (let i = 0; i < 12; i++) {
      const c1 = hCusps[i];
      const c2 = hCusps[(i + 1) % 12];
      const inHouse = c2 > c1 ? pLon >= c1 && pLon < c2 : pLon >= c1 || pLon < c2;
      if (inHouse) return i + 1;
    }
    return 1;
  }

  const planets = [];
  for (const { id: naifId, name } of GEOCENTRIC_PLANETS) {
    try {
      let { lon: pLon, lat: pLat } = computeApparent(naifId, midJdTdb);
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
  const coordSuffix = settings.coordSystem === 'j2000' ? ' / J2000.0' : ' / of-date';

  const midDateStr = jdToJstStr(midJdTdb);
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

// ── 3-1-3: 惑星星座運行計算（現代・10惑星） ──────────────────────────────

// 現代占星術 10惑星イングレス: サンプリング間隔
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

document.getElementById('form-modern-ingress').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireBsp('result-modern-ingress')) return;

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
    const calcFn   = jd => computeApparent(planet.id, jdUtcToTdb(jd));
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

  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
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

// ── 3-1-4: アスペクト計算 ────────────────────────────────────────────────────

const ASPECT_DEFS_FULL = Object.freeze([
  { type:   0, symbol: '☌', name: 'コンジャンクション（合）'  },
  { type:  60, symbol: '⚹', name: 'セクスタイル（六分）'       },
  { type:  90, symbol: '□', name: 'スクエア（四分）'           },
  { type: 120, symbol: '△', name: 'トライン（三分）'           },
  { type: 180, symbol: '☍', name: 'オポジション（衝）'         },
]);

document.getElementById('form-modern-aspects').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-modern-aspects')) return;

  const dtVal  = document.getElementById('aspects-datetime').value;
  const orbVal = parseFloat(document.getElementById('aspects-orb').value);

  const jdTdb = jstInputToJdTdb(dtVal);

  // 惑星位置取得（角速度付き）
  // ※ アスペクト = 惑星間の角度差。アヤナムシャは両惑星に等量加わるため相殺され、結果に影響しない。
  const DT = 1 / 24;
  const planets = [];
  for (const { id: naifId, name } of GEOCENTRIC_PLANETS) {
    try {
      const { lon: pLon }   = computeApparent(naifId, jdTdb);
      const lonPrev = computeApparent(naifId, jdTdb - DT).lon;
      const lonNext = computeApparent(naifId, jdTdb + DT).lon;
      let speed = lonNext - lonPrev;
      if (speed >  180) speed -= 360;
      if (speed < -180) speed += 360;
      speed = speed / (2 * DT);
      planets.push({ id: naifId, name, lon: pLon, speed });
    } catch { /* skip */ }
  }
  // 月の交点（Meeus IAU 式）
  { const { north, south } = moonNode(jdTdb);
    const spd = moonNodeSpeed(jdTdb);
    planets.push({ id: 'NORTH_NODE', name: '☊ ノースノード', lon: north, speed: spd });
    planets.push({ id: 'SOUTH_NODE', name: '☋ サウスノード', lon: south, speed: spd }); }

  // 全惑星ペアのアスペクトを検出
  const aspList = [];
  for (let i = 0; i < planets.length; i++) {
    for (let j = i + 1; j < planets.length; j++) {
      const pA = planets[i], pB = planets[j];
      let sep = Math.abs(pA.lon - pB.lon) % 360;
      if (sep > 180) sep = 360 - sep;

      for (const def of ASPECT_DEFS_FULL) {
        const orb = Math.abs(sep - def.type);
        if (orb <= orbVal) {
          // 接近/分離: 速い方が遅い方に近づいているかどうか
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

  // オーブの小さい順にソート
  aspList.sort((a, b) => a.orb - b.orb);

  const coordSuffix = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
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

  const dtDisplay = dtVal.replace('T', ' ');
  showResult('result-modern-aspects', `
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
      ${dtDisplay} JST　|　座標系: ${coordSuffix}　|　オーブ ±${orbVal}°　|　${aspList.length} 件
    </p>
    <table class="result-table">
      <thead><tr>
        <th>天体A</th><th>アスペクト</th><th>天体B</th><th>オーブ</th><th>状態</th>
      </tr></thead>
      <tbody>${aspRows || '<tr><td colspan="5" style="color:var(--text-muted)">アスペクトなし</td></tr>'}</tbody>
    </table>`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ════════════════════ 中世西洋占星術モード ══════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// 7惑星（古典）= 土星まで（外惑星・冥王星は含まない）
const MEDIEVAL_PLANETS = [
  { id: NAIF.SUN,                name: '太陽' },
  { id: NAIF.MOON,               name: '月' },
  { id: NAIF.MERCURY_BARYCENTER, name: '水星' },
  { id: NAIF.VENUS_BARYCENTER,   name: '金星' },
  { id: NAIF.MARS_BARYCENTER,    name: '火星' },
  { id: NAIF.JUPITER_BARYCENTER, name: '木星' },
  { id: NAIF.SATURN_BARYCENTER,  name: '土星' },
];

// イングレス計算用: 惑星ごとの最適サンプリング間隔（日単位）
const MEDIEVAL_INGRESS_STEP = Object.freeze({
  [NAIF.MOON]:               0.5,
  [NAIF.SUN]:                1.0,
  [NAIF.MERCURY_BARYCENTER]: 1.0,
  [NAIF.VENUS_BARYCENTER]:   1.0,
  [NAIF.MARS_BARYCENTER]:    2.0,
  [NAIF.JUPITER_BARYCENTER]: 7.0,
  [NAIF.SATURN_BARYCENTER]:  14.0,
});

// ── 3-2-1: ホロスコープ計算（カンパヌス・トロピカル固定） ────────────────
document.getElementById('form-medieval-chart').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-medieval-chart')) return;

  const dtVal = document.getElementById('medieval-datetime').value;
  const lat   = parseFloat(document.getElementById('medieval-lat').value);
  const lon   = parseFloat(document.getElementById('medieval-lon').value);

  const jdTdb = jstInputToJdTdb(dtVal);
  // トポセントリック補正用に UTC JD も保持
  const [datePart, timePart] = dtVal.split('T');
  const [_y, _m, _d] = datePart.split('-').map(Number);
  const [_hh, _mm] = (timePart || '00:00').split(':').map(Number);
  const jdUtc   = dateToJd(_y, _m, _d + (_hh - 9) / 24 + _mm / 1440);
  const observer = { lat, lon, elev: 0 };

  // カンパヌス式固定
  let cusps, angles;
  try {
    ({ cusps, angles } = housesCampanus(jdTdb, lat, lon));
  } catch (err) {
    showResult('result-medieval-chart', `ハウス計算エラー: ${err.message}`, true);
    return;
  }

  // ハウス番号計算（ネイタルと同じロジック）
  function getHouseNum(pLon, hCusps) {
    for (let i = 0; i < 12; i++) {
      const c1 = hCusps[i];
      const c2 = hCusps[(i + 1) % 12];
      const inHouse = c2 > c1
        ? pLon >= c1 && pLon < c2
        : pLon >= c1 || pLon < c2;
      if (inHouse) return i + 1;
    }
    return 1;
  }

  // 惑星位置（トポセントリック補正 + 光行時間補正 + 年周光行差）、角速度付き
  const DT = 1 / 24;  // 1時間差分で角速度
  const planets = [];
  for (const { id: naifId, name } of MEDIEVAL_PLANETS) {
    try {
      const { lon: pLon, lat: pLat } = computeApparent(naifId, jdTdb, { jdUtc, observer });
      const lonPrev = computeApparent(naifId, jdTdb - DT, { jdUtc: jdUtc - DT, observer }).lon;
      const lonNext = computeApparent(naifId, jdTdb + DT, { jdUtc: jdUtc + DT, observer }).lon;
      let speed = lonNext - lonPrev;
      if (speed >  180) speed -= 360;
      if (speed < -180) speed += 360;
      speed = speed / (2 * DT);  // 度/日
      planets.push({ id: naifId, name, lon: pLon, lat: pLat, speed });
    } catch { /* skip */ }
  }

  // メジャーアスペクト（中世占星術の古典5相）
  const CLASSICAL_ASPECTS = [0, 60, 90, 120, 180];
  const ASPECT_ORB        = 8;  // 古典的オーブ 8°
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
          aspectsMed.push({
            nameA: planets[i].name, nameB: planets[j].name,
            asp, orb, sep,
          });
        }
      }
    }
  }

  // シジジー計算（直前の朔/望）
  let syzRowMed = '';
  try {
    const sunFnM  = jd => { const r = computeApparent(NAIF.SUN,  jd); return { lon: r.lon }; };
    const moonFnM = jd => { const r = computeApparent(NAIF.MOON, jd); return { lon: r.lon }; };
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

  const coordLabel = settings.coordSystem === 'j2000' ? ' / J2000.0' : ' / of-date';
  const [ascDeg, mcDeg] = angles;
  const dtDisplay = dtVal.replace('T', ' ');

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
      ${dtDisplay} JST　緯度 ${lat}°　経度 ${lon}°　カンパヌス式・トロピカル${coordLabel}<br>
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

// ── 3-2-2: 惑星星座運行計算（イングレス） ────────────────────────────────
document.getElementById('form-medieval-ingress').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireBsp('result-medieval-ingress')) return;

  const startStr = document.getElementById('medieval-ingress-start').value;
  const endStr   = document.getElementById('medieval-ingress-end').value;
  const selVal   = document.getElementById('medieval-ingress-planet').value;

  const startJD = dateStrToJdUtcMidJst(startStr);
  const endJD   = dateStrToJdUtcMidJst(endStr) + 1.0;

  if (endJD - startJD > 366 * 2) {
    showResult('result-medieval-ingress', '計算期間は最大2年以内にしてください。', true);
    return;
  }

  // 対象惑星リスト（"all" なら全7惑星）
  const targets = selVal === 'all'
    ? MEDIEVAL_PLANETS
    : MEDIEVAL_PLANETS.filter(p => String(p.id) === selVal);

  if (targets.length === 0) {
    showResult('result-medieval-ingress', '惑星が見つかりません。', true);
    return;
  }

  showLoading('result-medieval-ingress', '計算中…', '惑星の星座境界通過を二分探索');
  await yieldFrame();

  // 黄道12星座の境界（0°, 30°, 60°, ... 330°）
  const SIGN_BOUNDARIES = Array.from({ length: 12 }, (_, i) => i * 30);

  const allCrossings = [];

  for (const planet of targets) {
    const stepDays = MEDIEVAL_INGRESS_STEP[planet.id] ?? 1.0;
    const calcFn   = jd => computeApparent(planet.id, jdUtcToTdb(jd));
    const crossings = detectBoundaryCrossings(calcFn, SIGN_BOUNDARIES, startJD, endJD, {
      stepDays,
      precisionHours: 0.01,
    });
    for (const c of crossings) {
      allCrossings.push({ ...c, planetName: planet.name });
    }
  }

  // JD 昇順でソート
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

  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
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

// ═══════════════════════════════════════════════════════════════════════════════
// ════════════════════ ヘリオ占星術モード ════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// 日心9惑星（太陽を除く）
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

// HTML select の value (文字列) → NAIF ID マッピング
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

// ── 3-3-1: ヘリオ占星術チャート（地心投影日心・単一日時） ────────────────────
//
// 「地心投影日心」= 太陽を原点とした惑星位置を黄道面（z=0）に射影する。
// 黄道面への射影は黄経を保存するため、黄経の計算値は純粋ヘリオと同一。
// 占星術チャートとして使う場合は黄緯を無視し、黄道帯上の星座+度数だけを表示する。
document.getElementById('form-helio-chart').addEventListener('submit', e => {
  e.preventDefault();
  if (!requireBsp('result-helio-chart')) return;

  const dtVal  = document.getElementById('helio-datetime').value;
  const zodiac = document.getElementById('helio-zodiac').value;
  const orbVal = parseFloat(document.getElementById('helio-orb').value);
  const jdTdb  = jstInputToJdTdb(dtVal);

  const ayanamshaVal =
    zodiac === 'sidereal-lahiri' ? ayanamsha(jdTdb, AYANAMSHA.LAHIRI)        :
    zodiac === 'sidereal-fagan'  ? ayanamsha(jdTdb, AYANAMSHA.FAGAN_BRADLEY) :
    0;

  // 地心投影: lon のみ使用、lat は黄道面射影で 0 とみなす
  const positions = [];
  for (const { id: naifId, name } of HELIO_PLANETS) {
    try {
      const { lon } = computeHeliocentric(naifId, jdTdb);
      const adjLon = normAngle(lon - ayanamshaVal);
      positions.push({ name, lon: adjLon });
    } catch { /* skip */ }
  }

  // アスペクト検出（黄経のみで計算）
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
  const coordSuffix = settings.coordSystem === 'j2000' ? ' / J2000.0' : ' / of-date';
  const dtDisplay = dtVal.replace('T', ' ');

  // 黄道座標表: 天体 | 星座 | 黄経（占星術チャート形式）
  const posRows = positions.map(p =>
    `<tr><td>${p.name}</td><td>${lonToSign(p.lon)}</td><td>${p.lon.toFixed(3)}°</td></tr>`
  ).join('');

  const aspRows = aspList.map(a =>
    `<tr><td>${a.nameA}</td><td>${a.symbol} ${a.name}</td><td>${a.nameB}</td><td>${a.orb.toFixed(2)}°</td></tr>`
  ).join('');

  showResult('result-helio-chart', `
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
      ${dtDisplay} JST　|　地心投影日心　|　${zodiacLabel}${coordSuffix}　|　オーブ ±${orbVal}°
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

// ── 3-3-2: 日心アスペクト時系列 ───────────────────────────────────────────
document.getElementById('form-helio-ts').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireBsp('result-helio-ts')) return;

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

  // チェック済みアスペクト
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

  const calcFnA = jd => computeHeliocentric(naifA, jdUtcToTdb(jd));
  const calcFnB = jd => computeHeliocentric(naifB, jdUtcToTdb(jd));

  const allEvents = [];
  for (const aspAngle of aspAngles) {
    const events = detectAspectCrossings(calcFnA, calcFnB, aspAngle, startJD, endJD, {
      stepHours: 12,
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
      <td>${ev.lon1.toFixed(3)}°</td>
      <td>${ev.lon2.toFixed(3)}°</td>
    </tr>`
  ).join('');

  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
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

// ═══════════════════════════════════════════════════════════════════════════════
// ════════════════════ 東洋占術計算基盤 ══════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// ── 干支定数 ─────────────────────────────────────────────────────────────────
const STEMS    = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const BRANCHES = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
const SEXAGENARY = Array.from({ length: 60 }, (_, i) => `${STEMS[i % 10]}${BRANCHES[i % 12]}`);

// 月柱: 年干インデックス % 5 → 寅月の天干インデックス
const MONTH_STEM_START = [2, 4, 6, 8, 0];

// 四柱推命の「節」太陽黄経 → 月番号（1=寅月, 2=卯月, ...）
const SHICHU_NODE_LON = Object.freeze({
  315: 1, 345: 2, 15: 3, 45: 4, 75: 5, 105: 6,
  135: 7, 165: 8, 195: 9, 225: 10, 255: 11, 285: 12,
});

// 月番号 → 月支インデックス（0=子）
const MONTH_BRANCH_IDX = { 1:2, 2:3, 3:4, 4:5, 5:6, 6:7, 7:8, 8:9, 9:10, 10:11, 11:0, 12:1 };

// 時柱: 日干インデックス % 5 → 子時の天干インデックス
const HOUR_STEM_START = [0, 2, 4, 6, 8];

// 日柱基準 JDN: 1900/01/31 = 甲子日
const JDN_JIAZI = 2415079;

/** グレゴリオ暦 → ユリウス通日（JDN）*/
function gregorianToJdn(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
    Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

/**
 * 年の立春 JD を二分探索で求める（純粋関数）
 * 太陽黄経 = 315° を通過する UTC JD
 */
function findLichun(year) {
  const searchStart = dateStrToJdUtcMidJst(`${year - 1}-12-01`);
  const searchEnd   = dateStrToJdUtcMidJst(`${year}-03-31`);
  const BND = 315;
  function dev(jd) {
    const lon = computeApparent(NAIF.SUN, jdUtcToTdb(jd)).lon;
    let d = lon - BND;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }
  let lo = searchStart, hi = searchEnd;
  if (dev(lo) * dev(hi) > 0) return (lo + hi) / 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (dev(lo) * dev(mid) <= 0) hi = mid; else lo = mid;
    if (hi - lo < 0.5 / 86400) break;
  }
  return (lo + hi) / 2;
}

/**
 * 生年月日に対応する節（四柱推命の月節）を求める（純粋関数）
 * @returns {{ monthNum, nodeName, nodeJd }}
 */
function findShichuNode(birthJdUtc, birthYear) {
  // 前年11月〜翌年3月の節を検索
  const searchStart = dateStrToJdUtcMidJst(`${birthYear - 1}-10-01`);
  const searchEnd   = dateStrToJdUtcMidJst(`${birthYear + 1}-04-01`);

  const nodeLons = Object.keys(SHICHU_NODE_LON).map(Number);
  const events = [];
  const STEP = 10;  // 10日ステップで粗スキャン（節は30日間隔なので安全）

  for (const bnd of nodeLons) {
    function devBnd(jd) {
      const lon = computeApparent(NAIF.SUN, jdUtcToTdb(jd)).lon;
      let d = lon - bnd;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return d;
    }
    let prevJD = searchStart;
    let prevD  = devBnd(searchStart);
    for (let jd = searchStart + STEP; jd <= searchEnd; jd += STEP) {
      const curD = devBnd(jd);
      if (prevD * curD < 0 && Math.abs(curD - prevD) < 180) {
        let lo = prevJD, hi = jd;
        for (let i = 0; i < 50; i++) {
          const mid = (lo + hi) / 2;
          if (devBnd(lo) * devBnd(mid) <= 0) hi = mid; else lo = mid;
          if (hi - lo < 1 / 1440) break;
        }
        const crossJd = (lo + hi) / 2;
        events.push({ lon: bnd, jd: crossJd, monthNum: SHICHU_NODE_LON[bnd] });
        break;
      }
      prevJD = jd; prevD = curD;
    }
  }

  // 生年JD以前・以後で最も近い節を探す
  const past   = events.filter(ev => ev.jd <= birthJdUtc).sort((a, b) => b.jd - a.jd);
  const future = events.filter(ev => ev.jd >  birthJdUtc).sort((a, b) => a.jd - b.jd);

  const prevNodeJd = past.length   > 0 ? past[0].jd   : null;
  const nextNodeJd = future.length > 0 ? future[0].jd : null;

  if (past.length > 0) {
    return { monthNum: past[0].monthNum, prevNodeJd, nextNodeJd };
  }
  const fallbackMonth = jdToDate(birthJdUtc + 9 / 24).month ?? 1;
  return { monthNum: Math.max(1, fallbackMonth), prevNodeJd: null, nextNodeJd };
}

// ── 四柱推命 純粋関数ライブラリ ──────────────────────────────────────────────

// 五行インデックス: 甲乙=木(0), 丙丁=火(1), 戊己=土(2), 庚辛=金(3), 壬癸=水(4)
const STEM_ELEMENT   = [0,0,1,1,2,2,3,3,4,4];
const BRANCH_WUXING_NAMES = ['水','土','木','木','土','火','火','土','金','金','土','水'];
const STEM_YIN_YANG  = ['陽','陰','陽','陰','陽','陰','陽','陰','陽','陰'];
const WUXING_NAMES   = ['木','火','土','金','水'];
// 五行サイクル: GENERATES[e]=eが生む五行, CONTROLS[e]=eが剋する五行
const GENERATES = [1,2,3,4,0];   // 木→火, 火→土, 土→金, 金→水, 水→木
const CONTROLS  = [2,3,4,0,1];   // 木→土, 火→金, 土→水, 金→木, 水→火

// 蔵干テーブル（徐大升版）— [本気, 中気, 余気] / '' = なし
const KANSHIN_TABLE = {
   0: ['壬', '',   ''  ],  // 子
   1: ['己', '癸', '辛'],  // 丑
   2: ['甲', '丙', '戊'],  // 寅
   3: ['乙', '',   ''  ],  // 卯
   4: ['戊', '乙', '癸'],  // 辰
   5: ['丙', '庚', '戊'],  // 巳
   6: ['丁', '己', ''  ],  // 午
   7: ['己', '丁', '乙'],  // 未
   8: ['庚', '壬', '戊'],  // 申
   9: ['辛', '',   ''  ],  // 酉
  10: ['戊', '辛', '丁'],  // 戌
  11: ['壬', '甲', ''  ],  // 亥
};

/** 地支インデックス → 蔵干の表示文字列（空文字除外済み） */
function getKanshin(branchIdx) {
  return KANSHIN_TABLE[branchIdx].filter(s => s);
}

// 十神テーブル: `${rel}_${同極性true/false}` → 十神名
const JUUSHIN_TABLE = {
  '0_true':'比肩','0_false':'劫財',
  '1_true':'食神','1_false':'傷官',
  '2_true':'偏財','2_false':'正財',
  '3_true':'偏官','3_false':'正官',
  '4_true':'偏印','4_false':'印綬',
};

/**
 * 日干を基準に対象天干の十神（通変星）名を返す
 * rel: 0=同五行, 1=DM生T, 2=DM剋T, 3=T剋DM, 4=T生DM
 */
function getJuushin(dayStemIdx, targetStemIdx) {
  const eDay = STEM_ELEMENT[dayStemIdx];
  const eTgt = STEM_ELEMENT[targetStemIdx];
  const same = (dayStemIdx % 2 === targetStemIdx % 2);
  let rel;
  if      (eTgt === eDay)             rel = 0;
  else if (GENERATES[eDay] === eTgt)  rel = 1;
  else if (CONTROLS[eDay]  === eTgt)  rel = 2;
  else if (CONTROLS[eTgt]  === eDay)  rel = 3;
  else                                rel = 4;
  return JUUSHIN_TABLE[`${rel}_${same}`];
}

// 空亡（天中殺）テーブル — 旬インデックス(0〜5) → 空亡地支ペア
// 甲子旬→戌亥, 甲戌旬→申酉, 甲申旬→午未, 甲午旬→辰巳, 甲辰旬→寅卯, 甲寅旬→子丑
const KUBO_TABLE    = [[10,11],[8,9],[6,7],[4,5],[2,3],[0,1]];
const JUN_NAMES     = ['甲子旬','甲戌旬','甲申旬','甲午旬','甲辰旬','甲寅旬'];

/** 日柱の60甲子インデックス → 空亡情報 */
function getKubo(dayOffset60) {
  const junIdx       = Math.floor(dayOffset60 / 10);
  const voidIdxs     = KUBO_TABLE[junIdx];
  const voidBranches = voidIdxs.map(i => BRANCHES[i]);
  return {
    junIdx, junName: JUN_NAMES[junIdx],
    voidBranchIndices: voidIdxs,
    voidBranches,
    name: voidBranches.join('') + '空亡',
  };
}

// 十二運星テーブル — 各天干の [長生地支インデックス, 順行(true)/逆行(false)]
// 甲:亥→順, 乙:午→逆, 丙:寅→順, 丁:酉→逆, 戊:寅→順, 己:酉→逆
// 庚:巳→順, 辛:子→逆, 壬:申→順, 癸:卯→逆
const JUUNISEI_NAMES = ['長生','沐浴','冠帯','臨官','帝旺','衰','病','死','墓','絶','胎','養'];
const JS_START       = [[11,true],[6,false],[2,true],[9,false],[2,true],[9,false],
                        [5,true],[0,false],[8,true],[3,false]];

/** 天干 × 地支 → 十二運星名 */
function getJuunisei(stemIdx, branchIdx) {
  const [start, forward] = JS_START[stemIdx];
  const stage = forward
    ? ((branchIdx - start) + 12) % 12
    : ((start - branchIdx) + 12) % 12;
  return JUUNISEI_NAMES[stage];
}

/** 日主強弱スコア算出（月令+通根+天干サポート）*/
function getNichinushiScore(yearStemI, monthStemI, monthBranI, dayStemI,
                             yearBranI, dayBranI, hourStemI, hourBranI) {
  const dm    = STEM_ELEMENT[dayStemI];
  const lines = [];

  // ① 月令
  const honkiStr = KANSHIN_TABLE[monthBranI][0];
  let gekkoPts;
  if (honkiStr) {
    const hElem = STEM_ELEMENT[STEMS.indexOf(honkiStr)];
    let rel;
    if      (hElem === dm)           rel = 0;  // 旺
    else if (GENERATES[hElem] === dm) rel = 4; // 相
    else if (GENERATES[dm] === hElem) rel = 1; // 休
    else if (CONTROLS[dm]  === hElem) rel = 2; // 囚
    else                              rel = 3; // 死
    const scoreMap = {0:30,4:20,1:-10,2:-15,3:-30};
    const relName  = {0:'旺',4:'相',1:'休',2:'囚',3:'死'};
    gekkoPts = scoreMap[rel];
    lines.push(`月令: ${BRANCHES[monthBranI]}月 → ${relName[rel]} (${gekkoPts > 0 ? '+' : ''}${gekkoPts})`);
  } else {
    gekkoPts = -10;
    lines.push(`月令: ${BRANCHES[monthBranI]}月 → 休 (-10)`);
  }

  // ② 通根（四柱地支の蔵干に日干と同五行があれば加算）
  const tsukkonPts = {honki: 5, chuki: 3, yoki: 1};
  let tsukkon = 0;
  for (const [br, label] of [[yearBranI,'年支'],[monthBranI,'月支'],[dayBranI,'日支'],[hourBranI,'時支']]) {
    const row = KANSHIN_TABLE[br];
    for (const [ki, hs] of [['honki',row[0]],['chuki',row[1]],['yoki',row[2]]]) {
      if (hs && STEM_ELEMENT[STEMS.indexOf(hs)] === dm) {
        tsukkon += tsukkonPts[ki];
        lines.push(`  通根(${ki}): ${BRANCHES[br]}(${hs}) +${tsukkonPts[ki]}`);
      }
    }
  }

  // ③ 天干サポート（比劫+5 / 印+3）— 日干除外
  let stemPts = 0;
  for (const [si, label] of [[yearStemI,'年干'],[monthStemI,'月干'],[hourStemI,'時干']]) {
    const sElem = STEM_ELEMENT[si];
    if      (sElem === dm)           { stemPts += 5; lines.push(`  天干比劫: ${STEMS[si]} +5`); }
    else if (GENERATES[sElem] === dm){ stemPts += 3; lines.push(`  天干印: ${STEMS[si]} +3`); }
  }

  const total = gekkoPts + tsukkon + stemPts;
  const judgment = total >= 20 ? '身強' : total >= 0 ? '中和' : '身弱';

  return { total, gekkoPts, tsukkon, stemPts, judgment, lines };
}

// 干合テーブル: (min, max) → [合名, 合化五行]
const KAN_GO_TABLE = {
  '0_5':['甲己合','土'], '1_6':['乙庚合','金'], '2_7':['丙辛合','水'],
  '3_8':['丁壬合','木'], '4_9':['戊癸合','火'],
};
// 合化五行 → 旺支地支インデックスリスト（月支が含まれていれば化気成立）
const KA_KI_BRANCHES = {
  木:[2,3,4], 火:[5,6,7], 土:[2,5,8,11], 金:[8,9,10], 水:[11,0,1],
};

/** 天干インデックス配列 + 月支インデックス → 干合リスト */
function getKanGo(stems, monthBranchIdx) {
  const names = ['年干','月干','日干','時干'];
  const results = [];
  for (let i = 0; i < stems.length; i++) {
    for (let j = i + 1; j < stems.length; j++) {
      const key = `${Math.min(stems[i],stems[j])}_${Math.max(stems[i],stems[j])}`;
      if (KAN_GO_TABLE[key]) {
        const [name, elem] = KAN_GO_TABLE[key];
        const kaKi = KA_KI_BRANCHES[elem]?.includes(monthBranchIdx) ?? false;
        results.push({ name, elem, kaKi, pos: `${names[i]} × ${names[j]}` });
      }
    }
  }
  return results;
}

// 地支間作用テーブル
const ROKU_GO_TABLE  = {'0_1':['子丑合','土'],'2_11':['寅亥合','木'],'3_10':['卯戌合','火'],
                        '4_9':['辰酉合','金'],'5_8':['巳申合','水'],'6_7':['午未合','火']};
const SAN_GO_TABLE   = {
  '0_4_8':['申子辰水局','水'], '3_7_11':['亥卯未木局','木'],
  '2_6_10':['寅午戌火局','火'], '1_5_9':['巳酉丑金局','金'],
};
const HANKAI_TABLE   = {
  '0_8':['申子半会','水'],'0_4':['子辰半会','水'],'3_11':['亥卯半会','木'],'3_7':['卯未半会','木'],
  '2_6':['寅午半会','火'],'6_10':['午戌半会','火'],'5_9':['巳酉半会','金'],'1_9':['酉丑半会','金'],
};
const ROKU_CHU_TABLE = {'0_6':'子午冲','1_7':'丑未冲','2_8':'寅申冲',
                        '3_9':'卯酉冲','4_10':'辰戌冲','5_11':'巳亥冲'};
const ROKU_GAI_TABLE = {'0_7':'子未害','1_6':'丑午害','2_5':'寅巳害',
                        '3_4':'卯辰害','8_11':'申亥害','9_10':'酉戌害'};
const SAN_KEI_TABLE  = {
  '2_5_8':['寅巳申刑','恃勢之刑'],'1_7_10':['丑戌未刑','無恩之刑'],'0_3':['子卯刑','無礼之刑'],
};
const JIKEI_SET      = new Set([4,6,9,11]);
const JIKEI_NAMES    = {4:'辰自刑',6:'午自刑',9:'酉自刑',11:'亥自刑'};

/** 地支インデックス配列 → 刑冲合害リスト */
function getBranchInteractions(branches) {
  const labels = ['年支','月支','日支','時支'];
  const bl = branches.map((b,i) => `${labels[i]}(${BRANCHES[b]})`);
  const results = [];
  const n = branches.length;

  // 六合
  for (let i=0;i<n;i++) for(let j=i+1;j<n;j++) {
    const k = `${Math.min(branches[i],branches[j])}_${Math.max(branches[i],branches[j])}`;
    if (ROKU_GO_TABLE[k]) {
      const [nm,el] = ROKU_GO_TABLE[k];
      results.push(`六合: ${nm}（${el}）  [${bl[i]} + ${bl[j]}]`);
    }
  }
  // 三合
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let k=j+1;k<n;k++){
    const key = [branches[i],branches[j],branches[k]].sort((a,b)=>a-b).join('_');
    if(SAN_GO_TABLE[key]){
      const[nm,el]=SAN_GO_TABLE[key];
      results.push(`三合局: ${nm}（${el}）  [${bl[i]}+${bl[j]}+${bl[k]}]`);
    }
  }
  // 三合半会
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const key = [branches[i],branches[j]].sort((a,b)=>a-b).join('_');
    if(HANKAI_TABLE[key]){
      const[nm,el]=HANKAI_TABLE[key];
      results.push(`三合半会: ${nm}（${el}）  [${bl[i]} + ${bl[j]}]`);
    }
  }
  // 六冲
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const k=`${Math.min(branches[i],branches[j])}_${Math.max(branches[i],branches[j])}`;
    if(ROKU_CHU_TABLE[k]) results.push(`六冲: ${ROKU_CHU_TABLE[k]}  [${bl[i]} + ${bl[j]}]`);
  }
  // 六害
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const k=`${Math.min(branches[i],branches[j])}_${Math.max(branches[i],branches[j])}`;
    if(ROKU_GAI_TABLE[k]) results.push(`六害: ${ROKU_GAI_TABLE[k]}  [${bl[i]} + ${bl[j]}]`);
  }
  // 三刑（3支・2支）
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let k=j+1;k<n;k++){
    const key=[branches[i],branches[j],branches[k]].sort((a,b)=>a-b).join('_');
    if(SAN_KEI_TABLE[key]){const[nm,tp]=SAN_KEI_TABLE[key];results.push(`刑: ${nm}（${tp}）  [${bl[i]}+${bl[j]}+${bl[k]}]`);}
  }
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const key=[branches[i],branches[j]].sort((a,b)=>a-b).join('_');
    if(SAN_KEI_TABLE[key]){const[nm,tp]=SAN_KEI_TABLE[key];results.push(`刑: ${nm}（${tp}）  [${bl[i]} + ${bl[j]}]`);}
  }
  // 自刑
  const seen = {};
  for(let i=0;i<n;i++){
    const b=branches[i];
    if(JIKEI_SET.has(b)){
      if(seen[b]!==undefined) results.push(`自刑: ${JIKEI_NAMES[b]}  [${bl[seen[b]]} + ${bl[i]}]`);
      else seen[b]=i;
    }
  }
  return results;
}

/** 天干・地支インデックスから 60甲子インデックスを返す */
function getSexagenary60Idx(stemIdx, branchIdx) {
  for (let k = 0; k < 6; k++) {
    const n = stemIdx + k * 10;
    if (n % 12 === branchIdx) return n;
  }
  return stemIdx;  // fallback
}

/**
 * 大運算出（月柱から順行/逆行で展開）
 * @param {number} yearStemI  年干インデックス
 * @param {number} monthStemI 月干インデックス
 * @param {number} monthBranI 月支インデックス
 * @param {boolean} male      男命か
 * @param {number} birthJdUtc 生年の UTC JD
 * @param {number|null} prevNodeJd 出生直前の節 JD
 * @param {number|null} nextNodeJd 出生直後の節 JD
 * @param {number} birthYear  グレゴリオ出生年
 */
function getDaiyun(yearStemI, monthStemI, monthBranI, male,
                   birthJdUtc, prevNodeJd, nextNodeJd, birthYear) {
  const yangYear = (yearStemI % 2 === 0);
  const forward  = (male === yangYear);  // 陽年男 or 陰年女 → 順行
  const direction = forward ? '順行' : '逆行';
  const polarity  = yangYear ? '陽年' : '陰年';
  const genderStr = male ? '男命' : '女命';

  // 起運節
  const nodeJd = forward ? nextNodeJd : prevNodeJd;
  let kiunYears = 0, kiunMonths = 0;
  if (nodeJd !== null) {
    const kiunDays  = Math.abs(nodeJd - birthJdUtc);
    const totalHrs  = kiunDays * 24;
    kiunYears  = Math.floor(totalHrs / 72);          // 72時間 = 3日 = 1年
    const remHrs = totalHrs % 72;
    kiunMonths = Math.min(11, Math.floor(remHrs / 6)); // 6時間 = 1ヶ月
    if (kiunMonths >= 12) { kiunYears += Math.floor(kiunMonths / 12); kiunMonths %= 12; }
  }
  const kiunStr = `${kiunYears}歳` + (kiunMonths > 0 ? `${kiunMonths}ヶ月` : '');

  // 月柱の 60甲子インデックスから ±1 ずつ展開
  const base = getSexagenary60Idx(monthStemI, monthBranI);
  const periods = [];
  for (let i = 1; i <= 10; i++) {
    const idx      = forward ? (base + i) % 60 : ((base - i) % 60 + 60) % 60;
    const startAge = kiunYears + (i - 1) * 10;
    periods.push({
      seq: i, idx,
      name: SEXAGENARY[idx],
      stemIdx: idx % 10, branchIdx: idx % 12,
      startAge, startYear: birthYear + startAge,
    });
  }

  return { forward, direction, polarity, genderStr, kiunYears, kiunMonths, kiunStr, periods };
}

// ── 3-4-1: 四柱推命 命式スケルトン ──────────────────────────────────────────
document.getElementById('form-shichu').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireBsp('result-shichu')) return;

  const dateVal  = document.getElementById('shichu-date').value;
  const timeVal  = document.getElementById('shichu-time').value;
  const genderVal= document.getElementById('shichu-gender').value;
  const male     = (genderVal === 'male');

  const [y, m, d] = dateVal.split('-').map(Number);
  const [hh, mm]  = timeVal.split(':').map(Number);

  // 生年の UTC JD（JST → UTC）
  const birthJdUtc = dateToJd(y, m, d, hh - 9, mm, 0);

  showLoading('result-shichu', '計算中…', '節気（12個）の通過時刻を二分探索');
  await yieldFrame();

  // ── 年柱 ─────────────────────────────────────────────────────────────
  const lichunJd      = findLichun(y);
  const effectiveYear = birthJdUtc >= lichunJd ? y : y - 1;
  const yearIdx   = ((effectiveYear - 4) % 60 + 60) % 60;
  const yearStemI = yearIdx % 10;
  const yearBranI = yearIdx % 12;
  const yearPillar = { stem: STEMS[yearStemI], branch: BRANCHES[yearBranI], name: SEXAGENARY[yearIdx] };

  // ── 月柱 ─────────────────────────────────────────────────────────────
  const { monthNum, prevNodeJd, nextNodeJd } = findShichuNode(birthJdUtc, y);
  const monthBranI  = MONTH_BRANCH_IDX[monthNum] ?? 2;
  const monthStemI  = (MONTH_STEM_START[yearStemI % 5] + monthNum - 1) % 10;
  const monthPillar = { stem: STEMS[monthStemI], branch: BRANCHES[monthBranI], name: `${STEMS[monthStemI]}${BRANCHES[monthBranI]}` };

  // ── 日柱 ─────────────────────────────────────────────────────────────
  const jdn       = gregorianToJdn(y, m, d);
  const dayOffset = ((jdn - JDN_JIAZI) % 60 + 60) % 60;
  const dayStemI  = dayOffset % 10;
  const dayBranI  = dayOffset % 12;
  const dayPillar = { stem: STEMS[dayStemI], branch: BRANCHES[dayBranI], name: SEXAGENARY[dayOffset] };

  // ── 時柱 ─────────────────────────────────────────────────────────────
  const hourNorm  = (hh === 23) ? -1 : hh;
  const hourBranI = ((Math.floor((hourNorm + 1) / 2) % 12) + 12) % 12;
  const hourStemI = (HOUR_STEM_START[dayStemI % 5] + hourBranI) % 10;
  const hourPillar = { stem: STEMS[hourStemI], branch: BRANCHES[hourBranI], name: `${STEMS[hourStemI]}${BRANCHES[hourBranI]}` };

  // ── 蔵干 ─────────────────────────────────────────────────────────────
  const kanshinYear  = getKanshin(yearBranI);
  const kanshinMonth = getKanshin(monthBranI);
  const kanshinDay   = getKanshin(dayBranI);
  const kanshinHour  = getKanshin(hourBranI);

  // ── 十神 ─────────────────────────────────────────────────────────────
  const juushinYear  = getJuushin(dayStemI, yearStemI);
  const juushinMonth = getJuushin(dayStemI, monthStemI);
  const juushinHour  = getJuushin(dayStemI, hourStemI);

  // ── 空亡 ─────────────────────────────────────────────────────────────
  const kubo = getKubo(dayOffset);

  // ── 十二運星 ─────────────────────────────────────────────────────────
  const juuniseiYear  = getJuunisei(dayStemI, yearBranI);
  const juuniseiMonth = getJuunisei(dayStemI, monthBranI);
  const juuniseiDay   = getJuunisei(dayStemI, dayBranI);
  const juuniseiHour  = getJuunisei(dayStemI, hourBranI);

  // ── 日主強弱 ─────────────────────────────────────────────────────────
  const nichinushi = getNichinushiScore(yearStemI, monthStemI, monthBranI, dayStemI,
                                         yearBranI, dayBranI, hourStemI, hourBranI);

  // ── 干合・刑冲合害 ────────────────────────────────────────────────────
  const kanGoList   = getKanGo([yearStemI, monthStemI, dayStemI, hourStemI], monthBranI);
  const branchInter = getBranchInteractions([yearBranI, monthBranI, dayBranI, hourBranI]);

  // ── 大運 ─────────────────────────────────────────────────────────────
  const daiyun = getDaiyun(yearStemI, monthStemI, monthBranI, male,
                            birthJdUtc, prevNodeJd, nextNodeJd, effectiveYear);

  // ── 五行分布 ──────────────────────────────────────────────────────────
  const wuxingCnt = [0, 0, 0, 0, 0];
  for (const si of [yearStemI, monthStemI, dayStemI, hourStemI]) {
    wuxingCnt[STEM_ELEMENT[si]]++;
  }
  const allKanshin = [...kanshinYear, ...kanshinMonth, ...kanshinDay, ...kanshinHour];
  for (const ks of allKanshin) { if (ks) wuxingCnt[STEM_ELEMENT[STEMS.indexOf(ks)]]++; }
  const maxCnt = Math.max(...wuxingCnt, 1);

  // ── 出力 HTML ─────────────────────────────────────────────────────────

  function pillarRow(label, pillar, stemI, branI, kanshin, juushin, js) {
    const ksStr  = kanshin.join('') || '—';
    const jssStr = juushin || '日主';
    return `<tr>
      <td>${label}</td>
      <td style="font-size:16px;font-weight:bold">${pillar.stem}</td>
      <td style="font-size:16px;font-weight:bold">${pillar.branch}</td>
      <td>${pillar.name}</td>
      <td>${WUXING_NAMES[STEM_ELEMENT[stemI]]}（${STEM_YIN_YANG[stemI]}）</td>
      <td>${BRANCH_WUXING_NAMES[branI]}</td>
      <td>${ksStr}</td>
      <td>${jssStr}</td>
      <td>${js}</td>
    </tr>`;
  }

  const wuxingBar = WUXING_NAMES.map((nm, i) => {
    const c = wuxingCnt[i];
    return `${nm}: ${'█'.repeat(c)}${'░'.repeat(maxCnt - c)} ${c}`;
  }).join('\n');

  const kanGoHtml = kanGoList.length > 0
    ? kanGoList.map(c => {
        const kaki = c.kaKi ? `→ ${c.elem}化（化気成立）` : `→ ${c.elem}化（化気不成立）`;
        return `${c.name} ${kaki}  [${c.pos}]`;
      }).join('<br>')
    : '（なし）';

  const interHtml = branchInter.length > 0
    ? branchInter.join('<br>')
    : '（なし）';

  const daiyunRows = daiyun.periods.map(p => `<tr>
    <td>${p.seq}</td>
    <td style="font-weight:bold">${p.name}</td>
    <td>${p.startAge}歳</td>
    <td>${p.startYear}年頃</td>
  </tr>`).join('');

  showResult('result-shichu', `
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
      ${dateVal} ${timeVal} JST　|　${male ? '男命' : '女命'}　|　立春基準・節気月柱<br>
      空亡: <strong>${kubo.name}</strong>（${kubo.junName}）
    </p>

    <h4 style="margin:12px 0 4px;font-size:13px">命式</h4>
    <table class="result-table">
      <thead><tr><th>柱</th><th>天干</th><th>地支</th><th>干支名</th><th>天干五行</th><th>地支五行</th><th>蔵干</th><th>十神</th><th>十二運星</th></tr></thead>
      <tbody>
        ${pillarRow('年柱', yearPillar, yearStemI, yearBranI, kanshinYear, juushinYear, juuniseiYear)}
        ${pillarRow('月柱', monthPillar, monthStemI, monthBranI, kanshinMonth, juushinMonth, juuniseiMonth)}
        ${pillarRow('日柱', dayPillar, dayStemI, dayBranI, kanshinDay, '日主', juuniseiDay)}
        ${pillarRow('時柱', hourPillar, hourStemI, hourBranI, kanshinHour, juushinHour, juuniseiHour)}
      </tbody>
    </table>

    <h4 style="margin:12px 0 4px;font-size:13px">五行分布</h4>
    <pre style="font-size:12px;margin:0;line-height:1.6;color:var(--text)">${wuxingBar}
（天干4 + 蔵干${allKanshin.filter(s=>s).length} = 合計${4 + allKanshin.filter(s=>s).length}）</pre>

    <h4 style="margin:12px 0 4px;font-size:13px">日主強弱: ${nichinushi.judgment}（スコア: ${nichinushi.total > 0 ? '+' : ''}${nichinushi.total}）</h4>
    <pre style="font-size:11px;margin:0;line-height:1.5;color:var(--text-muted)">${nichinushi.lines.join('\n')}</pre>

    <h4 style="margin:12px 0 4px;font-size:13px">干合・刑冲合害</h4>
    <p style="font-size:12px;margin:0;line-height:1.8">
      <strong>干合:</strong> ${kanGoHtml}<br>
      ${interHtml}
    </p>

    <h4 style="margin:12px 0 4px;font-size:13px">大運 — ${daiyun.direction}（${daiyun.polarity} × ${daiyun.genderStr}）・起運${daiyun.kiunStr}</h4>
    <table class="result-table">
      <thead><tr><th>No.</th><th>干支</th><th>開始年齢</th><th>西暦目安</th></tr></thead>
      <tbody>${daiyunRows}</tbody>
    </table>

    <p style="font-size:11px;color:var(--text-muted);margin:8px 0 0">
      ※ 月柱は前後の年の節気を検索して決定（立春基準で年柱を一年前に繰り下げる場合あり）<br>
      ※ 時柱: 子時は23:00〜01:00（23時は当日の子時として扱う）<br>
      ※ 蔵干: 徐大升版。十二運星: 日干基準
    </p>`);
});

// ── 3-4-2: 紫微斗数 命盤スケルトン ──────────────────────────────────────────

// 紫微斗数定数
const PALACE_NAMES = ['命宮','兄弟宮','夫妻宮','子女宮','財帛宮','疾厄宮','遷移宮','交友宮','官禄宮','田宅宮','福徳宮','父母宮'];
const ZIWEI_SYSTEM = [['紫微',0],['天機',-1],['太陽',-3],['武曲',-4],['天同',-5],['廉貞',-8]];
const TIANFU_SYSTEM= [['天府',0],['太陰',1],['貪狼',2],['巨門',3],['天相',4],['天梁',5],['七殺',6],['破軍',10]];
const WUXING_JU_TABLE = [4,6,3,5,4,6, 2,5,4,3,2,5, 6,3,2,4,6,3, 5,4,6,2,5,4, 3,2,5,6,3,2];
const WUXING_JU_NAMES = {2:'水二局',3:'木三局',4:'金四局',5:'土五局',6:'火六局'};
const YEAR_STEM_TO_YINMONTH = [2,4,6,8,0,2,4,6,8,0];

// ── 紫微斗数 純粋関数ライブラリ ──────────────────────────────────────────────

// 五虎遁年法: 年干インデックス%5 → 寅宮の天干インデックス
const YEAR_TO_YIN_STEM = [2, 4, 6, 8, 0];

/** 年干インデックス → 全12宮の宮干インデックス（{branchIdx: stemIdx}）*/
function getPalaceStems(yearStemIdx) {
  const yinStem = YEAR_TO_YIN_STEM[yearStemIdx % 5];
  const result = {};
  for (let b = 0; b < 12; b++) {
    result[b] = (yinStem + ((b - 2) + 12) % 12) % 10;
  }
  return result;
}

// 副星テーブル（年干インデックス → 地支インデックス）
const TIANKUI_TABLE  = [1, 0,11,11, 1, 0, 1, 6, 3, 3];  // 天魁
const TIANYUE_TABLE  = [7, 8, 9, 9, 7, 8, 7, 2, 5, 5];  // 天鉞
const LUZUN_TABLE    = [2, 3, 5, 6, 5, 6, 8, 9,11, 0];  // 禄存
const TIANMA_TABLE   = [2,11, 8, 5, 2,11, 8, 5, 2,11, 8, 5]; // 天馬（年支インデックス→地支）

// 四化テーブル（年干インデックス → [[星名, 化名], ...]）
const SIHUA_TABLE = [
  [['廉貞','化禄'],['破軍','化権'],['武曲','化科'],['太陽','化忌']],  // 甲
  [['天機','化禄'],['天梁','化権'],['紫微','化科'],['太陰','化忌']],  // 乙
  [['天同','化禄'],['天機','化権'],['文昌','化科'],['廉貞','化忌']],  // 丙
  [['太陰','化禄'],['天同','化権'],['天機','化科'],['巨門','化忌']],  // 丁
  [['貪狼','化禄'],['太陰','化権'],['右弼','化科'],['天機','化忌']],  // 戊
  [['武曲','化禄'],['貪狼','化権'],['天梁','化科'],['文曲','化忌']],  // 己
  [['太陽','化禄'],['武曲','化権'],['太陰','化科'],['天同','化忌']],  // 庚
  [['巨門','化禄'],['太陽','化権'],['文曲','化科'],['文昌','化忌']],  // 辛
  [['天梁','化禄'],['紫微','化権'],['左輔','化科'],['武曲','化忌']],  // 壬
  [['破軍','化禄'],['巨門','化権'],['太陰','化科'],['貪狼','化忌']],  // 癸
];

/**
 * 副星配置（年系・月系・時系）
 * @returns {{ 天魁, 天鉞, 禄存, 擎羊, 陀羅, 天馬, 左輔, 右弼, 文昌, 文曲: number }}
 */
function placeMinorStars(yearStemIdx, yearBranchIdx, lunarMonth, hourBranchIdx) {
  const ys = yearStemIdx;
  const yb = yearBranchIdx;
  const m  = Math.round(lunarMonth);
  const hb = hourBranchIdx;
  return {
    天魁: TIANKUI_TABLE[ys],
    天鉞: TIANYUE_TABLE[ys],
    禄存: LUZUN_TABLE[ys],
    擎羊: (LUZUN_TABLE[ys] + 1) % 12,
    陀羅: (LUZUN_TABLE[ys] - 1 + 12) % 12,
    天馬: TIANMA_TABLE[yb],
    左輔: (4  + m - 1) % 12,  // 月1→辰(4), 順行
    右弼: (10 - m + 1 + 12) % 12,  // 月1→戌(10), 逆行
    文昌: (10 - hb + 12) % 12,  // 子時→戌(10), 逆行
    文曲: (4  + hb) % 12,       // 子時→辰(4), 順行
  };
}

/**
 * 紫微大限（10年大限の宮移動）
 * @param {number} mingIdx     命宮の地支インデックス
 * @param {number} wuxingJu    五行局数
 * @param {boolean} male       男命か
 * @param {number} birthYear   グレゴリオ出生年
 * @param {number} lunarYearApprox 農暦年（年干支算出用）
 * @returns {{ direction, polarity, startAge, periods }}
 */
function getZiweiDaixian(mingIdx, wuxingJu, male, birthYear, lunarYearApprox) {
  const lunarYearIdx = ((lunarYearApprox - 4) % 60 + 60) % 60;
  const yearStemI    = lunarYearIdx % 10;
  const yangYear     = (yearStemI % 2 === 0);
  const forward      = (male === yangYear);

  const periods = [];
  for (let i = 1; i <= 12; i++) {
    const bIdx    = forward ? (mingIdx + i) % 12 : (mingIdx - i + 12) % 12;
    const startAge = wuxingJu + (i - 1) * 10;
    periods.push({
      seq: i, branchIdx: bIdx, branch: BRANCHES[bIdx],
      palaceName: PALACE_NAMES[(bIdx - mingIdx + 12) % 12] ?? '—',
      startAge, startYear: birthYear + startAge,
    });
  }

  return {
    forward, direction: forward ? '順行' : '逆行',
    polarity: yangYear ? '陽年' : '陰年',
    startAge: wuxingJu, periods,
  };
}

function getMingGongStemIdx(yearStemIdx, mingBranchIdx) {
  const yinStem = YEAR_STEM_TO_YINMONTH[yearStemIdx];
  const offset  = (mingBranchIdx - 2 + 12) % 12;
  return (yinStem + offset) % 10;
}

function ganzhi60Idx(stemI, branchI) {
  return (stemI - Math.floor(((branchI - stemI) % 12) / 2) * 10 + 60) % 60;
}

document.getElementById('form-ziwei').addEventListener('submit', async e => {
  e.preventDefault();
  const resultEl = document.getElementById('result-ziwei');

  const gregDate   = document.getElementById('ziwei-greg-date').value;  // YYYY-MM-DD
  const gregTime   = document.getElementById('ziwei-greg-time').value || '12:00';  // HH:MM (JST)
  const hourBranI  = parseInt(document.getElementById('ziwei-hour-branch').value);
  const gender     = document.getElementById('ziwei-gender').value;

  if (!gregDate) {
    resultEl.innerHTML = '<p style="color:var(--accent-warn)">生年月日を入力してください</p>';
    return;
  }

  const [gy, gm, gd] = gregDate.split('-').map(Number);
  const [hh, mm]     = gregTime.split(':').map(Number);
  // JST（+9）→ UTC（-9時間）で JD を算出
  const jdUtc = dateToJd(gy, gm, gd, hh - 9, mm, 0, 'gregorian');
  const jdTdb = jdUtcToTdb(jdUtc);

  // BSP 未ロード時のガード
  if (!bspFile) {
    resultEl.innerHTML = '<p style="color:var(--accent-warn)">BSP ファイルを読み込んでください</p>';
    return;
  }

  resultEl.innerHTML = '<p style="color:var(--text-muted)">農暦変換中…（数秒かかる場合があります）</p>';

  // 農暦変換（メインスレッドが重くなるため setTimeout でレンダリング後に実行）
  await new Promise(r => setTimeout(r, 0));

  let lunarResult;
  try {
    const sunFn  = jd => computeApparent(NAIF.SUN,  jd);
    const moonFn = jd => computeApparent(NAIF.MOON, jd);
    lunarResult = getLunarDate(sunFn, moonFn, jdTdb);
  } catch (err) {
    resultEl.innerHTML = `<p style="color:var(--accent-warn)">農暦変換エラー: ${err.message}</p>`;
    return;
  }

  if (!lunarResult) {
    resultEl.innerHTML = '<p style="color:var(--accent-warn)">農暦変換に失敗しました（BSP カバー範囲外の可能性があります）</p>';
    return;
  }

  const { lunarMonth, lunarDay, isLeap, cycleMonths, dongzhiJd, newMoonJd } = lunarResult;

  // 農暦年（冬至サイクルの年 ≈ グレゴリオ年 ± 1）を表示用に推定
  const lunarYearApprox = gy - (gm <= 1 || (gm === 2 && gd < 5) ? 1 : 0);
  const leapMark = isLeap ? '閏' : '';

  // 年干支（農暦年から）
  const lunarYearIdx = ((lunarYearApprox - 4) % 60 + 60) % 60;
  const yearStemI    = lunarYearIdx % 10;
  const yearBranI    = lunarYearIdx % 12;

  // 命宮・身宮
  const mingIdx = (lunarMonth + 1 - hourBranI + 12) % 12;
  const shenIdx = (lunarMonth + hourBranI + 4) % 12;

  // 五行局
  const mingStemI = getMingGongStemIdx(yearStemI, mingIdx);
  const idx60     = ganzhi60Idx(mingStemI, mingIdx);
  const wuxingJu  = WUXING_JU_TABLE[Math.floor(idx60 / 2)];

  // 紫微星・天府星の宮
  const ziweiIdx  = Math.floor((lunarDay - 1) / wuxingJu) % 12;
  const tianfuIdx = (13 - ziweiIdx) % 12;

  // 十四主星配置
  const starsByBranch = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, []]));
  for (const [name, offset] of ZIWEI_SYSTEM) {
    starsByBranch[(ziweiIdx + offset + 12) % 12].push(name);
  }
  for (const [name, offset] of TIANFU_SYSTEM) {
    starsByBranch[(tianfuIdx + offset) % 12].push(name);
  }

  // 12宮配置（命宮起点、CCW順）
  const palaces = Array.from({ length: 12 }, (_, i) => ({
    palaceName: PALACE_NAMES[i],
    branchIdx:  (mingIdx + i) % 12,
    branch:     BRANCHES[(mingIdx + i) % 12],
    stars:      starsByBranch[(mingIdx + i) % 12] ?? [],
  }));

  const rows = palaces.map(p => {
    const isMing = p.branchIdx === mingIdx;
    const isShen = p.branchIdx === shenIdx;
    const marker = (isMing ? '★命' : '') + (isShen ? '☆身' : '');
    return `<tr>
      <td>${p.palaceName}${marker ? `<br><span style="color:var(--accent);font-size:11px">${marker}</span>` : ''}</td>
      <td>${p.branch}</td>
      <td>${p.stars.join('・') || '—'}</td>
    </tr>`;
  }).join('');

  const shenPalace = palaces.find(p => p.branchIdx === shenIdx);
  const wuxingName = WUXING_JU_NAMES[wuxingJu] ?? `${wuxingJu}局`;
  const male       = (gender === 'male');

  // 冬至・朔の日時表示（JD (TDB) → UTC+9 = JST）
  function jdToJstStr(jd) {
    const d = jdToDate(jd + 9 / 24, 'gregorian');
    return `${d.year}/${String(d.month).padStart(2,'0')}/${String(d.day).padStart(2,'0')} `
         + `${String(d.hour).padStart(2,'0')}:${String(d.minute).padStart(2,'0')} JST`;
  }

  // ── 宮干 ──────────────────────────────────────────────────────────────
  const palaceStemsMap = getPalaceStems(yearStemI);

  // ── 副星配置 ──────────────────────────────────────────────────────────
  const minorStars = placeMinorStars(yearStemI, yearBranI, lunarMonth, hourBranI);

  // ── 四化 ──────────────────────────────────────────────────────────────
  const sihuaList = SIHUA_TABLE[yearStemI] ?? [];

  // ── 紫微大限 ──────────────────────────────────────────────────────────
  const daixian = getZiweiDaixian(mingIdx, wuxingJu, male, gy, lunarYearApprox);

  // ── 出力 HTML ─────────────────────────────────────────────────────────

  const mainStarRows = palaces.map(p => {
    const isMing = p.branchIdx === mingIdx;
    const isShen = p.branchIdx === shenIdx;
    const marker = (isMing ? '★命' : '') + (isShen ? '☆身' : '');
    const palaceStemI = palaceStemsMap[p.branchIdx];
    const palaceStemName = `${STEMS[palaceStemI]}${p.branch}`;
    return `<tr>
      <td>${p.palaceName}${marker ? `<br><span style="color:var(--accent);font-size:11px">${marker}</span>` : ''}</td>
      <td>${p.branch}</td>
      <td style="color:var(--text-muted);font-size:11px">${palaceStemName}</td>
      <td>${p.stars.join('・') || '—'}</td>
    </tr>`;
  }).join('');

  const minorRows = Object.entries(minorStars).map(([name, bIdx]) =>
    `<tr><td>${name}</td><td>${BRANCHES[bIdx]}宮</td></tr>`
  ).join('');

  const sihuaStr = sihuaList.map(([s, h]) => `${s}${h}`).join('　');

  const daixianRows = daixian.periods.map(p => `<tr>
    <td>${p.seq}</td>
    <td style="font-weight:bold">${p.branch}</td>
    <td>${p.palaceName}</td>
    <td>${p.startAge}歳</td>
    <td>${p.startYear}年</td>
  </tr>`).join('');

  showResult('result-ziwei', `
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
      グレゴリオ: ${gy}/${String(gm).padStart(2,'0')}/${String(gd).padStart(2,'0')} ${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')} JST<br>
      農暦（旧暦）: <strong>${lunarYearApprox}年 ${leapMark}${lunarMonth}月 ${lunarDay}日</strong>
        （${cycleMonths}ヶ月年・${isLeap ? '閏月' : '通常月'}）<br>
      冬至: ${jdToJstStr(dongzhiJd)}　|　朔: ${jdToJstStr(newMoonJd)}<br>
      性別: ${male ? '男（陽）' : '女（陰）'}　|　年干支: ${STEMS[yearStemI]}${BRANCHES[yearBranI]}年<br>
      命宮: ${BRANCHES[mingIdx]}　身宮: ${BRANCHES[shenIdx]}（${shenPalace?.palaceName ?? ''}）　五行局: ${wuxingName}<br>
      紫微星: ${BRANCHES[ziweiIdx]}　天府星: ${BRANCHES[tianfuIdx]}
    </p>

    <h4 style="margin:12px 0 4px;font-size:13px">宮配置 ＋ 十四主星</h4>
    <table class="result-table">
      <thead><tr><th>宮名</th><th>地支</th><th>宮干支</th><th>十四主星</th></tr></thead>
      <tbody>${mainStarRows}</tbody>
    </table>

    <h4 style="margin:12px 0 4px;font-size:13px">副星配置</h4>
    <table class="result-table">
      <thead><tr><th>星名</th><th>宮位</th></tr></thead>
      <tbody>${minorRows}</tbody>
    </table>

    <h4 style="margin:12px 0 4px;font-size:13px">四化</h4>
    <p style="font-size:13px;margin:0">${sihuaStr || '—'}</p>

    <h4 style="margin:12px 0 4px;font-size:13px">紫微大限 — ${daixian.direction}（${daixian.polarity} × ${male ? '男命' : '女命'}）・起運${daixian.startAge}歳</h4>
    <table class="result-table">
      <thead><tr><th>No.</th><th>宮支</th><th>宮名</th><th>開始年齢</th><th>西暦目安</th></tr></thead>
      <tbody>${daixianRows}</tbody>
    </table>

    <p style="font-size:11px;color:var(--text-muted);margin:8px 0 0">
      ※ 農暦はグレゴリオ暦から BSP（JPL DE440s）を使って自動算出しています<br>
      ※ 主星配置・副星・大限は流派によって異なる場合があります
    </p>`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ════════════════════ 月のボイドタイム ══════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// ボイドタイム対象天体（月以外の9天体）
const VOID_PLANETS = [
  { id: NAIF.SUN,               name: '太陽' },
  { id: NAIF.MERCURY_BARYCENTER,name: '水星' },
  { id: NAIF.VENUS_BARYCENTER,  name: '金星' },
  { id: NAIF.MARS_BARYCENTER,   name: '火星' },
  { id: NAIF.JUPITER_BARYCENTER,name: '木星' },
  { id: NAIF.SATURN_BARYCENTER, name: '土星' },
  { id: NAIF.URANUS_BARYCENTER, name: '天王星' },
  { id: NAIF.NEPTUNE_BARYCENTER,name: '海王星' },
  { id: NAIF.PLUTO_BARYCENTER,  name: '冥王星' },
];

const VOID_ASPECTS = [0, 60, 90, 120, 180];  // 主要5相

/**
 * 月のボイドタイムを計算する（純粋関数）
 * アルゴリズム:
 *   ① 月のイングレス時刻を 2時間サンプリング + 二分探索で検出
 *   ② 各星座滞在区間で月-惑星アスペクトの exact 時刻を 30分サンプリングで全走査
 *   ③ 区間内の最後のアスペクト時刻 = ボイド開始
 *   ④ ボイド終了 = 次のイングレス時刻
 * @param {number} startJd UTC JD
 * @param {number} endJd   UTC JD
 * @returns {Array<{voidStart, voidEnd, lastAspectName, lastAspectDeg, ingressSign}>}
 */
function calculateVoidOfCourse(startJd, endJd) {
  // ─ ① 月イングレス検出 ─────────────────────────────────────────────────────
  const INGRESS_STEP = 2 / 24;  // 2時間

  function moonLon(jd) {
    return computeApparent(NAIF.MOON, jdUtcToTdb(jd)).lon;
  }

  function signIdx(lon) { return Math.floor(lon / 30) % 12; }

  const ingresses = [];
  let prevJd  = startJd;
  let prevSign= signIdx(moonLon(startJd));

  for (let jd = startJd + INGRESS_STEP; jd <= endJd + INGRESS_STEP; jd += INGRESS_STEP) {
    const curSign = signIdx(moonLon(jd));
    if (curSign !== prevSign) {
      let lo = prevJd, hi = jd;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (signIdx(moonLon(lo)) === signIdx(moonLon(mid))) lo = mid; else hi = mid;
        if ((hi - lo) * 86400 < 1) break;
      }
      const precise = (lo + hi) / 2;
      ingresses.push({ jd: precise, signIdx: curSign });
    }
    prevJd = jd; prevSign = curSign;
  }

  // ─ ② 各区間のアスペクト検出 ─────────────────────────────────────────────
  const ASPECT_STEP = 1 / 24;  // 1時間（精度と速度のバランス）

  function moonPlanetDev(jd, naifId, targetDeg) {
    const moonL = moonLon(jd);
    const planL = computeApparent(naifId, jdUtcToTdb(jd)).lon;
    let sep = Math.abs(moonL - planL) % 360;
    if (sep > 180) sep = 360 - sep;
    return sep - targetDeg;
  }

  // 期間境界を追加して区間リストを構築
  const boundaries = [{ jd: startJd, signIdx: signIdx(moonLon(startJd)) }, ...ingresses];
  const voids = [];

  for (let i = 0; i < boundaries.length; i++) {
    const segStart = boundaries[i].jd;
    const segEnd   = i + 1 < boundaries.length ? boundaries[i + 1].jd : endJd;

    // 区間が短すぎる場合はスキップ
    if (segEnd - segStart < 0.01) continue;

    // 区間内のアスペクトイベントを全走査
    const aspectEvents = [];

    for (const planet of VOID_PLANETS) {
      for (const targetDeg of VOID_ASPECTS) {
        let prevVal = moonPlanetDev(segStart, planet.id, targetDeg);
        for (let jd = segStart + ASPECT_STEP; jd <= segEnd; jd += ASPECT_STEP) {
          const curVal = moonPlanetDev(jd, planet.id, targetDeg);
          if (prevVal * curVal < 0) {
            // 符号変化 → exact 時刻を二分探索
            let lo = jd - ASPECT_STEP, loV = prevVal, hi = jd;
            for (let iter = 0; iter < 60; iter++) {
              const mid = (lo + hi) / 2;
              const midV = moonPlanetDev(mid, planet.id, targetDeg);
              if (loV * midV <= 0) { hi = mid; } else { lo = mid; loV = midV; }
              if ((hi - lo) * 86400 < 1) break;
            }
            const exactJd = (lo + hi) / 2;
            if (exactJd >= segStart && exactJd <= segEnd) {
              aspectEvents.push({ jd: exactJd, planet: planet.name, deg: targetDeg });
            }
          }
          prevVal = curVal;
        }
      }
    }

    // 区間内に次のイングレスがある場合のみボイドを計算
    if (i + 1 < boundaries.length) {
      const nextIngress = boundaries[i + 1];
      if (aspectEvents.length > 0) {
        // 最後のアスペクト
        const last = aspectEvents.reduce((a, b) => a.jd > b.jd ? a : b);
        const VOID_ASP_NAMES = {0:'合',60:'六分',90:'四分',120:'三分',180:'衝'};
        voids.push({
          voidStart:       last.jd,
          voidEnd:         nextIngress.jd,
          lastAspectPlanet: last.planet,
          lastAspectDeg:   last.deg,
          lastAspectName:  VOID_ASP_NAMES[last.deg] ?? `${last.deg}°`,
          ingressSignIdx:  nextIngress.signIdx,
        });
      } else {
        // アスペクトなし → 区間全体がボイド
        voids.push({
          voidStart:       segStart,
          voidEnd:         nextIngress.jd,
          lastAspectPlanet: '（なし）',
          lastAspectDeg:   null,
          lastAspectName:  '—',
          ingressSignIdx:  nextIngress.signIdx,
        });
      }
    }
  }

  return voids;
}

document.getElementById('form-void').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireBsp('result-void')) return;

  const startStr = document.getElementById('void-start').value;
  const endStr   = document.getElementById('void-end').value;
  const startJd  = dateStrToJdUtcMidJst(startStr);
  let   endJd    = dateStrToJdUtcMidJst(endStr) + 1.0;

  if (endJd <= startJd) {
    showResult('result-void', '終了日は開始日以降にしてください。', true);
    return;
  }
  if (endJd - startJd > 31) {
    endJd = startJd + 31;
    showResult('result-void', '<p style="color:#f4a460">計算期間を最大31日に制限しました。</p>');
  }

  const voidDays = Math.ceil(endJd - startJd);
  showLoading('result-void', '計算中…', `月のイングレスとアスペクトを走査（最大 ${voidDays} 日間）`);
  await yieldFrame();

  let voids;
  try {
    voids = calculateVoidOfCourse(startJd, endJd);
  } catch (err) {
    showResult('result-void', `計算エラー: ${err.message}`, true);
    return;
  }

  if (voids.length === 0) {
    showResult('result-void',
      `<p style="color:var(--text-muted)">指定期間にボイドタイムなし（${startStr} 〜 ${endStr}）</p>`);
    return;
  }

  const rows = voids.map(v => {
    const durMin = Math.round((v.voidEnd - v.voidStart) * 24 * 60);
    const durStr = durMin >= 60
      ? `${Math.floor(durMin / 60)}時間${durMin % 60}分`
      : `${durMin}分`;
    return `<tr>
      <td>${jdToJstStr(v.voidStart)}</td>
      <td>${jdToJstStr(v.voidEnd)}</td>
      <td>${durStr}</td>
      <td>${v.lastAspectPlanet}</td>
      <td>${v.lastAspectName}（${v.lastAspectDeg ?? '—'}°）</td>
      <td>${ZODIAC_SIGNS_JP[v.ingressSignIdx]}</td>
    </tr>`;
  }).join('');

  showResult('result-void', `
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
      ${startStr} 〜 ${endStr}　|　現代派（主要5相・exact）　|　${voids.length} 期間
    </p>
    <table class="result-table">
      <thead><tr>
        <th>ボイド開始 (JST)</th><th>ボイド終了 (JST)</th><th>継続時間</th>
        <th>最後のアスペクト</th><th>種別</th><th>次の星座</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
});

// 3-6 時代考証ホロスコープは除外
// 理由: DE440s の収録範囲（約 BC3000〜AD3000）を古代年で使用すると
//       セグメント外エラーが発生するため、UI から削除。


// ═══════════════════════════════════════════════════════════════════════════════
// ════════════════════ 天体観測モード ════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// ── 定数 ──────────────────────────────────────────────────────────────────────

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

// ── 共通ヘルパー ───────────────────────────────────────────────────────────────

/** 日付文字列 "YYYY-MM-DD" → JST 0:00 の UTC JD */
function dateStrToJdUtcMidJst(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return dateToJd(y, m, d - 9 / 24);
}

/** 方位角 → 8方位文字列 */
function azDir(az) {
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(az / 45) % 8];
}

/**
 * 天体の地平高度を計算する（純粋関数）
 *
 * トポセントリック補正を適用するため、地心座標と比べて月は最大 ~57' 異なる。
 *
 * @param {number} naifId  NAIF コード
 * @param {number} jdUtc   UTC JD
 * @param {number} lat     観測緯度（度）
 * @param {number} lon     観測経度（度）
 * @param {number} [elev=0] 標高（km）
 * @returns {number} 高度（度）
 */
function bodyAltitude(naifId, jdUtc, lat, lon, elev = 0) {
  const jdTdb       = jdUtcToTdb(jdUtc);
  const observer    = { lat, lon, elev };
  const body        = computeApparent(naifId, jdTdb, { jdUtc, observer });
  const eps         = obliquity(jdTdb);
  const { ra, dec } = eclipticToEquatorial(body.lon, body.lat, eps);
  return altitudeAzimuth(ra, dec, jdUtc, lat, lon).alt;
}

/**
 * 天体の高度・方位角・黄経・距離を計算する（純粋関数）
 *
 * トポセントリック補正を適用する（月・惑星の望遠鏡観測に対応）。
 *
 * @param {number} naifId  NAIF コード
 * @param {number} jdUtc   UTC JD
 * @param {number} lat     観測緯度（度）
 * @param {number} lon     観測経度（度）
 * @param {number} [elev=0] 標高（km）
 * @returns {{ alt, az, dist, eclLon }}
 */
function bodyAltAz(naifId, jdUtc, lat, lon, elev = 0) {
  const jdTdb       = jdUtcToTdb(jdUtc);
  const observer    = { lat, lon, elev };
  const body        = computeApparent(naifId, jdTdb, { jdUtc, observer });
  const eps         = obliquity(jdTdb);
  const { ra, dec } = eclipticToEquatorial(body.lon, body.lat, eps);
  const { alt, az } = altitudeAzimuth(ra, dec, jdUtc, lat, lon);
  return { alt, az, dist: body.dist, eclLon: body.lon };
}

/**
 * 1日の出没・南中時刻を二分探索で算出する（純粋関数）
 *
 * @param {number} naifId   NAIF コード
 * @param {number} dayJdUtc 該当日 JST 0:00 の UTC JD
 * @param {number} lat      観測緯度（度）
 * @param {number} lon      観測経度（度）
 * @param {number} [horizon=-0.833] 地平高度閾値（度）
 * @returns {{ riseJd, transitJd, transitAlt, setJd, polarDay, polarNight }}
 */
function findRiseTransitSet(naifId, dayJdUtc, lat, lon, horizon = -0.833) {
  const STEP = 15 / 1440;  // 15 分サンプリング

  const samples = [];
  for (let t = dayJdUtc; t <= dayJdUtc + 1.0; t += STEP) {
    samples.push({ jd: t, alt: bodyAltitude(naifId, t, lat, lon) });
  }

  // 南中（最大高度）— 放物線近似で精密化
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
      transitAlt = bodyAltitude(naifId, transitJd, lat, lon);
    }
  }

  const minAlt   = Math.min(...samples.map(s => s.alt));
  const polarDay   = minAlt  > horizon;
  const polarNight = maxAlt  < horizon;

  function bisect(lo, hi) {
    if ((bodyAltitude(naifId, lo, lat, lon) - horizon) *
        (bodyAltitude(naifId, hi, lat, lon) - horizon) > 0) return null;
    let a = lo, b = hi;
    for (let i = 0; i < 50; i++) {
      const mid = (a + b) / 2;
      if ((bodyAltitude(naifId, a, lat, lon) - horizon) *
          (bodyAltitude(naifId, mid, lat, lon) - horizon) <= 0) {
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

// ── 純粋計算関数 ──────────────────────────────────────────────────────────────

/**
 * 月相イベントを計算する（8相検出, 二分探索）
 * @param {number} startJdUtc 開始 UTC JD
 * @param {number} endJdUtc   終了 UTC JD
 * @returns {Array}
 */
function calculateMoonPhases(startJdUtc, endJdUtc) {
  const SUN = NAIF.SUN, MOON = NAIF.MOON;

  function phaseAngle(jd) {
    const t  = jdUtcToTdb(jd);
    const mL = computeApparent(MOON, t).lon;
    const sL = computeApparent(SUN, t).lon;
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

/**
 * 月相連続変化を計算する（時系列サンプリング）
 * @param {number} startJdUtc
 * @param {number} endJdUtc
 * @param {number} intervalHours
 * @returns {Array}
 */
function calculateMoonPhaseContinuous(startJdUtc, endJdUtc, intervalHours) {
  const SUN = NAIF.SUN, MOON = NAIF.MOON;
  const stepJd = intervalHours / 24;
  const records = [];
  let prevIdx = null;

  for (let jd = startJdUtc; jd <= endJdUtc; jd += stepJd) {
    const t     = jdUtcToTdb(jd);
    const mL    = computeApparent(MOON, t).lon;
    const sL    = computeApparent(SUN, t).lon;
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

/**
 * 24節気を計算する（指定年の 24 節気イベント）
 * @param {number} year
 * @returns {Array}
 */
function calculateSolarTerms(year) {
  const SUN = NAIF.SUN;

  function dev(jdUtc, target) {
    const lon = computeApparent(SUN, jdUtcToTdb(jdUtc)).lon;
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

// ── 天体風景 — 天体リスト ─────────────────────────────────────────────────────
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

// ── 1. 月相イベント ────────────────────────────────────────────────────────────

document.getElementById('form-moon-phase').addEventListener('submit', async e => {
  e.preventDefault();
  if (!bspFile) { alert('BSP ファイルを先に読み込んでください。'); return; }

  const startStr = document.getElementById('moon-phase-start').value;
  const endStr   = document.getElementById('moon-phase-end').value;
  const resultEl = document.getElementById('result-moon-phase');

  showLoading(resultEl.id, '計算中…');
  await yieldFrame();

  try {
    const startJd = dateStrToJdUtcMidJst(startStr);
    const endJd   = dateStrToJdUtcMidJst(endStr) + 1.0;
    const events  = calculateMoonPhases(startJd, endJd);

    if (events.length === 0) {
      resultEl.innerHTML = '<p>指定期間内に月相イベントはありませんでした。</p>';
      return;
    }

    const ICONS = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
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

    resultEl.innerHTML = `
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
    resultEl.innerHTML = `<p style="color:var(--error)">エラー: ${err.message}</p>`;
  }
});

// ── 2. 月相連続変化 ────────────────────────────────────────────────────────────

document.getElementById('form-moon-cont').addEventListener('submit', async e => {
  e.preventDefault();
  if (!bspFile) { alert('BSP ファイルを先に読み込んでください。'); return; }

  const startStr  = document.getElementById('moon-cont-start').value;
  const endStr    = document.getElementById('moon-cont-end').value;
  const intervalH = Number(document.getElementById('moon-cont-interval').value);
  const resultEl  = document.getElementById('result-moon-cont');

  showLoading(resultEl.id, '計算中…');
  await yieldFrame();

  try {
    const startJd = dateStrToJdUtcMidJst(startStr);
    const endJd   = dateStrToJdUtcMidJst(endStr) + 1.0;
    const records = calculateMoonPhaseContinuous(startJd, endJd, intervalH);

    const ICONS = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
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

    resultEl.innerHTML = `
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
    resultEl.innerHTML = `<p style="color:var(--error)">エラー: ${err.message}</p>`;
  }
});

// ── 3. 太陽の出没時刻 ─────────────────────────────────────────────────────────

document.getElementById('form-sunrise').addEventListener('submit', async e => {
  e.preventDefault();
  if (!bspFile) { alert('BSP ファイルを先に読み込んでください。'); return; }

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

  showLoading(resultEl.id, '計算中…', `${dayCount}日分を計算`);
  await yieldFrame();

  try {
    const SUN  = NAIF.SUN;
    const rows = [];
    let cur = new Date(startStr + 'T00:00:00Z');
    const end = new Date(endStr + 'T00:00:00Z');

    while (cur <= end) {
      const ds    = cur.toISOString().substring(0, 10);
      const dayJd = dateStrToJdUtcMidJst(ds);
      const rs    = findRiseTransitSet(SUN, dayJd, lat, lon);

      const rStr = rs.riseJd    ? jdToJstStr(rs.riseJd).substring(11, 19)    : (rs.polarDay ? '白夜' : '極夜');
      const tStr = jdToJstStr(rs.transitJd).substring(11, 19);
      const sStr = rs.setJd     ? jdToJstStr(rs.setJd).substring(11, 19)     : (rs.polarDay ? '白夜' : '極夜');
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
    resultEl.innerHTML = `<p style="color:var(--error)">エラー: ${err.message}</p>`;
  }
});

// ── 4. 月の出没時刻 ────────────────────────────────────────────────────────────

document.getElementById('form-moonrise').addEventListener('submit', async e => {
  e.preventDefault();
  if (!bspFile) { alert('BSP ファイルを先に読み込んでください。'); return; }

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

  showLoading(resultEl.id, '計算中…', `${dayCount}日分を計算`);
  await yieldFrame();

  try {
    const MOON = NAIF.MOON;
    const rows = [];
    let cur = new Date(startStr + 'T00:00:00Z');
    const end = new Date(endStr + 'T00:00:00Z');

    while (cur <= end) {
      const ds    = cur.toISOString().substring(0, 10);
      const dayJd = dateStrToJdUtcMidJst(ds);
      const rs    = findRiseTransitSet(MOON, dayJd, lat, lon);

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
    resultEl.innerHTML = `<p style="color:var(--error)">エラー: ${err.message}</p>`;
  }
});

// ── 5. 天体風景（高度・方位） ──────────────────────────────────────────────────

document.getElementById('form-landscape').addEventListener('submit', async e => {
  e.preventDefault();
  if (!bspFile) { alert('BSP ファイルを先に読み込んでください。'); return; }

  const dtStr    = document.getElementById('landscape-datetime').value;
  const lat      = Number(document.getElementById('landscape-lat').value);
  const lon      = Number(document.getElementById('landscape-lon').value);
  const resultEl = document.getElementById('result-landscape');

  showLoading(resultEl.id, '計算中…');
  await yieldFrame();

  try {
    // datetime-local "YYYY-MM-DDTHH:MM" → UTC JD（JST 入力）
    const [datePart, timePart = '00:00'] = dtStr.split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm]  = timePart.split(':').map(Number);
    const jdUtcVal  = dateToJd(y, m, d + (hh - 9 + mm / 60) / 24);

    const results = LANDSCAPE_BODIES.map(body => {
      const { alt, az, dist, eclLon } = bodyAltAz(body.id, jdUtcVal, lat, lon);
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

    resultEl.innerHTML = `
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
    resultEl.innerHTML = `<p style="color:var(--error)">エラー: ${err.message}</p>`;
  }
});

// ── 7. 24節気カレンダー ────────────────────────────────────────────────────────

document.getElementById('form-sekki').addEventListener('submit', async e => {
  e.preventDefault();
  if (!bspFile) { alert('BSP ファイルを先に読み込んでください。'); return; }

  const year     = Number(document.getElementById('sekki-year').value);
  const resultEl = document.getElementById('result-sekki');

  showLoading(resultEl.id, '計算中…');
  await yieldFrame();

  try {
    const events = calculateSolarTerms(year);
    const KEY_LONS = new Set([0, 90, 180, 270]);

    const rows = events.map((ev, i) => {
      const s    = jdToJstStr(ev.jd);
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

    resultEl.innerHTML = `
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
    resultEl.innerHTML = `<p style="color:var(--error)">エラー: ${err.message}</p>`;
  }
});

// ── 基準物理天体暦 A. 惑星基準物理天体暦（Planet-Physics） ──────────────────

document.getElementById('form-phys-planet').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireBsp('result-phys-planet')) return;

  // 観測中心は地心（地球）固定
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

  // 対象惑星リスト（地球自身は除外）
  let selectedPlanets;
  if (planetVal === 'all') {
    selectedPlanets = PHYS_PLANETS_ALL.filter(p => p.id !== NAIF.EARTH);
  } else {
    const pid   = parseInt(planetVal, 10);
    const found = PHYS_PLANETS_ALL.find(p => p.id === pid);
    if (!found) { showResult('result-phys-planet', '対象天体が不明です。', true); return; }
    selectedPlanets = [found];
  }

  // 行数・計算量の事前確認
  // while ループ条件 (jd <= endJdTdb + stepJd * 0.001) と一致するよう
  // Math.floor(... + 0.001) を使い、実際の反復回数と合わせる
  const nSteps    = Math.floor((endJdTdb - startJdTdb) / stepJd + 0.001) + 1;
  const totalRows = nSteps * selectedPlanets.length;
  if (totalRows > 5000 && !confirm(
    `推定出力行数: ${totalRows.toLocaleString()} 行\n` +
    (totalRows > 20000 ? '非常に多い行数です。計算に時間がかかる場合があります。\n' : '') +
    '続行しますか？'
  )) return;

  showLoading('result-phys-planet', '計算中… 0%', selectedPlanets[0].name);
  await yieldFrame();

  const coordSuffix = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';

  // ── 計算ループ ──
  // 各惑星について全ステップの位置を先にサンプリングし、
  // 隣接値から角速度 ω を中央差分で算出（BSP コール数を最小化）
  const rows = [];

  // 進捗管理（時間ベース: 100ms ごとに描画）
  let completedSteps = 0;
  let lastYieldTime  = Date.now();

  for (const planet of selectedPlanets) {
    // 全ステップ位置をサンプリング（for ループで浮動小数点累積誤差を防ぐ）
    const positions = [];
    for (let i = 0; i < nSteps; i++) {
      const jd = startJdTdb + i * stepJd;
      try {
        const pos = computeFromCenter(planet.id, centerNaifId, jd);
        positions.push({ jd, lon: pos.lon, lat: pos.lat, dist: pos.dist });
      } catch {
        positions.push({ jd, lon: null, lat: null, dist: null });
      }

      // 100ms 経過ごとに進捗を更新して描画に譲る
      completedSteps++;
      const now = Date.now();
      if (now - lastYieldTime > 100) {
        setProgress('result-phys-planet', (completedSteps / totalRows) * 100, planet.name);
        await yieldFrame();
        lastYieldTime = Date.now();
      }
    }
    // 惑星 1 本完了時に必ず進捗を反映（短い計算で 100ms が来ない場合の保証）
    setProgress('result-phys-planet', (completedSteps / totalRows) * 100, planet.name);
    await yieldFrame();

    // 角速度を中央差分で算出（端点は前進/後退差分）
    for (let i = 0; i < positions.length; i++) {
      const cur = positions[i];
      if (cur.lon === null) continue;

      let speed = 0;
      const prev = i > 0 ? positions[i - 1] : null;
      const next = i < positions.length - 1 ? positions[i + 1] : null;

      // !=(緩い等価) で undefined と null の両方を「値なし」として扱う
      // prev/next が null オブジェクトのとき prev?.lon は undefined を返すため
      // !== null (厳密等価) では誤って true になる
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

  // ── .txt データ生成 ──
  const coordLabel = settings.coordSystem === 'j2000' ? 'J2000.0' : 'of-date';
  const planetsLabel = planetVal === 'all'
    ? `全惑星（${selectedPlanets.map(p => p.name).join('・')}）`
    : selectedPlanets[0].name;
  const txtMeta = {
    ephemeris:  `JPL DE天体再定義暦『${centerName}基準物理天体暦』`,
    center:     centerLabel,
    coordLabel: `${coordLabel} 黄道`,
    planets:    planetsLabel,
    step:       stepLabel,
    period:     `${startVal.replace('T', ' ')} 〜 ${endVal.replace('T', ' ')} JST`,
  };
  const txtContent = buildTxtContent(rows, txtMeta);

  const startTag  = startVal.replace('T', '_').replace(/[-:]/g, '');
  const endTag    = endVal.replace('T', '_').replace(/[-:]/g, '');
  const txtFilename = `planet_physics_${centerName}_${coordLabel}_${stepKey}_${startTag}_${endTag}.txt`;

  // ── 表示（先頭 100 行） ──
  const previewRows = rows.slice(0, 100);
  const tableRows = previewRows.map(r =>
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

// ─── Changelog MD loader ───────────────────────────────────────────────────

/**
 * インライン記法（bold / italic / code / link）を HTML に変換する。
 * テキストは事前に HTML エスケープ済みであること。
 */
function _mdInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/**
 * Markdown テキストを HTML 文字列に変換する（外部ライブラリ不要・軽量実装）。
 * 対応記法: h1–h4 / h2–h3（##/###）/ hr / ul（-）/ table（|）/ paragraph
 */
function _simpleMarkdown(md) {
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = md.split('\n');
  const out = [];
  let inList = false;
  let inTable = false;
  let tableRows = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    out.push('<table class="result-table cl-table">');
    out.push('<thead><tr>');
    tableRows[0].forEach(c => out.push(`<th>${_mdInline(escape(c))}</th>`));
    out.push('</tr></thead><tbody>');
    for (let r = 1; r < tableRows.length; r++) {
      out.push('<tr>');
      tableRows[r].forEach(c => out.push(`<td>${_mdInline(escape(c))}</td>`));
      out.push('</tr>');
    }
    out.push('</tbody></table>');
    tableRows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    // --- テーブル行 ---
    if (trimmed.startsWith('|')) {
      if (!inList && inList !== false) { out.push('</ul>'); inList = false; }
      if (!inTable) inTable = true;
      // 区切り行（|---|---|）はスキップ
      if (/^\|[-:| ]+\|$/.test(trimmed)) continue;
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
      inTable = false;
    }

    // --- リスト行 ---
    if (/^[-*] /.test(trimmed)) {
      if (!inList) { out.push('<ul class="changelog-list">'); inList = true; }
      out.push(`<li>${_mdInline(escape(trimmed.slice(2)))}</li>`);
      continue;
    } else if (inList) {
      out.push('</ul>');
      inList = false;
    }

    // --- 見出し ---
    const hm = trimmed.match(/^(#{1,4}) (.+)$/);
    if (hm) {
      const level = Math.min(hm[1].length + 2, 6); // ## → h4, ### → h5
      const cls = ['cl-h2', 'cl-h3', 'cl-h4', 'cl-h5'][hm[1].length - 1] || 'cl-h5';
      out.push(`<h${level} class="${cls}">${_mdInline(escape(hm[2]))}</h${level}>`);
      continue;
    }

    // --- 水平線 ---
    if (/^[-*]{3,}$/.test(trimmed)) {
      out.push('<hr>');
      continue;
    }

    // --- 空行 ---
    if (trimmed === '') continue;

    // --- 通常段落 ---
    out.push(`<p class="cl-p">${_mdInline(escape(trimmed))}</p>`);
  }

  if (inList) out.push('</ul>');
  if (inTable) flushTable();

  return out.join('\n');
}

/**
 * ./CHANGELOG.md を fetch してレンダリングする（遅延読み込み・一度だけ）。
 */
async function loadChangelog() {
  const el = document.getElementById('changelog-content');
  if (!el || el.dataset.loaded) return;

  el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">読み込み中…</p>';
  try {
    const res = await fetch('./CHANGELOG.md');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    el.innerHTML = _simpleMarkdown(text);
    el.dataset.loaded = '1';
  } catch (e) {
    el.innerHTML = `<p style="color:var(--accent-warn);font-size:13px">
      更新履歴を読み込めませんでした（${e.message}）<br>
      <span style="font-size:11px;color:var(--text-muted)">
        public/CHANGELOG.md が存在するか確認してください。
      </span>
    </p>`;
  }
}

// ※ changelog の遅延読み込みは nav-item ハンドラー内で処理

// ════════════════════ E-1: 日付・暦変換 ══════════════════════════════════════

const _UNIX_EPOCH_JD = 2440587.5;  // 1970-01-01 00:00:00 UTC
const _MJD_OFFSET    = 2400000.5;  // MJD = JD − 2400000.5

/** 数値を0埋めして返す */
function _pad(n, w = 2) { return String(Math.abs(n)).padStart(w, '0'); }

/** JD → 表示用日付文字列（指定暦） */
function _jdToDisplayStr(jd, cal, tz = 'UTC') {
  const { year, month, day, hour, minute, second } = jdToDate(jd, cal);
  const { absYear, era } = astroYearToHistorical(year);
  const eraStr = era === 'BC' ? `BC ${absYear}` : `${absYear}`;
  const secInt = Math.floor(second);
  const ms     = Math.round((second - secInt) * 1000);
  const secStr = ms > 0
    ? `${_pad(secInt)}.${String(ms).padStart(3, '0')}`
    : _pad(secInt);
  return `${eraStr}年 ${_pad(month)}月 ${_pad(day)}日 ${_pad(hour)}:${_pad(minute)}:${secStr} ${tz}`;
}

document.getElementById('form-cal-conv').addEventListener('submit', e => {
  e.preventDefault();
  const resultEl = document.getElementById('result-cal-conv');

  const era      = document.getElementById('cal-conv-era').value;
  const absYear  = parseInt(document.getElementById('cal-conv-year').value,  10);
  const month    = parseInt(document.getElementById('cal-conv-month').value, 10);
  const day      = parseInt(document.getElementById('cal-conv-day').value,   10);
  const hour     = parseInt(document.getElementById('cal-conv-hour').value,   10) || 0;
  const minute   = parseInt(document.getElementById('cal-conv-minute').value, 10) || 0;
  const second   = parseInt(document.getElementById('cal-conv-second').value, 10) || 0;
  const calendar = document.getElementById('cal-conv-calendar').value;

  if (isNaN(absYear) || isNaN(month) || isNaN(day)) {
    resultEl.innerHTML = '<p style="color:var(--accent-warn)">年・月・日を入力してください。</p>';
    return;
  }

  const year = historicalYearToAstro(absYear, era);

  // 入力は JST → UTC に変換（-9h）してから JD 計算
  let jd;
  try {
    jd = dateToJd(year, month, day, hour - 9, minute, second, calendar);
  } catch (err) {
    resultEl.innerHTML = `<p style="color:var(--accent-warn)">${err.message}</p>`;
    return;
  }

  const mjd  = jd - _MJD_OFFSET;
  const unix = (jd - _UNIX_EPOCH_JD) * 86400;

  const gregStr    = _jdToDisplayStr(jd,           'gregorian', 'UTC');
  const julStr     = _jdToDisplayStr(jd,           'julian',    'UTC');
  const gregJstStr = _jdToDisplayStr(jd + 9 / 24, 'gregorian', 'JST');
  const julJstStr  = _jdToDisplayStr(jd + 9 / 24, 'julian',    'JST');
  const astroYearSign = year >= 0 ? `+${year}` : `${year}`;
  const unixNote = unix < 0 ? ' <span style="color:var(--text-muted);font-size:11px">（負値: 1970-01-01 UTC 以前）</span>' : '';

  resultEl.innerHTML = `
    <table class="result-table" style="width:100%;border-collapse:collapse;font-size:13px">
      <colgroup><col style="width:42%"><col style="width:58%"></colgroup>
      <thead>
        <tr><th colspan="2" style="text-align:left;padding:6px 8px;background:var(--bg-sub);border-bottom:1px solid var(--border)">変換結果</th></tr>
      </thead>
      <tbody>
        <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">グレゴリオ暦 (UTC)</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${gregStr}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">グレゴリオ暦 (JST)</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${gregJstStr} <span style="font-size:11px;color:var(--text-muted)">(+09:00)</span></td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">ユリウス暦 (UTC)</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${julStr}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">ユリウス暦 (JST)</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${julJstStr} <span style="font-size:11px;color:var(--text-muted)">(+09:00)</span></td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">天文学年番号 (Year 0 あり)</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${astroYearSign}年 ${_pad(month)}月 ${_pad(day)}日</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">ユリウス日 (JD)</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${jd.toFixed(6)}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">修正ユリウス日 (MJD)</td>
            <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${mjd.toFixed(6)}</td></tr>
        <tr><td style="padding:6px 8px;color:var(--text-muted)">Unix タイムスタンプ (秒)</td>
            <td style="padding:6px 8px;font-family:monospace">${unix < 0 ? unix.toFixed(3) : Math.round(unix)}${unixNote}</td></tr>
      </tbody>
    </table>
    <p style="font-size:11px;color:var(--text-muted);margin-top:8px">
      入力暦: <b>${calendar === 'auto' ? '自動' : calendar === 'gregorian' ? 'グレゴリオ暦' : 'ユリウス暦'}</b>
      &nbsp;|&nbsp; 入力時刻系: JST（UTC+9）
    </p>
  `;
});
