/**
 * src/chart/lunar-calendar.js
 *
 * 農暦（旧暦）変換ライブラリ — 純粋関数層
 *
 * Python版 spacefield/calendar/lunar_calendar.py をポートし、
 * Skyfield 依存を廃して computeApparent (BSP) ベースの実装に置換。
 *
 * アルゴリズム（置閏法 / 中国農暦）:
 *   1. 入力 JD を含む「冬至サイクル」を決定
 *      冬至サイクル = ある年の冬至から翌年の冬至まで
 *   2. サイクル内の朔（新月）を列挙
 *      月11の開始朔 = 冬至直前の朔
 *   3. 各月に「中気」（太陽黄経が 30° の倍数）が入るか判定
 *   4. 月番号を割り当て
 *      月11（冬至月）= 11月（強制）
 *      以降: 中気あり → 次の月番号 / 中気なし（初出）→ 閏月
 *   5. 入力日が何月何日かを求める
 *
 * ⚠️ 境界注意: 中気と朔が数時間以内に重なる稀なケース（例: 2020年閏四月）では
 *    中国国家標準の計算と数分〜数時間ずれることがあり、
 *    閏月の判定が公式カレンダーと1ヶ月ずれる可能性がある。
 *
 * @module chart/lunar-calendar
 */

// 中気の太陽黄経リスト（30° の倍数 / 偶数節気）
const ZHONGQI_LONS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

const STEP_DAYS_NEW_MOON = 0.5;  // 朔スキャンのステップ（日）
const STEP_DAYS_ZHONGQI  = 5.0;  // 中気スキャンのステップ（日）

// =========================================================================
// 朔（新月）検索
// =========================================================================

/**
 * 指定 JD 範囲内の朔（新月）を検索する
 *
 * 月-太陽の黄経差（elongation）が ±180→0 に向けてゼロ交差する点を
 * 0.5日刻みでスキャンし、二分探索で精密化する。
 *
 * @param {function(jd: number): { lon: number }} sunCalcFn  太陽黄経を返す関数（TDB JD）
 * @param {function(jd: number): { lon: number }} moonCalcFn 月黄経を返す関数（TDB JD）
 * @param {number} startJD 検索開始 JD (TDB)
 * @param {number} endJD   検索終了 JD (TDB)
 * @param {object} [opts]
 * @param {number} [opts.precisionHours=0.01] 二分探索の精度（時間）
 * @returns {number[]} 朔の JD (TDB) のリスト（昇順）
 */
export function findNewMoonsInRange(sunCalcFn, moonCalcFn, startJD, endJD, opts = {}) {
  const precisionJD = (opts.precisionHours ?? 0.01) / 24.0;
  const result = [];

  /** 月-太陽の黄経差を (-180, 180] に正規化して返す */
  function elongation(jd) {
    let diff = moonCalcFn(jd).lon - sunCalcFn(jd).lon;
    diff = ((diff % 360) + 360) % 360;
    if (diff > 180) diff -= 360;
    return diff;
  }

  let jd   = startJD;
  let curr = elongation(jd);

  while (jd + STEP_DAYS_NEW_MOON <= endJD) {
    const nextJd = jd + STEP_DAYS_NEW_MOON;
    const next   = elongation(nextJd);

    // elongation が 0 をまたぐ（正←→負）= 朔の通過
    const crossesZero = (curr > 0 && next <= 0) || (curr < 0 && next >= 0);

    if (crossesZero) {
      let lo = jd, hi = nextJd;
      let loE = curr;

      while (hi - lo > precisionJD) {
        const mid  = (lo + hi) / 2;
        const midE = elongation(mid);
        // lo と mid が elongation の同じ側にあれば lo を前進
        if ((loE <= 0) === (midE <= 0)) { lo = mid; loE = midE; }
        else { hi = mid; }
      }

      result.push((lo + hi) / 2);
    }

    jd   = nextJd;
    curr = next;
  }

  return result;
}

// =========================================================================
// 中気検索
// =========================================================================

