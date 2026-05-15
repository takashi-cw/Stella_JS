/**
 * ui-eastern.js — 東洋占術計算メニュー UI ハンドラ群
 *
 * 担当セクション（元 app.js L2874–L3981 相当）:
 *   - 四柱推命 命式計算
 *   - 紫微斗数 命盤計算
 *   - 月のボイドタイム計算
 *
 * 使用方法:
 *   import { init } from './ui-eastern.js';
 *   init({ computeApparent, requireBsp, settings });
 */

import {
  NAIF, jdUtcToTdb, jdToDate, dateToJd, getLunarDate,
} from './index.js';

import {
  dateStrToJdUtcMidJst, jdToJstStr,
  showResult, showLoading, yieldFrame,
  ZODIAC_SIGNS_JP,
} from './ui-helpers.js';

// ── モジュールレベルの依存 ────────────────────────────────────────────────
let _computeApparent;
let _requireBsp;

/**
 * モジュールの初期化 — イベントハンドラを登録する
 */
export function init(deps) {
  _computeApparent = deps.computeApparent;
  _requireBsp      = deps.requireBsp;
  _registerHandlers();
}

// ── 干支定数 ──────────────────────────────────────────────────────────────

const STEMS    = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const BRANCHES = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
const SEXAGENARY = Array.from({ length: 60 }, (_, i) => `${STEMS[i % 10]}${BRANCHES[i % 12]}`);

const MONTH_STEM_START = [2, 4, 6, 8, 0];

const SHICHU_NODE_LON = Object.freeze({
  315: 1, 345: 2, 15: 3, 45: 4, 75: 5, 105: 6,
  135: 7, 165: 8, 195: 9, 225: 10, 255: 11, 285: 12,
});

const MONTH_BRANCH_IDX = { 1:2, 2:3, 3:4, 4:5, 5:6, 6:7, 7:8, 8:9, 9:10, 10:11, 11:0, 12:1 };
const HOUR_STEM_START  = [0, 2, 4, 6, 8];
const JDN_JIAZI        = 2415079;

// ── 四柱推命 純粋関数ライブラリ ───────────────────────────────────────────

const STEM_ELEMENT        = [0,0,1,1,2,2,3,3,4,4];
const BRANCH_WUXING_NAMES = ['水','土','木','木','土','火','火','土','金','金','土','水'];
const STEM_YIN_YANG       = ['陽','陰','陽','陰','陽','陰','陽','陰','陽','陰'];
const WUXING_NAMES        = ['木','火','土','金','水'];
const GENERATES           = [1,2,3,4,0];
const CONTROLS            = [2,3,4,0,1];

const KANSHIN_TABLE = {
   0: ['壬', '',   ''  ],
   1: ['己', '癸', '辛'],
   2: ['甲', '丙', '戊'],
   3: ['乙', '',   ''  ],
   4: ['戊', '乙', '癸'],
   5: ['丙', '庚', '戊'],
   6: ['丁', '己', ''  ],
   7: ['己', '丁', '乙'],
   8: ['庚', '壬', '戊'],
   9: ['辛', '',   ''  ],
  10: ['戊', '辛', '丁'],
  11: ['壬', '甲', ''  ],
};

function getKanshin(branchIdx) {
  return KANSHIN_TABLE[branchIdx].filter(s => s);
}

const JUUSHIN_TABLE = {
  '0_true':'比肩','0_false':'劫財',
  '1_true':'食神','1_false':'傷官',
  '2_true':'偏財','2_false':'正財',
  '3_true':'偏官','3_false':'正官',
  '4_true':'偏印','4_false':'印綬',
};

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

const KUBO_TABLE = [[10,11],[8,9],[6,7],[4,5],[2,3],[0,1]];
const JUN_NAMES  = ['甲子旬','甲戌旬','甲申旬','甲午旬','甲辰旬','甲寅旬'];

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

const JUUNISEI_NAMES = ['長生','沐浴','冠帯','臨官','帝旺','衰','病','死','墓','絶','胎','養'];
const JS_START       = [[11,true],[6,false],[2,true],[9,false],[2,true],[9,false],
                        [5,true],[0,false],[8,true],[3,false]];

