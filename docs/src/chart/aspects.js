/**
 * aspects.js — アスペクト検出・オーブ計算モジュール
 *
 * Layer 3: chart（Layer 2 に直接依存しない純粋関数群）
 *
 * 入力は黄経（度）と黄経速度（度/日）の数値。
 *
 * ライセンス: MIT
 * アルゴリズム出典（すべて独立実装）:
 *   - アスペクト定義・オーブ値: William Lilly "Christian Astrology" (1647)、
 *     Ptolemy "Tetrabiblos"、現代占星術慣習（パブリックドメイン）
 *   - 接近・離脱判定: 角速度の差による残差微分（純粋数学）
 *   - デクスター/シニスター: 伝統占星術の方向定義（黄道上の時計/反時計回り）
 */

'use strict';

// =========================================================================
// アスペクト種別定数
// =========================================================================

export const ASPECT = Object.freeze({
  NO_ASPECT:    -1,
  CONJUNCTION:   0,
  SEMISEXTILE:  30,
  SEMISQUARE:   45,
  SEXTILE:      60,
  QUINTILE:     72,
  SQUARE:       90,
  TRINE:       120,
  SESQUISQUARE:135,
  BIQUINTILE:  144,
  QUINCUNX:    150,
  OPPOSITION:  180,
});

/** メジャーアスペクト（伝統的な5アスペクト） */
export const MAJOR_ASPECTS = [0, 60, 90, 120, 180];

/** マイナーアスペクト */
export const MINOR_ASPECTS = [30, 45, 72, 135, 144, 150];

/** 全アスペクト */
export const ALL_ASPECTS = [...MAJOR_ASPECTS, ...MINOR_ASPECTS];

// =========================================================================
// 惑星オーブテーブル
//
// 出典: William Lilly "Christian Astrology" (1647) および
//       現代占星術の慣習的標準値（パブリックドメイン）
// 太陽・月はより広い影響圏（moiety / orb of body）を持つとされる。
// =========================================================================

/** 惑星 ID 定数 */
export const PLANET = Object.freeze({
  SUN:     'Sun',
  MOON:    'Moon',
  MERCURY: 'Mercury',
  VENUS:   'Venus',
  MARS:    'Mars',
  JUPITER: 'Jupiter',
  SATURN:  'Saturn',
  URANUS:  'Uranus',
  NEPTUNE: 'Neptune',
  PLUTO:   'Pluto',
  CHIRON:  'Chiron',
  NORTH_NODE: 'North Node',
  SOUTH_NODE: 'South Node',
  EARTH:   'Earth',
});

/**
 * 惑星ごとのオーブ（度）
 *
 * 伝統的占星術では各天体が固有の「影響圏（orb of body）」を持ち、
 * 2 天体のどちらかのオーブ内でアスペクトが有効とみなす。
 * 太陽: 15°、月: 12° は Lilly をはじめ多くの伝統的権威が示す値。
 * 外惑星（天王星・海王星・冥王星）は現代占星術の標準値を採用。
 */
export const PLANET_ORBS = Object.freeze({
  [PLANET.SUN]:        15,
  [PLANET.MOON]:       12,
  [PLANET.MERCURY]:     7,
  [PLANET.VENUS]:       7,
  [PLANET.MARS]:        8,
  [PLANET.JUPITER]:     9,
  [PLANET.SATURN]:      9,
  [PLANET.URANUS]:      5,
  [PLANET.NEPTUNE]:     5,
  [PLANET.PLUTO]:       5,
  [PLANET.CHIRON]:      5,
  [PLANET.NORTH_NODE]: 12,
  [PLANET.SOUTH_NODE]: 12,
  [PLANET.EARTH]:       8,
});

/** 登録外惑星のデフォルトオーブ */
const DEFAULT_ORB = 5;

/** マイナーアスペクトの最大許容オーブ（現代占星術慣習） */
const MAX_MINOR_ORB = 3;

/**
 * 正確なアスペクトの閾値（度）
 * 残差がこれ未満の場合を "exact" とみなす。
 */
const EXACT_THRESHOLD = 0.3;