/**
 * 指定 JD 範囲内の中気（太陽黄経が 30° の倍数になる時刻）を検索する
 *
 * 太陽は ~1°/日 で順行するため、5日刻みスキャン後に二分探索で精密化する。
 *
 * @param {function(jd: number): { lon: number }} sunCalcFn  太陽黄経を返す関数（TDB JD）
 * @param {number} startJD 検索開始 JD (TDB)
 * @param {number} endJD   検索終了 JD (TDB)
 * @param {object} [opts]
 * @param {number} [opts.precisionHours=0.01] 二分探索の精度（時間）
 * @returns {{ jd: number, lon: number }[]} 中気リスト（JD昇順）
 */
export function findZhongqiInRange(sunCalcFn, startJD, endJD, opts = {}) {
  const precisionJD = (opts.precisionHours ?? 0.01) / 24.0;
  const result = [];

  let jd   = startJD;
  let curr = sunCalcFn(jd).lon;

  while (jd + STEP_DAYS_ZHONGQI <= endJD) {
    const nextJd = jd + STEP_DAYS_ZHONGQI;
    const next   = sunCalcFn(nextJd).lon;

    // このステップで通過した中気の経度リストを取得
    const targets = _zhongqiBetween(curr, next);

    for (const targetLon of targets) {
      let lo  = jd;
      let hi  = nextJd;
      // (targetLon - lon) を (-180, 180] に正規化: 正 = まだ到達していない
      let loE = _lonDiff(curr, targetLon);

      while (hi - lo > precisionJD) {
        const mid    = (lo + hi) / 2;
        const midLon = sunCalcFn(mid).lon;
        const midE   = _lonDiff(midLon, targetLon);
        // まだ到達していない側に lo を移動、超えた側に hi を移動
        if (midE > 0) { lo = mid; loE = midE; }
        else          { hi = mid; }
      }

      result.push({ jd: (lo + hi) / 2, lon: targetLon });
    }

    jd   = nextJd;
    curr = next;
  }

  result.sort((a, b) => a.jd - b.jd);
  return result;
}

/**
 * 冬至（太陽黄経 270°）を指定範囲内で検索する
 *
 * @param {function(jd: number): { lon: number }} sunCalcFn
 * @param {number} startJD  検索開始 JD (TDB) ※ 例: その年の 11/01
 * @param {number} endJD    検索終了 JD (TDB) ※ 例: その年の 01/15 (翌年)
 * @returns {number | null} 冬至の JD (TDB)（見つからない場合 null）
 */
export function findDongzhi(sunCalcFn, startJD, endJD) {
  const events = findZhongqiInRange(sunCalcFn, startJD, endJD);
  const dz = events.find(ev => ev.lon === 270);
  return dz ? dz.jd : null;
}

// =========================================================================
// 農暦月構築
// =========================================================================

/**
 * サイクル内の朔リストと中気リストから各月の情報を構築する
 * （Python版 build_lunar_months の移植）
 *
 * @param {number[]} cycleMoons
 *   月11の開始朔〜次サイクル月11の開始朔（len = 月数 + 1）。
 *   最後の要素は境界として使用（次サイクルの月11朔）。
 * @param {{ jd: number, lon: number }[]} zhongqiEvents  中気リスト
 * @returns {{
 *   start: number, end: number,
 *   zhongqi: number|null, zhongqiLon: number|null
 * }[]}
 */
export function buildLunarMonths(cycleMoons, zhongqiEvents) {
  const n = cycleMoons.length - 1;
  const months = [];

  for (let i = 0; i < n; i++) {
    const start = cycleMoons[i];
    const end   = cycleMoons[i + 1];

    // この月に入る最初の中気を探す（区間 [start, end)）
    let zhongqi    = null;
    let zhongqiLon = null;
    for (const ev of zhongqiEvents) {
      if (ev.jd >= start && ev.jd < end) {
        zhongqi    = ev.jd;
        zhongqiLon = ev.lon;
        break;
      }
    }

    months.push({ start, end, zhongqi, zhongqiLon });
  }

  return months;
}

/**
 * 月番号を割り当てる（Python版 assign_month_numbers の移植）
 *
 * ルール:
 *   - months[0] = 11月（冬至月、中気なしでも強制）
 *   - 以降: 中気あり → 次の月番号 (12, 1, 2, ...) / 中気なし（初出）→ 閏月
 *
 * @param {{ start, end, zhongqi, zhongqiLon }[]} months
 * @returns {{ ..., monthNum: number, isLeap: boolean }[]}
 */