function getJuunisei(stemIdx, branchIdx) {
  const [start, forward] = JS_START[stemIdx];
  const stage = forward
    ? ((branchIdx - start) + 12) % 12
    : ((start - branchIdx) + 12) % 12;
  return JUUNISEI_NAMES[stage];
}

function getNichinushiScore(yearStemI, monthStemI, monthBranI, dayStemI,
                             yearBranI, dayBranI, hourStemI, hourBranI) {
  const dm    = STEM_ELEMENT[dayStemI];
  const lines = [];

  const honkiStr = KANSHIN_TABLE[monthBranI][0];
  let gekkoPts;
  if (honkiStr) {
    const hElem = STEM_ELEMENT[STEMS.indexOf(honkiStr)];
    let rel;
    if      (hElem === dm)           rel = 0;
    else if (GENERATES[hElem] === dm) rel = 4;
    else if (GENERATES[dm] === hElem) rel = 1;
    else if (CONTROLS[dm]  === hElem) rel = 2;
    else                              rel = 3;
    const scoreMap = {0:30,4:20,1:-10,2:-15,3:-30};
    const relName  = {0:'旺',4:'相',1:'休',2:'囚',3:'死'};
    gekkoPts = scoreMap[rel];
    lines.push(`月令: ${BRANCHES[monthBranI]}月 → ${relName[rel]} (${gekkoPts > 0 ? '+' : ''}${gekkoPts})`);
  } else {
    gekkoPts = -10;
    lines.push(`月令: ${BRANCHES[monthBranI]}月 → 休 (-10)`);
  }

  const tsukkonPts = {honki: 5, chuki: 3, yoki: 1};
  let tsukkon = 0;
  for (const [br] of [[yearBranI],[monthBranI],[dayBranI],[hourBranI]]) {
    const row = KANSHIN_TABLE[br];
    for (const [ki, hs] of [['honki',row[0]],['chuki',row[1]],['yoki',row[2]]]) {
      if (hs && STEM_ELEMENT[STEMS.indexOf(hs)] === dm) {
        tsukkon += tsukkonPts[ki];
        lines.push(`  通根(${ki}): ${BRANCHES[br]}(${hs}) +${tsukkonPts[ki]}`);
      }
    }
  }

  let stemPts = 0;
  for (const [si] of [[yearStemI],[monthStemI],[hourStemI]]) {
    const sElem = STEM_ELEMENT[si];
    if      (sElem === dm)           { stemPts += 5; lines.push(`  天干比劫: ${STEMS[si]} +5`); }
    else if (GENERATES[sElem] === dm){ stemPts += 3; lines.push(`  天干印: ${STEMS[si]} +3`); }
  }

  const total = gekkoPts + tsukkon + stemPts;
  const judgment = total >= 20 ? '身強' : total >= 0 ? '中和' : '身弱';

  return { total, gekkoPts, tsukkon, stemPts, judgment, lines };
}

const KAN_GO_TABLE = {
  '0_5':['甲己合','土'], '1_6':['乙庚合','金'], '2_7':['丙辛合','水'],
  '3_8':['丁壬合','木'], '4_9':['戊癸合','火'],
};
const KA_KI_BRANCHES = {
  木:[2,3,4], 火:[5,6,7], 土:[2,5,8,11], 金:[8,9,10], 水:[11,0,1],
};

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
const JIKEI_SET  = new Set([4,6,9,11]);
const JIKEI_NAMES = {4:'辰自刑',6:'午自刑',9:'酉自刑',11:'亥自刑'};

