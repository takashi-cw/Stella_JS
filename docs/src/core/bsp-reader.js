/**
 * bsp-reader.js — JPL .bsp バイナリ読み込み
 *
 * Layer 1: core（chebyshev.js + constants.js に依存）
 *
 * NASA NAIF DAF/SPK フォーマットを ArrayBuffer + DataView で解析し、
 * 指定天体の ICRS XYZ 位置ベクトル（km）を返す。
 *
 * Python 版では Skyfield が jplephem 経由でこの処理を行っている。
 * JS ではブラウザの fetch() でバイナリを取得し、このモジュールで直接解析する。
 *
 * 対応フォーマット:
 *   - SPK Type 2（Chebyshev 多項式：位置）    ← 惑星・月・太陽
 *   - SPK Type 3（Chebyshev 多項式：位置+速度）← 月秤動角、full DE440/DE441
 *   ※ Type 13（Hermite 補間：小天体）は非対応（スコープ外）
 *
 * 出典フォーマット仕様:
 *   - NAIF SPK Required Reading (NAIF N0067)
 *   - NAIF DAF Required Reading (NAIF N0067)
 *   - jplephem (Brandon Rhodes, MIT License) の設計を参考に JS で再実装
 *
 * ライセンス: MIT
 */

'use strict';

import { chebyshevEval3, chebyshevEval3WithVelocity, normalizeTime } from './chebyshev.js';
import { J2000_JD, AU_KM } from './constants.js';

// =========================================================================
// DAF ファイルフォーマット定数
// =========================================================================

const RECORD_SIZE = 1024;         // 1レコード = 1024 バイト
const S_PER_DAY  = 86400.0;       // 1日 = 86400 秒
const SPK_TYPE_2 = 2;             // Chebyshev 多項式（位置）：惑星・月・太陽
const SPK_TYPE_3 = 3;             // Chebyshev 多項式（位置+速度）：月秤動角、full DE440/441

/**
 * SPK タイプから位置計算に使う成分数を返す（Type 2: 3、Type 3: 6、非対応: null）
 * @param {number} type
 * @returns {number|null}
 */
function _spkComponents(type) {
  if (type === SPK_TYPE_2) return 3;
  if (type === SPK_TYPE_3) return 6;
  return null;
}

// =========================================================================
// ファイル読み込み（環境依存レイヤー）
// =========================================================================

/**
 * .bsp ファイルを読み込み ArrayBuffer を返す
 *
 * - Node.js テスト環境: fs.readFile を使用
 * - ブラウザ本番環境: fetch() を使用
 *
 * @param {string} pathOrUrl  ファイルパス（Node.js）または URL（ブラウザ）
 * @returns {Promise<ArrayBuffer>}
 */
export async function loadBsp(pathOrUrl) {
  if (typeof window === 'undefined') {
    // Node.js 環境
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(pathOrUrl);
    // Node.js の Buffer → ArrayBuffer
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } else {
    // ブラウザ環境
    const res = await fetch(pathOrUrl);
    if (!res.ok) throw new Error(`BSP fetch failed: ${res.status} ${res.url}`);
    return res.arrayBuffer();
  }
}

// =========================================================================
// DAF ファイルレコード解析
// =========================================================================

/**
 * DAF ファイルレコード（先頭 1024 バイト）を解析する
 *
 * DAF ファイルレコードレイアウト（バイトオフセット）:
 *   0- 7: LOCIDW — ファイル識別子 ("DAF/SPK ")
 *   8-11: ND — サマリーの double 要素数（SPK = 2）
 *  12-15: NI — サマリーの integer 要素数（SPK = 6）
 *  16-75: LOCIFN — 内部ファイル名（60 バイト）
 *  76-79: FWARD — 最初のサマリーレコード番号
 *  80-83: BWARD — 最後のサマリーレコード番号
 *  84-91: FREE — 最初の空きアドレス（8バイト double として）
 *  92-99: LOCFMT — バイトオーダー識別子 ("LTL-IEEE" or "BIG-IEEE")
 *
 * @param {DataView} view
 * @returns {{ nd: number, ni: number, firstSumRec: number, lastSumRec: number,
 *             isLittleEndian: boolean, locifn: string }}
 */
function _parseFileRecord(view) {
  const locidw = _readChars(view, 0, 8);
  if (!locidw.startsWith('DAF/SPK') && !locidw.startsWith('DAF/EK')) {
    throw new Error(`非SPKファイルです。LOCIDW="${locidw}"`);
  }

  const nd = view.getInt32(8, true);
  const ni = view.getInt32(12, true);

  const locifn      = _readChars(view, 16, 60).trimEnd();
  const firstSumRec = view.getInt32(76, true);
  const lastSumRec  = view.getInt32(80, true);

  // バイトオーダー識別子（オフセット 88、8バイト）
  const locfmt = _readChars(view, 88, 8).trim();
  const isLittleEndian = locfmt !== 'BIG-IEEE';

  return { nd, ni, firstSumRec, lastSumRec, isLittleEndian, locifn };
}