// =========================================================================
// アスペクト名・記号（パブリックドメイン）
// =========================================================================

/** アスペクト名（英語） */
export const ASPECT_NAMES_EN = Object.freeze({
  [ASPECT.CONJUNCTION]:   'Conjunction',
  [ASPECT.SEMISEXTILE]:   'Semisextile',
  [ASPECT.SEMISQUARE]:    'Semisquare',
  [ASPECT.SEXTILE]:       'Sextile',
  [ASPECT.QUINTILE]:      'Quintile',
  [ASPECT.SQUARE]:        'Square',
  [ASPECT.TRINE]:         'Trine',
  [ASPECT.SESQUISQUARE]:  'Sesquisquare',
  [ASPECT.BIQUINTILE]:    'Biquintile',
  [ASPECT.QUINCUNX]:      'Quincunx',
  [ASPECT.OPPOSITION]:    'Opposition',
});

/** アスペクト名（日本語） */
export const ASPECT_NAMES_JP = Object.freeze({
  [ASPECT.CONJUNCTION]:   '合（コンジャンクション）',
  [ASPECT.SEMISEXTILE]:   'セミセクスタイル',
  [ASPECT.SEMISQUARE]:    'セミスクエア',
  [ASPECT.SEXTILE]:       '六分（セクスタイル）',
  [ASPECT.QUINTILE]:      'クインタイル',
  [ASPECT.SQUARE]:        '四分（スクエア）',
  [ASPECT.TRINE]:         '三分（トライン）',
  [ASPECT.SESQUISQUARE]:  'セスキスクエア',
  [ASPECT.BIQUINTILE]:    'バイクインタイル',
  [ASPECT.QUINCUNX]:      'クインカンクス',
  [ASPECT.OPPOSITION]:    '衝（オポジション）',
});

/** アスペクト記号（Unicode 天文記号・パブリックドメイン） */
export const ASPECT_SYMBOLS = Object.freeze({
  [ASPECT.CONJUNCTION]:   '☌',
  [ASPECT.SEMISEXTILE]:   '⚺',
  [ASPECT.SEMISQUARE]:    '∠',
  [ASPECT.SEXTILE]:       '⚹',
  [ASPECT.QUINTILE]:      'Q',
  [ASPECT.SQUARE]:        '□',
  [ASPECT.TRINE]:         '△',
  [ASPECT.SESQUISQUARE]:  '⚼',
  [ASPECT.BIQUINTILE]:    'bQ',
  [ASPECT.QUINCUNX]:      '⚻',
  [ASPECT.OPPOSITION]:    '☍',
});

// =========================================================================
// 角度ユーティリティ
// =========================================================================

/**
 * 2 つの黄経の最短角度差を返す（符号付き、-180° 〜 +180°）
 *
 * 定義: lon1 から lon2 への最短回転量（正 = 反時計回り = 黄道順方向）
 *
 * @param {number} lon1 黄経1（度）
 * @param {number} lon2 黄経2（度）
 * @returns {number} 最短角度差（度, -180 〜 +180）
 */