function getBranchInteractions(branches) {
  const labels = ['年支','月支','日支','時支'];
  const bl = branches.map((b,i) => `${labels[i]}(${BRANCHES[b]})`);
  const results = [];
  const n = branches.length;

  for (let i=0;i<n;i++) for(let j=i+1;j<n;j++) {
    const k = `${Math.min(branches[i],branches[j])}_${Math.max(branches[i],branches[j])}`;
    if (ROKU_GO_TABLE[k]) {
      const [nm,el] = ROKU_GO_TABLE[k];
      results.push(`六合: ${nm}（${el}）  [${bl[i]} + ${bl[j]}]`);
    }
  }
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let k=j+1;k<n;k++){
    const key = [branches[i],branches[j],branches[k]].sort((a,b)=>a-b).join('_');
    if(SAN_GO_TABLE[key]){
      const[nm,el]=SAN_GO_TABLE[key];
      results.push(`三合局: ${nm}（${el}）  [${bl[i]}+${bl[j]}+${bl[k]}]`);
    }
  }
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const key = [branches[i],branches[j]].sort((a,b)=>a-b).join('_');
    if(HANKAI_TABLE[key]){
      const[nm,el]=HANKAI_TABLE[key];
      results.push(`三合半会: ${nm}（${el}）  [${bl[i]} + ${bl[j]}]`);
    }
  }
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const k=`${Math.min(branches[i],branches[j])}_${Math.max(branches[i],branches[j])}`;
    if(ROKU_CHU_TABLE[k]) results.push(`六冲: ${ROKU_CHU_TABLE[k]}  [${bl[i]} + ${bl[j]}]`);
  }
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const k=`${Math.min(branches[i],branches[j])}_${Math.max(branches[i],branches[j])}`;
    if(ROKU_GAI_TABLE[k]) results.push(`六害: ${ROKU_GAI_TABLE[k]}  [${bl[i]} + ${bl[j]}]`);
  }
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let k=j+1;k<n;k++){
    const key=[branches[i],branches[j],branches[k]].sort((a,b)=>a-b).join('_');
    if(SAN_KEI_TABLE[key]){const[nm,tp]=SAN_KEI_TABLE[key];results.push(`刑: ${nm}（${tp}）  [${bl[i]}+${bl[j]}+${bl[k]}]`);}
  }
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const key=[branches[i],branches[j]].sort((a,b)=>a-b).join('_');
    if(SAN_KEI_TABLE[key]){const[nm,tp]=SAN_KEI_TABLE[key];results.push(`刑: ${nm}（${tp}）  [${bl[i]} + ${bl[j]}]`);}
  }
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

function getSexagenary60Idx(stemIdx, branchIdx) {
  for (let k = 0; k < 6; k++) {
    const n = stemIdx + k * 10;
    if (n % 12 === branchIdx) return n;
  }
  return stemIdx;
}