// =========================================================================
// サマリーレコード解析
// =========================================================================

/**
 * サマリーレコードを全て解析し、セグメント記述子のリストを返す
 *
 * サマリーレコードレイアウト（各 1024 バイト）:
 *   0-  7: 次のサマリーレコード番号（double、0.0 = 最後）
 *   8- 15: 前のサマリーレコード番号（double、0.0 = 最初）
 *  16- 23: このレコードのサマリー数（double）
 *  24以降: サマリー列（各サマリー = (ND + ceil(NI/2)) * 8 バイト）
 *
 * SPK の各サマリー（ND=2, NI=6 → 5 doubles = 40 バイト）:
 *   doubles[0]: start_jd   （セグメント開始 JD）
 *   doubles[1]: end_jd     （セグメント終了 JD）
 *   int32[0]: target       （ターゲット NAIF コード）
 *   int32[1]: center       （センター NAIF コード）
 *   int32[2]: frame        （参照フレーム; 1 = J2000）
 *   int32[3]: type         （SPK タイプ; 2 = Chebyshev 位置）
 *   int32[4]: first_addr   （データ先頭アドレス; 1-indexed double 番号）
 *   int32[5]: last_addr    （データ末尾アドレス; 1-indexed double 番号）
 *
 * @param {DataView} view
 * @param {number} nd
 * @param {number} ni
 * @param {number} firstSumRec
 * @param {boolean} le  little-endian か
 * @returns {SegmentDescriptor[]}
 */
function _parseSummaries(view, nd, ni, firstSumRec, le) {
  const summaryDoubles = nd + Math.ceil(ni / 2);  // SPK: 2 + 3 = 5
  const summaryBytes   = summaryDoubles * 8;
  const segments = [];

  let recNum = firstSumRec;

  while (recNum > 0) {
    const recOffset = (recNum - 1) * RECORD_SIZE;

    const nextRec = view.getFloat64(recOffset + 0, le);
    // const prevRec = view.getFloat64(recOffset + 8, le);  // 未使用
    const nSummaries = Math.round(view.getFloat64(recOffset + 16, le));

    for (let i = 0; i < nSummaries; i++) {
      const offset = recOffset + 24 + i * summaryBytes;

      // ND doubles: [start_jd, end_jd]
      const startJd = view.getFloat64(offset, le);
      const endJd   = view.getFloat64(offset + 8, le);

      // NI integers packed into ceil(NI/2) doubles
      // (各 double に 2 つの int32 が little-endian でパック)
      const intOffset = offset + nd * 8;
      const target    = view.getInt32(intOffset + 0, le);
      const center    = view.getInt32(intOffset + 4, le);
      const frame     = view.getInt32(intOffset + 8, le);
      const type      = view.getInt32(intOffset + 12, le);
      const firstAddr = view.getInt32(intOffset + 16, le);
      const lastAddr  = view.getInt32(intOffset + 20, le);

      segments.push({ startJd, endJd, target, center, frame, type, firstAddr, lastAddr });
    }

    recNum = Math.round(nextRec);
  }

  return segments;
}

// =========================================================================
// Chebyshev セグメントの位置計算（Type 2 / Type 3 共通）
// =========================================================================

/**
 * Type 2 / Type 3 セグメントから JD(TDB) における ICRS 位置を計算する
 *
 * Type 2 と Type 3 のレコード構造は同一。成分数のみ異なる:
 *   Type 2: [mid, radius, Xpos×n, Ypos×n, Zpos×n]               → components=3
 *   Type 3: [mid, radius, Xpos×n, Ypos×n, Zpos×n, Xvel×n, Yvel×n, Zvel×n] → components=6
 *
 * ncoeff = (RSIZE - 2) / components で自動分岐。
 * 速度は位置多項式の微分で算出（Type 3 の格納速度係数は不使用）。
 *
 * @param {DataView} view
 * @param {SegmentDescriptor} seg
 * @param {number} jdTdb       JD（TDB基準）
 * @param {boolean} le         little-endian か
 * @param {number} components  成分数（Type 2 = 3、Type 3 = 6）
 * @param {boolean} [withVelocity=false]
 * @returns {{ position: number[], velocity?: number[] }} km 単位
 */