export function assignMonthNumbers(months) {
  const result  = months.map(m => ({ ...m }));
  const n       = result.length;
  const hasLeap = (n === 13);

  result[0].monthNum = 11;
  result[0].isLeap   = false;

  let current  = 11;
  let leapUsed = false;

  for (let i = 1; i < n; i++) {
    if (hasLeap && !leapUsed && result[i].zhongqi === null) {
      // 中気なし（初出）→ 閏月（前の月番号を引き継ぐ）
      result[i].monthNum = current;
      result[i].isLeap   = true;
      leapUsed = true;
    } else {
      current = current % 12 + 1;
      result[i].monthNum = current;
      result[i].isLeap   = false;
    }
  }

  return result;
}

// =========================================================================
// メイン変換関数
// =========================================================================

/**
 * TDB JD から農暦（旧暦）の月・日を算出する
 * （Python版 get_lunar_date の移植）
 *
 * @param {function(jd: number): { lon: number }} sunCalcFn  太陽黄経（TDB JD → {lon}）
 * @param {function(jd: number): { lon: number }} moonCalcFn 月黄経（TDB JD → {lon}）
 * @param {number} jdTdb 変換したい日時の TDB JD
 * @returns {{
 *   lunarMonth:  number,   // 1〜12
 *   lunarDay:    number,   // 1〜30
 *   isLeap:      boolean,  // 閏月か
 *   cycleMonths: number,   // サイクル内の月数（12 or 13）
 *   dongzhiJd:   number,   // サイクル開始の冬至 JD
 *   newMoonJd:   number,   // 出生月の朔 JD
 * } | null}  null = 範囲外や計算失敗
 */
export function getLunarDate(sunCalcFn, moonCalcFn, jdTdb) {
  // JD → 概算グレゴリオ年（J2000.0 = JD 2451545.0 = 2000年）
  const approxYear = 2000 + (jdTdb - 2451545.0) / 365.25;
  const year = Math.floor(approxYear);

  // 前後2年分の冬至を取得
  const dzThis = _findDongzhiForYear(sunCalcFn, year);
  const dzPrev = _findDongzhiForYear(sunCalcFn, year - 1);
  const dzNext = _findDongzhiForYear(sunCalcFn, year + 1);

  if (!dzThis || !dzPrev || !dzNext) return null;

  // 入力 JD が含まれる冬至サイクルを決定
  let dzStart, dzEnd;
  if (jdTdb >= dzThis) {
    dzStart = dzThis;
    dzEnd   = dzNext;
  } else {
    dzStart = dzPrev;
    dzEnd   = dzThis;
  }

  // サイクル前後 35 日の範囲で朔と中気を一括取得
  const searchStart = dzStart - 35;
  const searchEnd   = dzEnd   + 35;

  const newMoonsAll  = findNewMoonsInRange(sunCalcFn, moonCalcFn, searchStart, searchEnd);
  const zhongqiAll   = findZhongqiInRange(sunCalcFn, searchStart, searchEnd);

  // 月11の開始朔 = 冬至直前の朔
  const month11Start     = _prevNewMoon(dzStart, newMoonsAll);
  const nextMonth11Start = _prevNewMoon(dzEnd,   newMoonsAll);

  if (month11Start === null || nextMonth11Start === null) return null;

  // サイクル内の朔リスト（境界を末尾に追加）
  const cycleMoons = newMoonsAll.filter(nm => nm >= month11Start && nm < nextMonth11Start);
  cycleMoons.push(nextMonth11Start);

  if (cycleMoons.length < 13) return null;  // 12ヶ月未満は範囲不足

  // 月情報構築 → 月番号割り当て
  const months   = buildLunarMonths(cycleMoons, zhongqiAll);
  const assigned = assignMonthNumbers(months);

  // 入力 JD が含まれる月を特定（CST 暦日ベースで判定）
  // 農暦の月境界（朔）は CST（北京時間 = UTC+8）の暦日で判定する。
  // 朔が UTC 深夜付近に発生する場合、UTC 基準と CST 基準で暦日が1日ズレる。
  const birthCstDay = _jdToCstDayNum(jdTdb);
  const birthEntry = assigned.find(e =>
    _jdToCstDayNum(e.start) <= birthCstDay && birthCstDay < _jdToCstDayNum(e.end)
  );
  if (!birthEntry) return null;

  // 農暦日も CST 暦日ベースで計算
  const newMoonCstDay = _jdToCstDayNum(birthEntry.start);
  const lunarDay = birthCstDay - newMoonCstDay + 1;

  return {
    lunarMonth:    birthEntry.monthNum,
    lunarDay:      Math.max(1, Math.min(30, lunarDay)),
    isLeap:        birthEntry.isLeap,
    cycleMonths:   cycleMoons.length - 1,
    dongzhiJd:     dzStart,
    newMoonJd:     birthEntry.start,
    calendarBasis: 'CST (UTC+8)',  // 農暦日付境界の基準時刻
  };
}