function getDaiyun(yearStemI, monthStemI, monthBranI, male,
                   birthJdUtc, prevNodeJd, nextNodeJd, birthYear) {
  const yangYear = (yearStemI % 2 === 0);
  const forward  = (male === yangYear);
  const direction = forward ? '順行' : '逆行';
  const polarity  = yangYear ? '陽年' : '陰年';
  const genderStr = male ? '男命' : '女命';

  const nodeJd = forward ? nextNodeJd : prevNodeJd;
  let kiunYears = 0, kiunMonths = 0;
  if (nodeJd !== null) {
    const kiunDays  = Math.abs(nodeJd - birthJdUtc);
    const totalHrs  = kiunDays * 24;
    kiunYears  = Math.floor(totalHrs / 72);
    const remHrs = totalHrs % 72;
    kiunMonths = Math.min(11, Math.floor(remHrs / 6));
    if (kiunMonths >= 12) { kiunYears += Math.floor(kiunMonths / 12); kiunMonths %= 12; }
  }
  const kiunStr = `${kiunYears}歳` + (kiunMonths > 0 ? `${kiunMonths}ヶ月` : '');

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

// ── 紫微斗数 純粋関数ライブラリ ───────────────────────────────────────────

const PALACE_NAMES = ['命宮','兄弟宮','夫妻宮','子女宮','財帛宮','疾厄宮','遷移宮','交友宮','官禄宮','田宅宮','福徳宮','父母宮'];
const ZIWEI_SYSTEM = [['紫微',0],['天機',-1],['太陽',-3],['武曲',-4],['天同',-5],['廉貞',-8]];
const TIANFU_SYSTEM= [['天府',0],['太陰',1],['貪狼',2],['巨門',3],['天相',4],['天梁',5],['七殺',6],['破軍',10]];
const WUXING_JU_TABLE = [4,6,3,5,4,6, 2,5,4,3,2,5, 6,3,2,4,6,3, 5,4,6,2,5,4, 3,2,5,6,3,2];
const WUXING_JU_NAMES = {2:'水二局',3:'木三局',4:'金四局',5:'土五局',6:'火六局'};
const YEAR_STEM_TO_YINMONTH = [2,4,6,8,0,2,4,6,8,0];
const YEAR_TO_YIN_STEM      = [2, 4, 6, 8, 0];

const TIANKUI_TABLE  = [1, 0,11,11, 1, 0, 1, 6, 3, 3];
const TIANYUE_TABLE  = [7, 8, 9, 9, 7, 8, 7, 2, 5, 5];
const LUZUN_TABLE    = [2, 3, 5, 6, 5, 6, 8, 9,11, 0];
const TIANMA_TABLE   = [2,11, 8, 5, 2,11, 8, 5, 2,11, 8, 5];

const SIHUA_TABLE = [
  [['廉貞','化禄'],['破軍','化権'],['武曲','化科'],['太陽','化忌']],
  [['天機','化禄'],['天梁','化権'],['紫微','化科'],['太陰','化忌']],
  [['天同','化禄'],['天機','化権'],['文昌','化科'],['廉貞','化忌']],
  [['太陰','化禄'],['天同','化権'],['天機','化科'],['巨門','化忌']],
  [['貪狼','化禄'],['太陰','化権'],['右弼','化科'],['天機','化忌']],
  [['武曲','化禄'],['貪狼','化権'],['天梁','化科'],['文曲','化忌']],
  [['太陽','化禄'],['武曲','化権'],['太陰','化科'],['天同','化忌']],
  [['巨門','化禄'],['太陽','化権'],['文曲','化科'],['文昌','化忌']],
  [['天梁','化禄'],['紫微','化権'],['左輔','化科'],['武曲','化忌']],
  [['破軍','化禄'],['巨門','化権'],['太陰','化科'],['貪狼','化忌']],
];

function getPalaceStems(yearStemIdx) {
  const yinStem = YEAR_TO_YIN_STEM[yearStemIdx % 5];
  const result = {};
  for (let b = 0; b < 12; b++) {
    result[b] = (yinStem + ((b - 2) + 12) % 12) % 10;
  }
  return result;
}

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
    左輔: (4  + m - 1) % 12,
    右弼: (10 - m + 1 + 12) % 12,
    文昌: (10 - hb + 12) % 12,
    文曲: (4  + hb) % 12,
  };
}

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

// ── ボイドタイム定数 ──────────────────────────────────────────────────────

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

const VOID_ASPECTS = [0, 60, 90, 120, 180];

// ── BSP 依存計算関数 ──────────────────────────────────────────────────────

