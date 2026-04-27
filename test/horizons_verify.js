/**
 * horizons_verify.js — Stella-JS 内部精度検証（JPL Horizons 照合）
 *
 * Stella OS (Python) の horizons_check.py と同一テストケースを
 * Stella-JS エンジンで計算し、JPL Horizons API の結果と比較する。
 *
 * 実行: node test/horizons_verify.js
 *
 * 比較フレーム:
 *   - Stella-JS: of-date 黄道（光偏差 + 年周光行差あり = apparent）
 *     → computeApparent(naif, jdTdb) 相当
 *     → Python 版 Chart(use_j2000=False) のデフォルト動作と同等
 *   - Horizons:  ECLIP=J2000（名称に反して of-date 黄道を返す）
 *     → Python 版との検証で 0.00001° 以下の一致を確認済み
 *
 * 閾値:
 *   < 0.000010° → 良好（仕様精度 / ICRS フレームバイアス補正後の実績値に基づく）
 *   < 0.001°    → 許容範囲（要注意）
 *   ≥ 0.001°    → ロジックチェック推奨
 *
 * 実績（2026/04/27 計測・ICRS フレームバイアス補正後）:
 *   全 10 ケース ✅ 良好 / 最大差 0.0000045°（火星 Case B）= 0.016"
 */

import { fileURLToPath } from 'node:url';
import https from 'node:https';

import { loadBsp, parseBsp } from '../public/src/core/bsp-reader.js';
import { jdUtcToTdb, dateToJd } from '../public/src/core/timescale.js';
import {
  icrsToEcliptic,
  normAngle,
  applyLightDeflection,
  applyAberration,
} from '../public/src/astro/coordinates.js';
import { NAIF } from '../public/src/core/constants.js';

// ── 定数 ─────────────────────────────────────────────────────────────────────

const C_KM_PER_DAY = 299792.458 * 86400;   // 光速 [km/day]
const BSP_ABS      = fileURLToPath(new URL('../public/data/de440s.bsp', import.meta.url));

// ── テストケース定義（Python 版 horizons_check.py と同一）──────────────────

const TEST_PLANETS = [
  { name: '太陽 (Sun)',     naif: NAIF.SUN,                hzId: '10'  },
  { name: '月 (Moon)',      naif: NAIF.MOON,               hzId: '301' },
  { name: '金星 (Venus)',   naif: NAIF.VENUS_BARYCENTER,   hzId: '299' },
  { name: '火星 (Mars)',    naif: NAIF.MARS_BARYCENTER,    hzId: '499' },
  { name: '木星 (Jupiter)', naif: NAIF.JUPITER_BARYCENTER, hzId: '599' },
];

// jdUtc: UTC でのユリウス日  hzStart: Horizons API 用の日時文字列
const TEST_DATES = [
  {
    label:   'Case A: 2000-01-01 12:00 UTC（J2000 エポック付近）',
    jdUtc:   2451545.0,
    hzStart: "'2000-Jan-01 12:00'",
    hzStop:  "'2000-Jan-01 12:01'",
  },
  {
    label:   'Case B: 2025-10-26 05:30 UTC（既存ローカルテスト同日時）',
    jdUtc:   dateToJd(2025, 10, 26, 5, 30, 0),
    hzStart: "'2025-Oct-26 05:30'",
    hzStop:  "'2025-Oct-26 05:31'",
  },
];

// ── Stella-JS 計算（astrometric / of-date 黄道）────────────────────────────

/**
 * 天体の地心視位置を of-date 黄経 [°] で返す（純粋関数）
 *
 * Python 版 Chart(use_j2000=False) のデフォルト動作と同等:
 *   光行時間補正 → 光偏差補正（太陽以外）→ 年周光行差 → icrsToEcliptic
 *   app.js の computeApparent(naif, jdTdb, { aberration: true }) と同じロジック。
 *
 * @param {object} bsp   parseBsp() の戻り値
 * @param {number} naif  NAIF コード
 * @param {number} jdTdb TDB ユリウス日
 * @returns {number} [0, 360) の黄経 [°]
 */