// =========================================================================
// 内部ヘルパー
// =========================================================================

/** 農暦計算における CST オフセット（日単位） */
const CST_OFFSET_JD = 8 / 24;  // 中国標準時 = UTC+8

/**
 * TDB JD → CST 暦日番号（農暦日付境界判定用 純粋関数）
 *
 * 農暦の月・日の境界は中国標準時（CST = UTC+8）の深夜0時で判定する。
 * 朔が UTC 深夜付近に発生する場合、UTC 基準と CST 基準で暦日が1日ズレる。
 *
 * JD 規約: 整数 JD は正午(UTC 12:00)に対応するため +0.5 で深夜基準に補正し、
 * さらに CST オフセット (+8/24) を加えて CST 深夜基準の日番号を取得する。
 *
 * @param {number} jd TDB Julian Day
 * @returns {number} CST 暦日番号（整数 JDN 相当）
 */
function _jdToCstDayNum(jd) {
  return Math.floor(jd + CST_OFFSET_JD + 0.5);
}

/**
 * 指定年の冬至 JD を求める（11/01〜翌年 01/20 の範囲を検索）
 * 近年の冬至は必ず 12/21〜12/22 頃だが、古代・近未来のマージンを考慮し
 * 11/01〜翌年 01/20 と広く検索する。
 */
function _findDongzhiForYear(sunCalcFn, year) {
  const startJD = _approxJd(year, 11, 1);
  const endJD   = _approxJd(year + 1, 1, 20);
  return findDongzhi(sunCalcFn, startJD, endJD);
}

/**
 * グレゴリオ暦（プロレプティック）での近似 JD を返す
 * Meeus "Astronomical Algorithms" 式（農暦変換の内部用途のみ、精度 ±1日以内）
 */
function _approxJd(year, month, day) {
  let y = year, m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + B - 1524.5;
}

/**
 * target 以前の最後の朔 JD を返す（見つからない場合 null）
 * newMoons は昇順であることが前提
 */
function _prevNewMoon(targetJD, newMoons) {
  let prev = null;
  for (const nm of newMoons) {
    if (nm <= targetJD) prev = nm;
    else break;
  }
  return prev;
}

/**
 * 太陽が lon1 から lon2 へ移動する間に通過した中気の経度リストを返す（順行専用）
 * 0°/360° ラップアラウンドを考慮する。
 */
function _zhongqiBetween(lon1, lon2) {
  const result = [];
  const a = ((lon1 % 360) + 360) % 360;
  let   b = ((lon2 % 360) + 360) % 360;
  if (b <= a) b += 360;  // ラップアラウンド補正

  for (const t of ZHONGQI_LONS) {
    const t_adj = t < a ? t + 360 : t;
    if (t_adj > a && t_adj <= b) result.push(t);
  }
  return result;
}

/**
 * (targetLon - lon) を (-180, 180] に正規化する
 * 正値 = 太陽がまだ targetLon に到達していない
 * 負値 = 太陽が targetLon を通過した
 */
function _lonDiff(lon, targetLon) {
  let d = targetLon - lon;
  d = ((d % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}