function _computeChebyshev(view, seg, jdTdb, le, components, withVelocity = false) {
  const dataStart = (seg.firstAddr - 1) * 8;
  const dataEnd   = seg.lastAddr * 8;

  // 末尾 4 doubles: INIT, INTLEN, RSIZE, N
  const metaOffset = dataEnd - 32;
  const init    = view.getFloat64(metaOffset,      le);
  const intlen  = view.getFloat64(metaOffset +  8, le);
  const rsize   = Math.round(view.getFloat64(metaOffset + 16, le));
  const n       = Math.round(view.getFloat64(metaOffset + 24, le));

  const tSeconds = (jdTdb - J2000_JD) * S_PER_DAY;

  // セグメントのカバー範囲チェック
  const segStart = init;
  const segEnd   = init + n * intlen;
  if (tSeconds < segStart || tSeconds > segEnd) {
    const jdStart = (segStart / S_PER_DAY + J2000_JD).toFixed(4);
    const jdEnd   = (segEnd   / S_PER_DAY + J2000_JD).toFixed(4);
    throw new Error(
      `JD out of coverage: JD ${jdTdb.toFixed(4)} (valid: JD ${jdStart} – ${jdEnd})`
    );
  }

  // サブ区間インデックス（境界の浮動小数点丸め誤差を吸収）
  let idx = Math.floor((tSeconds - init) / intlen);
  if (idx < 0)   idx = 0;
  if (idx >= n)  idx = n - 1;

  const recOffset = dataStart + idx * rsize * 8;

  const mid    = view.getFloat64(recOffset,     le);
  const radius = view.getFloat64(recOffset + 8, le);
  const x      = (tSeconds - mid) / radius;

  // ncoeff = (RSIZE - 2) / components（Type 2: /3、Type 3: /6）
  const ncoeff = (rsize - 2) / components;

  const coeffX = _readCoeffs(view, recOffset + 16,                  ncoeff, le);
  const coeffY = _readCoeffs(view, recOffset + 16 + ncoeff * 8,     ncoeff, le);
  const coeffZ = _readCoeffs(view, recOffset + 16 + ncoeff * 8 * 2, ncoeff, le);

  if (withVelocity) {
    const { position, velocity } = chebyshevEval3WithVelocity(
      [coeffX, coeffY, coeffZ], x, radius * 2 / S_PER_DAY
    );
    return { position, velocity };
  }

  return { position: chebyshevEval3([coeffX, coeffY, coeffZ], x) };
}

/**
 * DataView から double 配列を読む（内部用）
 * @param {DataView} view
 * @param {number} offset  バイトオフセット
 * @param {number} count   読む要素数
 * @param {boolean} le
 * @returns {number[]}
 */
function _readCoeffs(view, offset, count, le) {
  const arr = new Array(count);
  for (let i = 0; i < count; i++) {
    arr[i] = view.getFloat64(offset + i * 8, le);
  }
  return arr;
}

// =========================================================================
// BspFile クラス — 公開 API
// =========================================================================

/**
 * @typedef {Object} SegmentDescriptor
 * @property {number} startJd
 * @property {number} endJd
 * @property {number} target
 * @property {number} center
 * @property {number} frame
 * @property {number} type
 * @property {number} firstAddr
 * @property {number} lastAddr
 */

/**
 * BspFile — パース済み .bsp ファイルのラッパー
 *
 * 使い方:
 *   const buf = await loadBsp('../data/catalogs/de440s.bsp');
 *   const bsp = parseBsp(buf);
 *   const pos = bsp.getPosition(10, 0, jdTdb);  // Sun 相対 SSB
 */
export class BspFile {
  /**
   * @param {ArrayBuffer} buffer
   */
  constructor(buffer) {
    this._view = new DataView(buffer);
    const { nd, ni, firstSumRec, isLittleEndian, locifn } = _parseFileRecord(this._view);
    this._le = isLittleEndian;
    this._locifn = locifn;

    /** @type {SegmentDescriptor[]} */
    this.segments = _parseSummaries(this._view, nd, ni, firstSumRec, this._le);
  }

  /** 内部ファイル名 */
  get name() { return this._locifn; }

  /**
   * 利用可能なセグメント一覧（target, center の pair）を返す
   * @returns {Array<{target: number, center: number, startJd: number, endJd: number}>}
   */
  get pairs() {
    return this.segments.map(s => ({
      target: s.target, center: s.center,
      startJd: s.startJd, endJd: s.endJd,
    }));
  }

  /**
   * 指定の target/center セグメントを検索する
   * @param {number} target  NAIF ターゲットコード
   * @param {number} center  NAIF センターコード
   * @param {number} jdTdb   JD（TDB）
   * @returns {SegmentDescriptor|null}
   */
  _findSegment(target, center, jdTdb) {
    for (const seg of this.segments) {
      if (seg.target === target && seg.center === center &&
          jdTdb >= seg.startJd && jdTdb <= seg.endJd) {
        return seg;
      }
    }
    return null;
  }