function calcStellaPosition(bsp, naif, jdTdb) {
  // 1. 幾何学的距離 → 光行時間 τ [day]
  const geoPos  = bsp.computePosition(naif, NAIF.EARTH, jdTdb);
  const geoDist = Math.sqrt(geoPos[0] ** 2 + geoPos[1] ** 2 + geoPos[2] ** 2);
  const tau     = geoDist / C_KM_PER_DAY;

  // 2. 実体位置: target(t−τ) − Earth(t)  [ICRS, km]
  const earthSSB  = bsp.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb);
  const targetSSB = bsp.computePosition(naif,       NAIF.SSB, jdTdb - tau);
  let ax = targetSSB[0] - earthSSB[0];
  let ay = targetSSB[1] - earthSSB[1];
  let az = targetSSB[2] - earthSSB[2];

  // 3. 光偏差補正（太陽以外）
  let bx = ax, by = ay, bz = az;
  if (naif !== NAIF.SUN) {
    const sunSSB = bsp.computePosition(NAIF.SUN, NAIF.SSB, jdTdb);
    const sunX = sunSSB[0] - earthSSB[0];
    const sunY = sunSSB[1] - earthSSB[1];
    const sunZ = sunSSB[2] - earthSSB[2];
    const defl = applyLightDeflection(ax, ay, az, sunX, sunY, sunZ);
    const dist0 = Math.sqrt(ax * ax + ay * ay + az * az);
    bx = defl.x * dist0;
    by = defl.y * dist0;
    bz = defl.z * dist0;
  }

  // 4. 年周光行差（速度ベクトル法 / ICRS 空間）
  const dt = 0.5 / 86400;
  const eP = bsp.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb + dt);
  const eM = bsp.computePosition(NAIF.EARTH, NAIF.SSB, jdTdb - dt);
  const vx = (eP[0] - eM[0]) / (2 * dt);
  const vy = (eP[1] - eM[1]) / (2 * dt);
  const vz = (eP[2] - eM[2]) / (2 * dt);
  const abr = applyAberration(bx, by, bz, vx, vy, vz);

  // 5. ICRS → of-date 黄道（IAU 2006 Capitaine 歳差 + IAU 2000B 章動）
  const dist = Math.sqrt(bx * bx + by * by + bz * bz);
  return icrsToEcliptic(abr.x * dist, abr.y * dist, abr.z * dist, jdTdb).lon;
}

// ── JPL Horizons API 問い合わせ（副作用: HTTPS GET）──────────────────────

/**
 * JPL Horizons API に問い合わせて地心黄経 [°] を返す
 *
 * @param {string} hzId     Horizons COMMAND ID ('10', '301', '299', '499', '599')
 * @param {string} hzStart  START_TIME（シングルクォート付き文字列）
 * @param {string} hzStop   STOP_TIME（シングルクォート付き文字列）
 * @returns {Promise<number>} 黄経 [°]
 */