function gregorianToJdn(y, m, d) {
  const a  = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
    Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function findLichun(year) {
  const searchStart = dateStrToJdUtcMidJst(`${year - 1}-12-01`);
  const searchEnd   = dateStrToJdUtcMidJst(`${year}-03-31`);
  const BND = 315;
  function dev(jd) {
    const lon = _computeApparent(NAIF.SUN, jdUtcToTdb(jd)).lon;
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

function findShichuNode(birthJdUtc, birthYear) {
  const searchStart = dateStrToJdUtcMidJst(`${birthYear - 1}-10-01`);
  const searchEnd   = dateStrToJdUtcMidJst(`${birthYear + 1}-04-01`);

  const nodeLons = Object.keys(SHICHU_NODE_LON).map(Number);
  const events   = [];
  const STEP     = 10;

  for (const bnd of nodeLons) {
    function devBnd(jd) {
      const lon = _computeApparent(NAIF.SUN, jdUtcToTdb(jd)).lon;
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

function calculateVoidOfCourse(startJd, endJd) {
  const INGRESS_STEP = 2 / 24;

  function moonLon(jd) {
    return _computeApparent(NAIF.MOON, jdUtcToTdb(jd)).lon;
  }
  function signIdx(lon) { return Math.floor(lon / 30) % 12; }

  const ingresses = [];
  let prevJd   = startJd;
  let prevSign = signIdx(moonLon(startJd));

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

  const ASPECT_STEP = 1 / 24;

  function moonPlanetDev(jd, naifId, targetDeg) {
    const moonL = moonLon(jd);
    const planL = _computeApparent(naifId, jdUtcToTdb(jd)).lon;
    let sep = Math.abs(moonL - planL) % 360;
    if (sep > 180) sep = 360 - sep;
    return sep - targetDeg;
  }

  const boundaries = [{ jd: startJd, signIdx: signIdx(moonLon(startJd)) }, ...ingresses];
  const voids = [];

  for (let i = 0; i < boundaries.length; i++) {
    const segStart = boundaries[i].jd;
    const segEnd   = i + 1 < boundaries.length ? boundaries[i + 1].jd : endJd;

    if (segEnd - segStart < 0.01) continue;

    const aspectEvents = [];

    for (const planet of VOID_PLANETS) {
      for (const targetDeg of VOID_ASPECTS) {
        let prevVal = moonPlanetDev(segStart, planet.id, targetDeg);
        for (let jd = segStart + ASPECT_STEP; jd <= segEnd; jd += ASPECT_STEP) {
          const curVal = moonPlanetDev(jd, planet.id, targetDeg);
          if (prevVal * curVal < 0) {
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

    if (i + 1 < boundaries.length) {
      const nextIngress = boundaries[i + 1];
      if (aspectEvents.length > 0) {
        const last = aspectEvents.reduce((a, b) => a.jd > b.jd ? a : b);
        const VOID_ASP_NAMES = {0:'合',60:'六分',90:'四分',120:'三分',180:'衝'};
        voids.push({
          voidStart:        last.jd,
          voidEnd:          nextIngress.jd,
          lastAspectPlanet: last.planet,
          lastAspectDeg:    last.deg,
          lastAspectName:   VOID_ASP_NAMES[last.deg] ?? `${last.deg}°`,
          ingressSignIdx:   nextIngress.signIdx,
        });
      } else {
        voids.push({
          voidStart:        segStart,
          voidEnd:          nextIngress.jd,
          lastAspectPlanet: '（なし）',
          lastAspectDeg:    null,
          lastAspectName:   '—',
          ingressSignIdx:   nextIngress.signIdx,
        });
      }
    }
  }

  return voids;
}

// ── イベントハンドラ登録 ──────────────────────────────────────────────────

function _registerHandlers() {

  // ── 3-4-1: 四柱推命 命式 ──────────────────────────────────────────────
  document.getElementById('form-shichu')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-shichu')) return;

    const dateVal  = document.getElementById('shichu-date').value;
    const timeVal  = document.getElementById('shichu-time').value;
    const genderVal= document.getElementById('shichu-gender').value;
    const male     = (genderVal === 'male');

    const [y, m, d] = dateVal.split('-').map(Number);
    const [hh, mm]  = timeVal.split(':').map(Number);

    const birthJdUtc = dateToJd(y, m, d, hh - 9, mm, 0);

    showLoading('result-shichu', '計算中…', '節気（12個）の通過時刻を二分探索');
    await yieldFrame();

    const lichunJd      = findLichun(y);
    const effectiveYear = birthJdUtc >= lichunJd ? y : y - 1;
    const yearIdx   = ((effectiveYear - 4) % 60 + 60) % 60;
    const yearStemI = yearIdx % 10;
    const yearBranI = yearIdx % 12;
    const yearPillar = { stem: STEMS[yearStemI], branch: BRANCHES[yearBranI], name: SEXAGENARY[yearIdx] };

    const { monthNum, prevNodeJd, nextNodeJd } = findShichuNode(birthJdUtc, y);
    const monthBranI  = MONTH_BRANCH_IDX[monthNum] ?? 2;
    const monthStemI  = (MONTH_STEM_START[yearStemI % 5] + monthNum - 1) % 10;
    const monthPillar = { stem: STEMS[monthStemI], branch: BRANCHES[monthBranI], name: `${STEMS[monthStemI]}${BRANCHES[monthBranI]}` };

    const jdn       = gregorianToJdn(y, m, d);
    const dayOffset = ((jdn - JDN_JIAZI) % 60 + 60) % 60;
    const dayStemI  = dayOffset % 10;
    const dayBranI  = dayOffset % 12;
    const dayPillar = { stem: STEMS[dayStemI], branch: BRANCHES[dayBranI], name: SEXAGENARY[dayOffset] };

    const hourNorm  = (hh === 23) ? -1 : hh;
    const hourBranI = ((Math.floor((hourNorm + 1) / 2) % 12) + 12) % 12;
    const hourStemI = (HOUR_STEM_START[dayStemI % 5] + hourBranI) % 10;
    const hourPillar = { stem: STEMS[hourStemI], branch: BRANCHES[hourBranI], name: `${STEMS[hourStemI]}${BRANCHES[hourBranI]}` };

    const kanshinYear  = getKanshin(yearBranI);
    const kanshinMonth = getKanshin(monthBranI);
    const kanshinDay   = getKanshin(dayBranI);
    const kanshinHour  = getKanshin(hourBranI);

    const juushinYear  = getJuushin(dayStemI, yearStemI);
    const juushinMonth = getJuushin(dayStemI, monthStemI);
    const juushinHour  = getJuushin(dayStemI, hourStemI);

    const kubo = getKubo(dayOffset);

    const juuniseiYear  = getJuunisei(dayStemI, yearBranI);
    const juuniseiMonth = getJuunisei(dayStemI, monthBranI);
    const juuniseiDay   = getJuunisei(dayStemI, dayBranI);
    const juuniseiHour  = getJuunisei(dayStemI, hourBranI);

    const nichinushi = getNichinushiScore(yearStemI, monthStemI, monthBranI, dayStemI,
                                           yearBranI, dayBranI, hourStemI, hourBranI);

    const kanGoList   = getKanGo([yearStemI, monthStemI, dayStemI, hourStemI], monthBranI);
    const branchInter = getBranchInteractions([yearBranI, monthBranI, dayBranI, hourBranI]);

    const daiyun = getDaiyun(yearStemI, monthStemI, monthBranI, male,
                              birthJdUtc, prevNodeJd, nextNodeJd, effectiveYear);

    const wuxingCnt = [0, 0, 0, 0, 0];
    for (const si of [yearStemI, monthStemI, dayStemI, hourStemI]) {
      wuxingCnt[STEM_ELEMENT[si]]++;
    }
    const allKanshin = [...kanshinYear, ...kanshinMonth, ...kanshinDay, ...kanshinHour];
    for (const ks of allKanshin) { if (ks) wuxingCnt[STEM_ELEMENT[STEMS.indexOf(ks)]]++; }
    const maxCnt = Math.max(...wuxingCnt, 1);

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

    const interHtml = branchInter.length > 0 ? branchInter.join('<br>') : '（なし）';

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

  // ── 3-4-2: 紫微斗数 命盤 ──────────────────────────────────────────────
  document.getElementById('form-ziwei')?.addEventListener('submit', async e => {
    e.preventDefault();
    const resultEl = document.getElementById('result-ziwei');

    const gregDate   = document.getElementById('ziwei-greg-date').value;
    const gregTime   = document.getElementById('ziwei-greg-time').value || '12:00';
    const hourBranI  = parseInt(document.getElementById('ziwei-hour-branch').value);
    const gender     = document.getElementById('ziwei-gender').value;

    if (!gregDate) {
      resultEl.innerHTML = '<p style="color:var(--accent-warn)">生年月日を入力してください</p>';
      return;
    }
    if (!_requireBsp('result-ziwei')) return;

    const [gy, gm, gd] = gregDate.split('-').map(Number);
    const [hh, mm]     = gregTime.split(':').map(Number);
    const jdUtc = dateToJd(gy, gm, gd, hh - 9, mm, 0, 'gregorian');
    const jdTdb = jdUtcToTdb(jdUtc);

    resultEl.innerHTML = '<p style="color:var(--text-muted)">農暦変換中…（数秒かかる場合があります）</p>';
    await new Promise(r => setTimeout(r, 0));

    let lunarResult;
    try {
      const sunFn  = jd => _computeApparent(NAIF.SUN,  jd);
      const moonFn = jd => _computeApparent(NAIF.MOON, jd);
      lunarResult = getLunarDate(sunFn, moonFn, jdTdb);
    } catch (err) {
      resultEl.innerHTML = `<p style="color:var(--accent-warn)">農暦変換エラー: ${err.message}</p>`;
      return;
    }

    if (!lunarResult) {
      resultEl.innerHTML = '<p style="color:var(--accent-warn)">農暦変換に失敗しました（BSP カバー範囲外の可能性があります）</p>';
      return;
    }

    const { lunarMonth, lunarDay, isLeap, cycleMonths, dongzhiJd, newMoonJd, calendarBasis } = lunarResult;

    const lunarYearApprox = gy - (gm <= 1 || (gm === 2 && gd < 5) ? 1 : 0);
    const leapMark = isLeap ? '閏' : '';

    const lunarYearIdx = ((lunarYearApprox - 4) % 60 + 60) % 60;
    const yearStemI    = lunarYearIdx % 10;
    const yearBranI    = lunarYearIdx % 12;

    const mingIdx = (lunarMonth + 1 - hourBranI + 12) % 12;
    const shenIdx = (lunarMonth + hourBranI + 4) % 12;

    const mingStemI = getMingGongStemIdx(yearStemI, mingIdx);
    const idx60     = ganzhi60Idx(mingStemI, mingIdx);
    const wuxingJu  = WUXING_JU_TABLE[Math.floor(idx60 / 2)];

    const ziweiIdx  = Math.floor((lunarDay - 1) / wuxingJu) % 12;
    const tianfuIdx = (13 - ziweiIdx) % 12;

    const starsByBranch = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, []]));
    for (const [name, offset] of ZIWEI_SYSTEM) {
      starsByBranch[(ziweiIdx + offset + 12) % 12].push(name);
    }
    for (const [name, offset] of TIANFU_SYSTEM) {
      starsByBranch[(tianfuIdx + offset) % 12].push(name);
    }

    const palaces = Array.from({ length: 12 }, (_, i) => ({
      palaceName: PALACE_NAMES[i],
      branchIdx:  (mingIdx + i) % 12,
      branch:     BRANCHES[(mingIdx + i) % 12],
      stars:      starsByBranch[(mingIdx + i) % 12] ?? [],
    }));

    const shenPalace     = palaces.find(p => p.branchIdx === shenIdx);
    const wuxingName     = WUXING_JU_NAMES[wuxingJu] ?? `${wuxingJu}局`;
    const male           = (gender === 'male');
    const palaceStemsMap = getPalaceStems(yearStemI);
    const minorStars     = placeMinorStars(yearStemI, yearBranI, lunarMonth, hourBranI);
    const sihuaList      = SIHUA_TABLE[yearStemI] ?? [];
    const daixian        = getZiweiDaixian(mingIdx, wuxingJu, male, gy, lunarYearApprox);

    function jdToJstStrLocal(jd) {
      const d = jdToDate(jd + 9 / 24);
      return `${d.year}/${String(d.month).padStart(2,'0')}/${String(d.day).padStart(2,'0')} `
           + `${String(d.hour).padStart(2,'0')}:${String(d.minute).padStart(2,'0')} JST`;
    }

    const mainStarRows = palaces.map(p => {
      const isMing = p.branchIdx === mingIdx;
      const isShen = p.branchIdx === shenIdx;
      const marker = (isMing ? '★命' : '') + (isShen ? '☆身' : '');
      const palaceStemI    = palaceStemsMap[p.branchIdx];
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
        冬至: ${jdToJstStrLocal(dongzhiJd)}　|　朔: ${jdToJstStrLocal(newMoonJd)}　|　日付境界基準: ${calendarBasis ?? 'CST (UTC+8)'}<br>
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

  // ── 月のボイドタイム ──────────────────────────────────────────────────
  document.getElementById('form-void')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!_requireBsp('result-void')) return;

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

}