  /**
   * ICRS 位置ベクトル（km）を返す（position のみ）
   *
   * @param {number} target  NAIF ターゲットコード
   * @param {number} center  NAIF センターコード（通常は 0 = SSB）
   * @param {number} jdTdb   JD（TDB基準）
   * @returns {number[]} [x, y, z] km
   * @throws {Error} セグメントが存在しない場合
   */
  getPosition(target, center, jdTdb) {
    const seg = this._findSegment(target, center, jdTdb);
    if (!seg) {
      throw new Error(
        `セグメントが見つかりません: target=${target}, center=${center}, jd=${jdTdb}`
      );
    }
    const components = _spkComponents(seg.type);
    if (components === null) {
      throw new Error(`未対応の SPK タイプ: ${seg.type}`);
    }
    return _computeChebyshev(this._view, seg, jdTdb, this._le, components, false).position;
  }

  /**
   * ICRS 位置と速度ベクトル（km, km/day）を返す
   *
   * @param {number} target
   * @param {number} center
   * @param {number} jdTdb
   * @returns {{ position: number[], velocity: number[] }}
   */
  getPositionAndVelocity(target, center, jdTdb) {
    const seg = this._findSegment(target, center, jdTdb);
    if (!seg) {
      throw new Error(
        `セグメントが見つかりません: target=${target}, center=${center}, jd=${jdTdb}`
      );
    }
    const components = _spkComponents(seg.type);
    if (components === null) {
      throw new Error(`未対応の SPK タイプ: ${seg.type}`);
    }
    return _computeChebyshev(this._view, seg, jdTdb, this._le, components, true);
  }

  /**
   * セグメントチェーンを辿って SSB 起点の位置を合成する
   *
   * DE440s は以下のセグメントチェーンを持つ:
   *   SSB(0) → EMB(3)
   *   EMB(3) → Earth(399)
   *   EMB(3) → Moon(301)
   *   SSB(0) → Sun(10)
   *   SSB(0) → MercuryBC(1)
   *   ...
   *
   * target と center が直接セグメントにない場合、SSB を経由して合成する。
   *
   * @param {number} target  NAIF ターゲットコード
   * @param {number} center  NAIF センターコード
   * @param {number} jdTdb
   * @returns {number[]} [x, y, z] km
   */
  computePosition(target, center, jdTdb) {
    if (target === center) return [0, 0, 0];

    // 直接セグメントがあればそれを使う
    const direct = this._findSegment(target, center, jdTdb);
    if (direct) return this.getPosition(target, center, jdTdb);

    // SSB(0) を経由して合成: pos(target/SSB) - pos(center/SSB)
    const SSB = 0;
    const posTarget = this._posFromSsb(target, jdTdb);
    const posCenter = center === SSB ? [0, 0, 0] : this._posFromSsb(center, jdTdb);

    return [
      posTarget[0] - posCenter[0],
      posTarget[1] - posCenter[1],
      posTarget[2] - posCenter[2],
    ];
  }

  /**
   * SSB(0) からの位置を再帰的に合成する（内部用）
   * @param {number} target
   * @param {number} jdTdb
   * @returns {number[]} km
   */
  _posFromSsb(target, jdTdb) {
    const SSB = 0;

    // 直接 SSB→target セグメントがあれば即返す
    const direct = this._findSegment(target, SSB, jdTdb);
    if (direct) return this.getPosition(target, SSB, jdTdb);

    // チェーンを探す: 何らかの中間 center を通じてターゲットに辿り着けるか
    for (const seg of this.segments) {
      if (seg.target === target && jdTdb >= seg.startJd && jdTdb <= seg.endJd) {
        // seg.center → target のベクトル
        const fromCenter = this.getPosition(target, seg.center, jdTdb);
        // SSB → seg.center のベクトル
        const centerFromSsb = seg.center === SSB ? [0, 0, 0] : this._posFromSsb(seg.center, jdTdb);
        return [
          centerFromSsb[0] + fromCenter[0],
          centerFromSsb[1] + fromCenter[1],
          centerFromSsb[2] + fromCenter[2],
        ];
      }
    }

    throw new Error(`SSB からのチェーンが見つかりません: target=${target}, jd=${jdTdb}`);
  }
}

/**
 * ArrayBuffer を解析して BspFile インスタンスを返す
 *
 * @param {ArrayBuffer} buffer
 * @returns {BspFile}
 */
export function parseBsp(buffer) {
  return new BspFile(buffer);
}

// =========================================================================
// ユーティリティ
// =========================================================================

/**
 * DataView から ASCII 文字列を読む
 * @param {DataView} view
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function _readChars(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}