function queryHorizons(hzId, hzStart, hzStop) {
  const params = new URLSearchParams({
    format:      'text',
    COMMAND:     hzId,
    OBJ_DATA:    'NO',
    MAKE_EPHEM:  'YES',
    EPHEM_TYPE:  'OBSERVER',
    CENTER:      '500@399',
    START_TIME:  hzStart,
    STOP_TIME:   hzStop,
    STEP_SIZE:   '1m',
    QUANTITIES:  '31',
    ECLIP:       'J2000',
    CSV_FORMAT:  'NO',
  });

  // URLSearchParams はシングルクォートをエンコードするため手動で戻す
  const rawQuery = params.toString().replace(/%27/g, "'");
  const url = `https://ssd.jpl.nasa.gov/api/horizons.api?${rawQuery}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(parseHorizonsResponse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Horizons レスポンステキストから黄経 [°] を抽出する（純粋関数）
 *
 * $$SOE〜$$EOE マーカー間のデータ行を解析する。
 * 実際のフォーマット（QUANTITIES=31, ECLIP=J2000）:
 *   2000-Jan-01 12:00     280.3689092   0.0002381
 *   ↑ 日付  ↑ 時刻        ↑ ObsEcLon    ↑ ObsEcLat
 *
 * 行内の浮動小数点数を正規表現で抽出し、最初の値を黄経とする。
 * （Python 版の _parse_horizons_response と同一戦略）
 */
function parseHorizonsResponse(text) {
  const soeIdx = text.indexOf('$$SOE');
  const eoeIdx = text.indexOf('$$EOE');
  if (soeIdx === -1 || eoeIdx === -1) {
    const errMatch = text.match(/INPUT ERROR[^\n]*/i) || text.match(/API ERROR[^\n]*/i);
    throw new Error(
      `$$SOE/$$EOE マーカーが見つかりません。${errMatch ? errMatch[0] : ''}`.trim()
    );
  }

  const soeBlock = text.slice(soeIdx + 5, eoeIdx).trim();
  const lines = soeBlock.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // データ行の判定: 年4桁-月3文字-日2桁 から始まる
    if (!/^\d{4}-[A-Za-z]{3}-\d{2}/.test(line)) continue;

    // 行内の浮動小数点数をすべて抽出 → 最初の値が ObsEcLon
    const nums = line.match(/[-+]?\d+\.\d+/g);
    if (!nums || nums.length < 1) {
      throw new Error(`黄経の抽出失敗: "${line}"`);
    }
    return parseFloat(nums[0]);
  }

  throw new Error('$$SOE 内にデータ行がありません');
}

// ── 角度差・判定 ──────────────────────────────────────────────────────────

/** 角度差を [−180, +180) に正規化 */
function angularDiff(a, b) {
  return (((a - b) % 360) + 540) % 360 - 180;
}

function classify(diffDeg) {
  const abs = Math.abs(diffDeg);
  if (abs < 0.000010) return '✅ 良好';
  if (abs < 0.001)    return '⚠️  許容範囲';
  return '❌ ロジックチェック推奨';
}

// ── メイン ────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  Stella-JS 内部精度検証 — JPL Horizons 照合');
  console.log('  比較フレーム: Horizons ECLIP=J2000（実態: of-date）/ Stella-JS of-date');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log();
  console.log('  BSP 読み込み中...');

  const bsp = parseBsp(await loadBsp(BSP_ABS));

  console.log(`  BSP: ✓ 読み込み完了（de440s.bsp）`);
  console.log();

  let totalOk = 0, totalWarn = 0, totalFail = 0;

  for (const { label, jdUtc, hzStart, hzStop } of TEST_DATES) {
    const jdTdb = jdUtcToTdb(jdUtc);

    console.log(`── ${label}`);
    console.log(`   JD(UTC) = ${jdUtc.toFixed(6)}  /  JD(TDB) = ${jdTdb.toFixed(6)}`);
    console.log();
    console.log(
      `   ${'天体'.padEnd(14)} ${'Horizons [°]'.padStart(13)}  ${'Stella-JS [°]'.padStart(13)}`
      + `  ${'差 [°]'.padStart(10)}  判定`
    );
    console.log('   ' + '─'.repeat(72));

    for (const { name, naif, hzId } of TEST_PLANETS) {
      let hzLon, stellaLon, diff, verdict;
      try {
        stellaLon = calcStellaPosition(bsp, naif, jdTdb);
        hzLon     = await queryHorizons(hzId, hzStart, hzStop);
        diff      = angularDiff(stellaLon, hzLon);
        verdict   = classify(diff);

        const abs = Math.abs(diff);
        if (abs < 0.001) totalOk++;
        else if (abs < 0.01) totalWarn++;
        else totalFail++;

        console.log(
          `   ${name.padEnd(16)}`
          + ` ${hzLon.toFixed(7).padStart(13)}`
          + `  ${stellaLon.toFixed(7).padStart(13)}`
          + `  ${diff.toFixed(7).padStart(10)}`
          + `  ${verdict}`
        );
      } catch (e) {
        console.log(`   ${name.padEnd(16)}  エラー: ${e.message}`);
        totalFail++;
      }
    }
    console.log();
  }

  const totalCases = TEST_PLANETS.length * TEST_DATES.length;
  console.log('───────────────────────────────────────────────────────────────────────');
  console.log(`  集計: 良好 ${totalOk}/${totalCases}  許容 ${totalWarn}/${totalCases}  要確認 ${totalFail}/${totalCases}`);
  console.log();
  console.log('  【座標系の注記】');
  console.log('    Horizons ECLIP=J2000 は名前に反して of-date 黄道座標を返す');
  console.log('    （OBSERVER モードの quantity 31 は視方向ベースの観測量のため）。');
  console.log('    Stella-JS: of-date apparent（光偏差 + 年周光行差）で比較。');
  console.log('    Python 版 Chart(use_j2000=False) と同等のモード。');
  console.log('═══════════════════════════════════════════════════════════════════════');
}

main().catch(e => {
  console.error('\n[FATAL]', e.message);
  process.exit(1);
});