export function closestAngularDist(lon1, lon2) {
  let d = ((lon2 - lon1) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * 惑星 ID に対応するオーブを返す
 *
 * @param {string} id 惑星 ID
 * @returns {number} オーブ（度）
 */
export function getPlanetOrb(id) {
  return PLANET_ORBS[id] ?? DEFAULT_ORB;
}

// =========================================================================
// アスペクト判定（コア）
// =========================================================================

/**
 * 2 天体が指定アスペクトリスト内のいずれかに収まっているかを判定し、
 * 最も近いアスペクトの種別・オーブ・分離角を返す（内部用）
 *
 * アルゴリズム:
 *   1. closestAngularDist(lon1, lon2) で符号付き最短分離角 sep を求める
 *   2. |sep| と各アスペクト角度 a の差 = orb を計算
 *   3. orb が最小のものを候補とする
 *
 * @param {number} lon1
 * @param {number} lon2
 * @param {number[]} aspList
 * @returns {{ type: number, orb: number, separation: number } | null}
 */
function findNearestAspect(lon1, lon2, aspList) {
  const sep    = closestAngularDist(lon1, lon2);
  const absSep = Math.abs(sep);

  let best = null;
  for (const a of aspList) {
    const orb = Math.abs(absSep - a);
    if (best === null || orb < best.orb) {
      best = { type: a, orb, separation: sep };
    }
  }
  return best;
}

/**
 * オーブ条件を適用してアスペクトが有効かを判定する（内部用）
 *
 * オーブ適用ルール（伝統的占星術の慣習）:
 *   - メジャーアスペクト: 2 天体のどちらか一方のオーブ内であれば有効
 *   - マイナーアスペクト: MAX_MINOR_ORB (3°) 以内であれば有効
 *
 * @param {{ id: string, lon: number }} body1
 * @param {{ id: string, lon: number }} body2
 * @param {number[]} aspList
 * @returns {{ type: number, orb: number, separation: number } | null}
 */
function checkAspectInOrb(body1, body2, aspList) {
  const found = findNearestAspect(body1.lon, body2.lon, aspList);
  if (!found) return null;

  const { type, orb } = found;

  if (MAJOR_ASPECTS.includes(type)) {
    const orb1 = getPlanetOrb(body1.id);
    const orb2 = getPlanetOrb(body2.id);
    if (orb > orb1 && orb > orb2) return null;
  } else {
    if (orb > MAX_MINOR_ORB) return null;
  }

  return found;
}

// =========================================================================
// アスペクト分析（公開 API）
// =========================================================================

/**
 * 2 天体間のアスペクトを分析し、すべてのプロパティを返す（純粋関数）
 *
 * ── 接近・離脱の導出 ──────────────────────────────────────────
 * 速い天体（active）の黄経 La、遅い天体（passive）の黄経 Lp とする。
 * 符号付き分離角: sep = closestDist(La, Lp)
 *
 * アスペクト角 a に対する残差（exact からのずれ）:
 *   sep ≥ 0 → residual = sep − a
 *   sep < 0 → residual = sep + a
 *
 * 残差の時間微分 ≈ active.lonspeed − passive.lonspeed（速度差）
 * residual と rate が逆符号 → residual が減少中 → 接近（applying）
 * 同符号 → 離脱（separating）
 *
 * ── デクスター/シニスターの定義 ────────────────────────────────
 * 伝統占星術では passive から active を見た方向で決まる。
 *   sep ≤ 0: active は passive より時計回り側（黄道逆順） → dexter（右）
 *   sep > 0: active は passive より反時計回り側（黄道順） → sinister（左）
 *
 * @param {{ id: string, lon: number, lonspeed: number }} obj1
 * @param {{ id: string, lon: number, lonspeed: number }} obj2
 * @param {number[]} [aspList=MAJOR_ASPECTS]
 * @returns {{
 *   exists:     boolean,
 *   type:       number,
 *   orb:        number,
 *   separation: number,
 *   direction:  'dexter' | 'sinister' | null,
 *   applying:   boolean | null,
 *   exact:      boolean,
 *   movement:   'applying' | 'separating' | 'exact' | 'stationary' | 'none',
 *   active:     { id: string, inOrb: boolean, movement: string },
 *   passive:    { id: string, inOrb: boolean, movement: string },
 * }}
 */
export function analyzeAspect(obj1, obj2, aspList = MAJOR_ASPECTS) {
  // 速い方を active（主動）、遅い方を passive（受動）とする
  const speed1  = Math.abs(obj1.lonspeed ?? 0);
  const speed2  = Math.abs(obj2.lonspeed ?? 0);
  const active  = speed1 >= speed2 ? obj1 : obj2;
  const passive = speed1 >= speed2 ? obj2 : obj1;

  const found = checkAspectInOrb(active, passive, aspList);

  if (!found) {
    return {
      exists: false, type: ASPECT.NO_ASPECT, orb: 0,
      separation: closestAngularDist(obj1.lon, obj2.lon),
      direction: null, applying: null, exact: false,
      movement: 'none',
      active:  { id: active.id,  inOrb: false, movement: 'none' },
      passive: { id: passive.id, inOrb: false, movement: 'none' },
    };
  }

  const { type, orb, separation: sep } = found;
  const orbActive  = getPlanetOrb(active.id);
  const orbPassive = getPlanetOrb(passive.id);

  // デクスター: active が passive より時計回り側（sep ≤ 0）
  const direction = sep <= 0 ? 'dexter' : 'sinister';

  // 残差（exact からのずれ）を計算
  // sep ≥ 0: active は passive より先（黄道順）にいる → residual = sep − type
  // sep < 0: active は passive より後（黄道逆）にいる → residual = sep + type
  const residual = sep >= 0 ? sep - type : sep + type;

  // 正確なアスペクト判定
  const exact = Math.abs(residual) < EXACT_THRESHOLD;

  // 接近・離脱判定
  // sep = closestDist(active.lon, passive.lon) と定義したので:
  //   d(sep)/dt ≈ d(passive.lon)/dt − d(active.lon)/dt = passiveSpeed − activeSpeed
  // residual と rate が逆符号 → residual が 0 に近づいている → 接近（applying）
  const activeSpeed  = active.lonspeed  ?? 0;
  const passiveSpeed = passive.lonspeed ?? 0;
  const rate         = passiveSpeed - activeSpeed;  // d(sep)/dt の近似

  let movement;
  if (exact) {
    movement = 'exact';
  } else if (Math.abs(activeSpeed) < 0.001) {
    movement = 'stationary';
  } else if (residual * rate < 0) {
    // rate が residual を小さくしている → 接近
    movement = 'applying';
  } else {
    movement = 'separating';
  }

  return {
    exists: true,
    type,
    orb,
    separation: sep,
    direction,
    applying:  movement === 'applying' || movement === 'exact',
    exact,
    movement,
    active:  { id: active.id,  inOrb: orb <= orbActive,  movement },
    passive: { id: passive.id, inOrb: orb <= orbPassive, movement: 'none' },
  };
}

/**
 * 惑星リスト内のすべての組み合わせのアスペクトを一括計算する（純粋関数）
 *
 * @param {Array<{ id: string, lon: number, lonspeed: number }>} planets
 * @param {number[]} [aspList=MAJOR_ASPECTS]
 * @returns {Array<{ planet1: string, planet2: string } & ReturnType<analyzeAspect>>}
 *   オーブの小さい順にソートしたアスペクト配列
 */
export function getAllAspects(planets, aspList = MAJOR_ASPECTS) {
  const results = [];

  for (let i = 0; i < planets.length; i++) {
    for (let j = i + 1; j < planets.length; j++) {
      const asp = analyzeAspect(planets[i], planets[j], aspList);
      if (asp.exists) {
        results.push({
          planet1: planets[i].id,
          planet2: planets[j].id,
          ...asp,
        });
      }
    }
  }

  results.sort((a, b) => a.orb - b.orb);
  return results;
}

/**
 * アスペクト統計を集計する（純粋関数）
 *
 * @param {ReturnType<getAllAspects>} aspects
 * @returns {{
 *   total:           number,
 *   byType:          Record<number, number>,
 *   exactCount:      number,
 *   applyingCount:   number,
 *   separatingCount: number,
 *   averageOrb:      number,
 *   tightest:        object | null,
 * }}
 */
export function getAspectStats(aspects) {
  if (aspects.length === 0) {
    return { total: 0, byType: {}, exactCount: 0,
             applyingCount: 0, separatingCount: 0,
             averageOrb: 0, tightest: null };
  }

  const byType = {};
  let exactCount = 0, applyingCount = 0, separatingCount = 0;

  for (const asp of aspects) {
    byType[asp.type] = (byType[asp.type] ?? 0) + 1;
    if (asp.exact)                        exactCount++;
    else if (asp.movement === 'applying') applyingCount++;
    else                                  separatingCount++;
  }

  return {
    total:           aspects.length,
    byType,
    exactCount,
    applyingCount,
    separatingCount,
    averageOrb:      aspects.reduce((s, a) => s + a.orb, 0) / aspects.length,
    tightest:        aspects[0],  // すでにオーブ昇順ソート済み
  };
}
