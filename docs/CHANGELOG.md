# Stella-JS CHANGELOG

---

## [2026-04-04] ホールサイン＋サイデリアルのハウス計算バグ修正

### 変更ファイル
- `src/app.js` — ネイタルチャートの `adjustedCusps` 生成ロジック（1箇所）

### バグ概要
ホールサイン（Whole Sign）ハウスシステムをサイデリアル黄道と組み合わせた場合、
カスプ境界がサイデリアルサイン境界（30°の倍数）とズレていた。

**根本原因**：`housesWholeSigns()` はトロピカルASC基準のカスプ（30°の倍数）を返す。
これに対し `adjustedCusps = cusps.map(c => normAngle(c - ayanamsha))` でアヤナムシャを
引くと、結果は 30°の倍数でなくなる（例: 210°→186.373°）。
その結果、同一サイデリアルサイン（双子座）内にいる太陽とノードが別々のハウスに
分類される不整合（太陽→H9、ノード→H8）が生じていた。

### 修正内容

```javascript
// 旧（サイデリアルサイン境界からズレたカスプ）
const adjustedCusps = cusps.map(c => normAngle(c - ayanamshaVal));

// 新（ホールサイン＋サイデリアル時はサイデリアルASCのサイン境界から再計算）
let adjustedCusps;
if (hSystem === 'whole' && ayanamshaVal !== 0) {
  const sidAsc = normAngle(angles[0] - ayanamshaVal);
  const sidAscSignStart = Math.floor(sidAsc / 30) * 30;
  adjustedCusps = Array.from({ length: 12 }, (_, i) => normAngle(sidAscSignStart + i * 30));
} else {
  adjustedCusps = cusps.map(c => normAngle(c - ayanamshaVal));
}
```

### 期待される変化
- 同一サイデリアルサイン内の惑星が同一ハウスに正しく分類される
- トロピカル・ホールサイン、他のハウスシステムへの影響なし
- サイデリアル・ホールサインの計算結果が正しく整合するようになった

---

## [2026-04-04] 農暦変換の朔（新月）検索バグ修正 — 満月誤検出による「25ヶ月年」

### 変更ファイル
- `src/chart/lunar-calendar.js` — `findNewMoonsInRange()` の朔検出ロジック修正

### バグ概要
`findNewMoonsInRange()` で月-太陽黄経差（elongation）のゼロ交差を検出する際、
`(curr > 0 && next <= 0) || (curr < 0 && next >= 0)` という二方向チェックが満月でも発火していた。

満月では elongation が +175° → −175° に**ラップアラウンド**し、符号が正→負に変わる。
これが「ゼロ交差」と誤判定され、1サイクル（12〜13ヶ月）で朔が24〜26個に倍増。
結果として `cycleMonths = 25`（25ヶ月年）、農暦月番号も完全に狂っていた。

**根本原因**：朔は elongation が **負→正** に変わる瞬間だけ。正→負は満月のラップアラウンドであり、新月ではない。

### 修正内容

```javascript
// 旧（誤検出あり）
const crossesZero = (curr > 0 && next <= 0) || (curr < 0 && next >= 0);

// 新（朔のみ正しく検出）
const crossesZero = curr <= 0 && next > 0;
```

### 期待される変化
- `cycleMonths`: 25 → 12（通常年）または 13（閏年）
- `lunarMonth`: 不正な値 → 正しい月番号
- 紫微斗数・四柱推命の農暦計算結果が正常化

---

## [2026-04-04] 太陽黄経暦の星座列を IAU 13星座に修正

### 変更ファイル
- `src/app.js` — 太陽黄経暦（6. 太陽黄経暦）の星座列を IAU 13星座に統一

### 修正内容

#### バグ修正: 太陽黄経暦の星座列
- `calculateSolarAlmanac()` の `sign` が `ZODIAC_SIGNS_JP[Math.floor(lon / 30) % 12]`（トロピカル均等30°・12星座）を使用していた
- 天文計算メニューの方針（IAU 13星座）と不一致だったため `lonToIauConstellation(lon)` に変更

#### あわせて対応
- テーブルヘッダー「星座」→「IAU 星座」に変更
- 「星座は IAU 境界（13星座・蛇遣座含む）による。J2000.0 近似値。」の注記を追加（地心惑星位置表と統一）

#### 変更対象外
- 占星術計算メニューの「惑星星座運行」「中世惑星運行」は トロピカル12星座のまま維持（イングレス計算はトロピカル基準が正しい）

---

## [2026-04-04] 農暦変換の日付境界を CST（北京時間）基準に修正

### 変更ファイル
- `src/chart/lunar-calendar.js` — `getLunarDate()` の月帰属判定・農暦日計算を CST 基準に修正

### 修正内容

#### バグ修正: 農暦日付境界の時刻系
- 月帰属判定（`assigned.find(...)`）が TDB JD 直接比較（≒ UTC 基準）だった
- 農暦日計算（`Math.floor(jdTdb - birthEntry.start) + 1`）も同様に UTC 基準だった
- 農暦は中国標準時（CST = UTC+8）の深夜0時を日付境界とするため、朔が UTC 深夜付近に発生するケースで1日ズレが生じていた

#### 変更内容
- 内部ヘルパー `_jdToCstDayNum(jd)` を追加（JD → CST 暦日番号の純粋関数）
  - `Math.floor(jd + 8/24 + 0.5)` で CST 深夜0時基準の日番号を取得
- 月帰属判定・農暦日計算を `_jdToCstDayNum()` ベースに統一
- 戻り値に `calendarBasis: 'CST (UTC+8)'` を追加

#### Python版との統一
- Python版 `spacefield/calendar/lunar_calendar.py` で 2026-04-04 に実施した同修正の JS 移植
- 両版の農暦計算が CST 基準で一致するようになった

---

## [2026-04-03] 地心惑星位置表の星座列を IAU 13星座に修正

### 変更ファイル
- `src/app.js` — 惑星位置計算（地心座標）の星座列を IAU 13星座に統一

### 修正内容

#### バグ修正: 地心惑星位置表の星座列
- `form-planet-pos` の星座列が `lonToSign()`（トロピカル均等30°・12星座）を使用していた
- 天文計算メニューの方針（IAU 13星座）と不一致だったため `lonToIauConstellation()` に変更
- 日心表と同様の注記「星座は IAU 境界（13星座・蛇遣座含む）による。J2000.0 近似値。」を追加

#### 変更の影響
- 天文計算 → 惑星位置計算（地心座標）の「IAU 星座」列が IAU 13星座（蛇遣座含む）で表示されるようになった
- 例: 冥王星（2000/01/01）黄経 ~250° → 旧: 射手座 11.441°（トロピカル）→ 新: 蛇遣座 (Oph)（IAU）
- 占星術計算メニューの `lonToSign()` は変更なし（トロピカル12サインを維持）

---

## [2026-03-31] デプロイ準備・UI 整備・ドキュメント更新

### 変更ファイル
- `src/app.js` — .txt ダウンロード実装・モバイル対応・ラベル日本語化・中世占星術トポセン対応
- `public/index.html` — メタディスクリプション・manifest リンク・apple-touch-icon・ハンバーガーボタン追加
- `public/style.css` — スマホ対応（サイドバー折りたたみ・1カラム・テーブル横スクロール）
- `public/help.html` — 新規作成（計算精度・メニューガイド・ライセンス・PayPal カンパボタン）
- `public/manifest.json` — 新規作成（PWA ホーム画面追加対応）
- `public/assets/icons/` — アプリアイコン追加（192px / 512px / apple-touch-icon）
- `README.md` — 全面書き直し（実装済み機能・実際のディレクトリ構造に更新）
- `LICENSE` — 著作権者名を `Takashi Shiga` に更新
- `DATA_ETHICS.md` — AI 方針・ライセンス記述を最新方針に更新
- `docs/TERMS.md` — CSV → .txt・npm 削除・更新日付修正
- `.gitignore` — `de440s-modern.bsp` のみ push 対象に設定・`_private/` 除外追加
- `_private/` フォルダ — 非公開ファイル（スナップショット・business-model 等）を隔離

### 実装内容

#### .txt ダウンロード機能
- `buildTxtContent(rows, meta)` — 純粋関数。タブ区切り + メタ情報ヘッダー生成
- `downloadTxt(filename, content)` — 副作用関数。Blob + `<a download>` でファイル保存
- ヘッダー: 座標系（of-date / J2000.0）・対象天体・期間・CC BY-NC-SA ライセンス記載
- 列ヘッダー: `JST日時 / 天体 / 黄経(deg) / 角速度(deg/day) / 黄緯(deg) / 距離(AU)`

#### UI 改善
- `λ(°)` / `ω(°/day)` / `Δλ` 等のギリシャ文字ラベルを全面日本語化
- 中世西洋占星術をトポセントリック計算に変更（Python 版に合わせた）
- メタ情報に対象天体を追記（全惑星 or 個別天体名）

#### モバイル対応（600px 以下）
- サイドバー折りたたみ（ハンバーガーボタン ☰）
- 1カラムレイアウト
- テーブル横スクロール対応
- メニュー選択後にサイドバー自動閉じ

---

## [2026-03-30] de440s-history.bsp / de440s-future.bsp 生成

### 変更ファイル
- `Stella-JS/public/data/de440s-history.bsp`（新規生成）
- `Stella-JS/public/data/de440s-future.bsp`（新規生成）
- `Stella-JS/scripts/bsp_extractor.py`（ファイル名・ラベルを de440s- 統一）
- `Stella-JS/docs/architecture.md`（ファイル名 de440- → de440s- に更新）

### 生成結果

| ファイル | ソース | 期間 | サイズ |
|---|---|---|---|
| `de440s-history.bsp` | `de440.bsp` | 1550-01-01〜1872-12-31 | 34 MB |
| `de440s-future.bsp`  | `de440.bsp` | 2101-01-01〜2650-12-31 | 57 MB |

### テスト結果
- 位置照合（各3日時・全セグメント）: 位置差 **0.000 km**（原本と完全一致）

---

## [2026-03-30] bsp_extractor.py 実装・de440s-modern.bsp 生成

### 変更ファイル
- `Stella-JS/scripts/bsp_extractor.py`（新規作成）
- `Stella-JS/public/data/de440s-modern.bsp`（新規生成）
- `Stella-JS/docs/architecture.md`（B-3 JD境界値の誤り修正）

### 実装内容
- `Stella-JS/scripts/bsp_extractor.py` を実装
  - ソース BSP → 指定 JD 範囲の Chebyshev 区間のみ抽出 → 新 BSP 生成
  - 係数を再フィットしない（原本データをバイト水準でそのままコピー）
  - 純粋関数（計算）/ 副作用関数（I/O）を分離
  - `python3 scripts/bsp_extractor.py modern` で個別生成可能

### テスト結果
- 純粋関数 単体テスト 15件 全合格
- 位置照合テスト（全セグメント × 5日時）: 位置差 **0.000 km**（完全一致）

### バグ修正（実装中に発見）
- SPK Type 2 レコード構造の誤認: MIDPT/RADIUS は各レコードの**末尾**ではなく**先頭** 2要素
  - 修正前: `raw[i*rsize : i*rsize + n_coeffs]`（先頭にMIDPT/RADIUSが混入）
  - 修正後: `raw[i*rsize + 2 : (i+1)*rsize]`（先頭 2要素をスキップ）

### 補足: architecture.md のJD境界値を修正
- 1873-01-01 = `JD 2405026.5`（旧・誤） → `JD 2405159.5`（正）
- 1872-12-31 = `JD 2405025.5`（旧・誤） → `JD 2405158.5`（正）
- 2100-12-31 = `JD 2816788.5`（旧・誤） → `JD 2488433.5`（正）
- 2101-01-01 = `JD 2816789.5`（旧・誤） → `JD 2488434.5`（正）
- 旧値は設計時に計算ミスが混入していた

### de440s-modern.bsp の実サイズ
- 推定値 `~3 MB` は過小評価（誤り）
- 実サイズ: **23.7 MB**（元の de440s.bsp 31MB × 227年/300年 = 23.5MB と整合）
- iOS 50MB 制限は問題なし

---

## [2026-03-30] Python版バグ修正: 紫微大限 wuxing_ju フィールド名誤り

### 変更ファイル
- `app/core/oriental/ziwei_skeleton.py`（Python版）

### 修正内容
- `get_ziwei_daixian` 内で `skeleton.get('wuxing_ju_num', 3)` としていたが、
  `build_skeleton` が返すキー名は `'wuxing_ju'` であり、フィールド名の誤りにより
  常にデフォルト値 `3`（木三局扱い）が使われていた
- → `skeleton.get('wuxing_ju', 3)` に修正
- 影響: 起運年齢が五行局の数値（水二局=2歳、木三局=3歳、etc.）として
  正しく計算されるようになった（例: 癸亥年 水二局 → 3歳 → **2歳** に修正）
- JS版（`src/app.js` の `getZiweiDaixian`）は最初から正しく実装されており影響なし

---

## [2026-03-30] 四柱推命・紫微斗数 スケルトン拡張（Python版との出力揃え）

### 変更ファイル
- `public/index.html` — 四柱推命フォームに性別選択を追加
- `src/app.js` — 純粋関数追加 + 両ハンドラー拡張

### 追加機能

#### 四柱推命
| 追加項目 | 概要 |
|---|---|
| 蔵干 | 徐大升版（子〜亥の全12地支） |
| 十神（通変星） | 日干基準の五行関係 × 陰陽で決定 |
| 空亡（天中殺） | 日柱の60甲子旬から導出 |
| 十二運星 | 日干 × 四柱地支の生死段階 |
| 日主強弱 | 月令+通根+天干サポートのスコア合計 |
| 干合・刑冲合害 | 六合・三合・半会・六冲・六害・三刑・自刑 |
| 五行分布バー | 天干4本 + 蔵干全数の五行集計 |
| 大運 | 月柱起点で順行/逆行展開、起運年齢算出 |

#### 紫微斗数
| 追加項目 | 概要 |
|---|---|
| 宮干（五虎遁年法） | 年干から全12宮の宮干を算出 |
| 副星配置 | 天魁・天鉞・禄存・擎羊・陀羅・天馬・左輔・右弼・文昌・文曲 |
| 四化 | 年干に対応する化禄・化権・化科・化忌 |
| 紫微大限 | 命宮起点で順行/逆行・10年大限の宮移動一覧 |

### 備考
- 追加した純粋関数はすべて引数完結（BSP不要）
- Python版 `kanshin.py` / `interactions.py` / `daiyun.py` / `ziwei_skeleton.py` と同アルゴリズム
- `findShichuNode` の戻り値に `prevNodeJd` / `nextNodeJd` を追加（大運起運計算に使用）

---

## [2026-03-30] 農暦変換（グレゴリオ → 旧暦）実装 + 紫微斗数フォーム更新

### 変更ファイル
- `src/chart/lunar-calendar.js` (**NEW**) — 農暦変換ライブラリ（純粋関数層）
- `src/index.js` — `getLunarDate` など6関数をエクスポート追加
- `src/app.js` — `getLunarDate` インポート追加、紫微斗数フォームを農暦自動変換に変更
- `public/index.html` — 紫微斗数フォームを グレゴリオ日付＋時刻入力に変更

### 実装内容

Python版 `spacefield/calendar/lunar_calendar.py` を JS に移植。Skyfield 依存を廃し、
既存 BSP（JPL DE440s）＋ `computeApparent()` ベースに置換。

#### アルゴリズム（置閏法）
1. 入力 JD を含む「冬至サイクル」を決定（当年の冬至を基準に前後を判定）
2. サイクル前後 35 日の範囲で朔（新月）と中気を一括取得
3. 月11の開始朔 = 冬至直前の朔
4. 月番号を割り当て: 中気あり → 次の月番号 / 中気なし（初出）→ 閏月
5. 入力 JD が含まれる月を特定し、農暦月・日を返す

#### 追加 API (`src/chart/lunar-calendar.js`)
| 関数 | 説明 |
|---|---|
| `findNewMoonsInRange(sun, moon, start, end)` | 指定 JD 範囲内の朔を全て返す |
| `findZhongqiInRange(sun, start, end)` | 指定 JD 範囲内の中気（30°倍数）を全て返す |
| `findDongzhi(sun, start, end)` | 冬至（太陽黄経270°）を返す |
| `buildLunarMonths(cycleMoons, zhongqi)` | 月情報構築（純粋関数） |
| `assignMonthNumbers(months)` | 月番号割り当て・閏月判定（純粋関数） |
| `getLunarDate(sun, moon, jdTdb)` | グレゴリオ JD → 農暦月日（メイン関数） |

#### 紫微斗数フォーム変更
- 農暦手動入力（`type="date"` に旧暦年月日）→ グレゴリオ暦 `type="date"` + `type="time"` (JST) に変更
- 農暦年月日は BSP 計算で自動変換して表示
- 冬至 JD・朔 JD も JST に変換して表示

---

## [2026-03-30] E-1: 日付・暦変換メニュー実装

### 変更ファイル
- `public/index.html` — プレースホルダーを実フォームに置き換え。ナビの「準備中」表示を削除
- `src/app.js` — `form-cal-conv` ハンドラー追加。`astroYearToHistorical` / `historicalYearToAstro` をインポート追加

### 実装内容

任意の日付（BC年含む）をユリウス暦 / グレゴリオ暦 / JD / MJD / Unix タイムスタンプに相互変換する。

| 出力項目 | 説明 |
|---|---|
| グレゴリオ暦 | 先発グレゴリオ暦（proleptic） |
| ユリウス暦 | 歴史的記録・1582年以前の標準 |
| JD（ユリウス日） | 天文計算基準 |
| MJD（修正ユリウス日） | JD − 2400000.5 |
| Unix タイムスタンプ | 1970-01-01 00:00:00 UTC 起算（秒） |

- 1582年10月5〜14日（改暦欠番）を入力するとエラーメッセージを表示
- BSP ファイル不要（純粋な日付計算）
- 既存の `dateToJd()` / `jdToDate()` を流用。新規計算ロジックなし

### テスト
- J2000.0（JD 2451545.0）✅
- MJD・Unix タイムスタンプ ✅
- BC 年（ユリウス暦 BC45-01-01）の往復変換 ✅
- 改暦欠番チェック（1582-10-10 グレゴリオ）→ 例外 ✅

---

## [2026-03-26] 逆行マーク（℞）表示 & シジジー計算実装

### 背景

Python 版 spacefield では逆行マークとシジジー（朔望）が表示されていた。
Stella-JS のホロスコープ表（3-1-1 / 3-2-1）に同等の情報を追加した。

### 変更内容

| # | ファイル | 変更内容 |
|---|---|---|
| 1 | `src/chart/transits.js` | `calcSyzygy()` 関数追加（直前の朔/望を二分探索で検出） |
| 2 | `src/index.js` | `calcSyzygy` を public API として re-export 追加 |
| 3 | `src/app.js` | 3-1-1 / 3-2-1 ホロスコープ表に逆行中 `℞` マーク追加（`lonspeed < 0` で判定） |
| 4 | `src/app.js` | 3-1-1 / 3-2-1 ホロスコープ表の末尾にシジジー行（朔/望の黄経・種別）追加 |
| 5 | `test/chart/syzygy.test.js` | **新規作成**: 6テスト（朔/望検出・null・境界ケース） |

### 実装詳細

**`calcSyzygy(sunCalcFn, moonCalcFn, jdTdb, opts):`**
- 指定 JD から最大 30 日分を 0.5 日刻みで遡り、太陽-月の黄経差（0° → 朔、±180° → 望）のゼロ交差を探す
- ゼロ交差が見つかったら二分探索で精密化（精度 0.01 時間）
- 返り値: `{ jd, lon, type: 'new_moon' | 'full_moon' }` または `null`

**バグ修正（二分探索エッジケース）:**
- 朔が丁度ステップ境界に来た場合（`loE = 0`）に探索方向が逆転するバグを修正
- `(loE >= 0) === (midE >= 0)` → `(loE <= 0) === (midE <= 0)` に変更

### テスト結果

```
▶ calcSyzygy: 6/6 pass
```

---

## [2026-03-30] 天体暦カバー範囲チェック実装（エラーハンドリング強化）

### 背景

JPL DE440s.bsp は 1850〜2150年 の範囲しかカバーしていないが、
範囲外の日付が入力された場合でも `bsp-reader.js` が投げるエラーは
「SSB からのチェーンが見つかりません」という汎用メッセージで、
ユーザーには何が起きたか伝わらなかった。

### 変更内容

| # | ファイル | 変更内容 |
|---|---|---|
| 1 | `src/core/bsp-validator.js` | **新規作成**: `getCoverageJd` / `assertInCoverage` / `formatCoverageMessage` の3関数 |
| 2 | `src/app.js` | `computeApparent()` 冒頭（step 0）に `assertInCoverage` 追加 |
| 3 | `src/index.js` | `bsp-validator.js` の3関数を public API として re-export 追加 |
| 4 | `test/core/bsp-validator.test.js` | **新規作成**: モックBspFileを使った12テスト（全パス）|

### エラーメッセージ例

```
RangeError: 天体暦の範囲外です（AD2200）。この天体暦がカバーする範囲: AD1850〜AD2150。
```

### 技術的ポイント

- BSP セグメントの `startJd`/`endJd` は「J2000.0 からの**秒数**」であり Julian Date ではない。
  このモジュールで `JD = J2000_JD + seconds / 86400` に変換してから範囲判定を行う。
- 代表天体として NAIF 10（太陽）のセグメントを使用。太陽は全惑星で最広カバーを持つため
  他天体の範囲もこれに包含される。NAIF 10 が存在しない BSP の場合は全セグメントからフォールバック。
- `RangeError` を throw することで既存の `try/catch` がそのまま拾える（UI 改修不要）。
- 単体責任原則に従い `bsp-reader.js` へは一切手を入れていない。

---

## [2026-03-26] ΔT テーブルを IERS 実測値で更新（C-1 完了）

### 背景

Espenak & Meeus 2006 多項式（2005〜2050）は「うるう秒が今後も追加され続ける」前提で導出されており、
2016年12月31日以降うるう秒の追加が止まったことで **2026年に +5.85 秒の系統誤差**が発生していた。
これが春分計算における Skyfield との「残り6秒差」の正体だった。

### 変更内容

| ファイル | 変更内容 |
|---|---|
| `src/core/constants.js` | `MODERN_DT` テーブル追加（2017〜2030 年・IERS Bulletin A 実測値） |
| `src/core/timescale.js` | `deltaT()` に分岐追加: year ≥ 2017 → 線形補間、未満 → 多項式 |
| `src/core/timescale.js` | `_linearInterpDt()` ヘルパー追加（テーブル端外挿対応）|

### 精度改善

| | 修正前 | 修正後 |
|---|---|---|
| ΔT(2026) | 75.07秒（多項式） | 69.22秒（IERS実測） |
| 誤差 | +5.85秒 | < 0.5秒 |
| 春分時刻（2026） | 23:45:51 JST | **23:45:57.55 JST** |
| Skyfield との差 | 6秒 | **0.55秒** |
| 国立天文台との差 | 9秒 | **2.45秒** |

### なぜ多項式が乖離したか

```
2016-12-31: 最後のうるう秒（ΔAT = 37秒）
TT − UTC = 37 + 32.184 = 69.184秒（以降変化なし）
ΔT = TT − UT1 ≈ 69.184 − ΔUT1 ≈ 69.0〜69.4秒（IERS管理）

多項式の予測: 毎年 +0.56秒ずつ増加 → 2026年 = 75.07秒（実際 69.22秒）
```

---

## [2026-03-26] トポセントリック補正 + 光偏差補正を実装（優先度 A 完了）

### 変更内容

| # | ファイル | 変更内容 |
|---|---|---|
| 1 | `src/astro/coordinates.js` | `observerGCRS(lat, lon, elevKm, jdUtc)` 追加（WGS-84 楕円体 → GCRS/ICRS [km]） |
| 2 | `src/astro/coordinates.js` | `applyLightDeflection(ax,ay,az,sunX,sunY,sunZ)` 追加（太陽重力場光偏差、IERS 2010 一次近似）|
| 3 | `src/app.js` | `computeApparent(naifId, jdTdb, opts={})` に `opts.observer` / `opts.jdUtc` 追加 |
| 4 | `src/app.js` | `bodyAltitude()` / `bodyAltAz()` をトポセントリック補正対応に更新 |
| 5 | `src/index.js` | `observerGCRS` / `applyLightDeflection` をエクスポート追加 |

### 精度改善

| 天体 | 補正前（地心誤差） | 補正後 |
|---|---|---|
| **月** | 黄経 ~27' + 黄緯 ~35'（合計 ~44'）| < 1" |
| 太陽 | ~8.79" | < 0.01" |
| 木星 | ~1.3" | < 0.01" |
| 外惑星 | < 1" | 無視可 |

### アーキテクチャ（後方互換）

`computeApparent(naifId, jdTdb)` の既存呼び出し（太陽黄経・占星術等）は**変更なし**。  
`bodyAltAz()` / `bodyAltitude()` / `findRiseTransitSet()` のみ自動的にトポセントリック補正が有効になる。

---

## [2026-03-26] 速度ベクトル法光行差補正を実装（Skyfield 完全互換）

### 変更内容

`src/astro/coordinates.js` に速度ベクトル法による年周光行差補正関数 `applyAberration()` を追加。`src/app.js` の `computeApparent()` を Skyfield 互換フローに変更。

| # | 対象 | 変更前 | 変更後 |
|---|---|---|---|
| 1 | `coordinates.js` | `annualAberration()` Meeus Eq.23.2 スカラー近似 | `applyAberration()` 速度ベクトル法（相対論的一次近似）追加 |
| 2 | `app.js` `computeApparent()` | 黄道変換後にMeeus近似 | 地球速度取得 → ICRS空間で光行差 → 黄道変換（Skyfield互換順序）|
| 3 | `annualAberration()` | 現役 | 非推奨（`@deprecated`）、後方互換のため存続 |

### 精度改善

- **春分時刻 (2026/03/20): 23:45:51 JST** — 国立天文台 23:46 JST と **9秒差**（改修前: 13秒差）
- Skyfield 23:45:57 JST との差: **6秒**（残差 ~0.22" は Skyfield の光偏差補正によるもの）
- 光行差計算精度: Meeus 近似 ~0.4" → 速度ベクトル法 < 0.001"（**約400倍向上**）

### アルゴリズム（Skyfield `earthlib.py` 互換）

```
β  = v_earth / c   （ICRS 重心速度ベクトル、有限差分 ±0.5秒で取得）
u' = (u + β) / (1 + u·β)   （相対論的一次近似）
```

### 精度ロードマップ（残差の原因）

| 残差原因 | 大きさ | 対処方法 |
|---|---|---|
| 光偏差（重力場での光の曲がり）| ~0.2" / ~6秒 | Skyfield方式の deflectors 実装（将来） |
| IAU 2000B vs IAU 2000A 章動 | < 0.001" | 無視可（占星術用途では十分） |
| 二次相対論的光行差補正 | < 0.001" | 無視可 |

---

## [2026-03-26] 高精度天文計算エンジン最終実装（IAU 2006 Capitaine 3角度歳差 + IAU 2000B 77項章動）

### 変更内容

`src/astro/coordinates.js` の座標変換エンジンを刷新。`icrsToEcliptic()` および `nutationAngles()` を IAU 最新モデルに完全置換し、フレーム整合性を達成。

| # | 対象 | 変更前 | 変更後 |
|---|---|---|---|
| 1 | `nutationAngles()` | 5項近似（Meeus Ch.22 簡易版）| IAU 2000B 全 77 項テーブル（IERS Conventions 2010 / Mathews et al. 2002） |
| 2 | `icrsToEcliptic()` 歳差 | Lieske 1977 / IAU 1976 3回転行列 | IAU 2006 Capitaine 3角度歳差（Capitaine et al. 2003 Eq.37，Skyfield互換） |
| 3 | `_IAU2000B_NUT77` テーブル | ― | 77行×11列の定数テーブル追加（`[n_l, n_lp, n_F, n_D, n_Ω, AA, BB, CC, DD, EE, FF]` 列順）|
| 4 | `_nutFundArgs()` | IAU 1980 基本引数 | IAU 2006 / IERS Conventions 2010 版基本引数（T⁴次項を含む） |

### 精度改善

- 章動: IAU 2000B 77項による高精度計算（IAU 1980との差 < 10 mas）
- 歳差: Capitaine 3角度モデルで Skyfield の precession 行列と完全一致（差 < 0.000001"）
- **春分時刻 (2026/03/20): 23:45:47 JST — 国立天文台発表 23:46 JST と 13秒差（改修前: 2分14秒差）**
- Python/Skyfield（de440s.bsp）との黄経差 < 0.5"（残差はMeeus近似光行差によるもの）

### 経緯

IAU 2006 Fukushima-Williams 4角度歳差（中間実装）と IAU 1980 章動の組み合わせに**フレーム不整合**が存在し、黄経に~5.5"の系統誤差が発生していた。これが春分時刻の~2分14秒誤差の直接原因。

Skyfieldのソースコード解析により、Skyfieldは Capitaine et al. 2003 Eq.37 の3角度定式化（ψ_A, ω_A, χ_A, ε₀）を使用していることを特定し、同一モデルに統一することで誤差を解消。

### アルゴリズム

**IAU 2006 Capitaine 3角度歳差行列（Skyfield `compute_precession` 準拠）**:
```
P = R₃(χ_A)·R₁(−ω_A)·R₃(−ψ_A)·R₁(ε₀)
```
ε₀ = 84381.406"（J2000.0 平均傾斜角定数），ψ_A・ω_A・χ_A は Capitaine 2003 Eq.37 の多項式

**IAU 1980 63項章動（Meeus Table 22.A）**:
```
arg = n_l·l + n_lp·l' + n_F·F + n_D·D + n_Ω·Ω
ΔΨ = Σ (S + Sd·T) sin(arg)   [0.0001"]
Δε = Σ (C + Cd·T) cos(arg)   [0.0001"]
```

### テスト

- `coordinates.test.js` に `nutationAngles` 用 Meeus 22.a 検証テスト追加
- `icrsToEcliptic` T=0/T=+1 テスト期待値を新モデルの正確な値に更新
- 全 293 テストグリーン

---

## [2026-03-29] Planet-Physics バグ修正（進捗停止 + 結果未表示）

### 修正内容

| # | 場所 | バグ | 修正 |
|---|---|---|---|
| 1 | `form-phys-planet` ハンドラー | `nSteps = Math.ceil(...) + 1` がループ実際の反復回数より1多く、進捗が途中で止まる（例: 6日間/7日ステップ → 永遠に50%） | `Math.floor(差分/step + 0.001) + 1` に変更し、while ループ条件と一致させた |
| 2 | 角速度（ω）中央差分ループ | `prev?.lon !== null` が `prev=null` のとき `undefined !== null = true` になり誤って if ブロックに入り、`prev.lon` で TypeError。非同期ハンドラー内でサイレントにクラッシュし `showResult` が呼ばれず結果が永遠に表示されない | `!== null`（厳密等価）→ `!= null`（緩い等価）に変更し、`undefined` と `null` を同一視 |

### 技術詳細

**バグ 1: nSteps の計算式ズレ**

```
// 修正前
nSteps = Math.ceil((endJd - startJd) / stepJd) + 1
// → 6日間 / 7日step: Math.ceil(0.857) + 1 = 2  ← ループは1回しか回らないのに2と計算

// 修正後
nSteps = Math.floor((endJd - startJd) / stepJd + 0.001) + 1
// → 6日間 / 7日step: Math.floor(0.858) + 1 = 1  ← 実際のループ回数と一致
```

同時に `while (jd <= endJdTdb + stepJd * 0.001)` ループを  
`for (let i = 0; i < nSteps; i++) { const jd = startJdTdb + i * stepJd; }` に変更し、  
浮動小数点累積誤差も排除。

**バグ 2: optional chaining と厳密等価の組み合わせミス**

```javascript
// 修正前（prev = null のとき prev?.lon = undefined、undefined !== null = true で誤入場）
if (prev?.lon !== null && next?.lon !== null) {
  let d = next.lon - prev.lon;  // prev.lon → TypeError!
}

// 修正後（undefined != null = false で正しくスキップ）
if (prev?.lon != null && next?.lon != null) {
  let d = next.lon - prev.lon;  // prev が null なら到達しない
}
```

---

## [2026-03-29] UI 2カラムレイアウト改修 + 更新履歴の MD 自動読み込み

### 概要

- メインメニューを横並びタブから **折りたたみ式サイドバー（アコーディオン）** に変更
- 画面を **1/3 : 2/3 の2カラム構成**（サイドバー / コンテンツ）に再設計
- 更新履歴を `index.html` 直書きから **`public/CHANGELOG.md` の fetch 読み込み**に切り替え

### UI 変更詳細

| 変更前 | 変更後 |
|---|---|
| 横並び5タブ（nav#main-menu） | 折りたたみ式サイドバー（aside#sidebar） |
| タブ選択 → サブメニュー横並び | サイドバーアコーディオン展開 → 項目クリック |
| 1カラムレイアウト | CSS Grid 1fr:2fr（サイドバー / コンテンツ） |
| 最大幅 960px | 最大幅 1100px |
| 更新履歴: index.html 直書き | 更新履歴: public/CHANGELOG.md を fetch してレンダリング |

### 追加 CSS クラス

| クラス | 役割 |
|---|---|
| `#layout` | 2カラム CSS Grid（grid-template-columns: 1fr 2fr） |
| `#sidebar` | 左カラム、sticky 配置（スクロール追従） |
| `#content-area` | 右カラム |
| `.nav-group` | アコーディオングループ（`.open` クラスで展開） |
| `.nav-group-hd` | グループヘッダーボタン |
| `.nav-group-body` | 展開コンテンツ（`.open` 時 flex 表示） |
| `.nav-item` | サブ項目ボタン（`.active` で左ボーダーハイライト） |
| `.nav-chevron` | 開閉三角インジケーター（CSS rotate で向きを制御） |

### JS 変更詳細（src/app.js）

- `.tab-btn` / `.sub-btn` ハンドラーを削除
- `.nav-group-hd` クリック → `.nav-group.open` をトグル
- `.nav-item` クリック → タブ切替 + サブコンテンツ切替 + changelog 遅延読み込みを1ハンドラーに統合
- 末尾の独立した changelog リスナーを削除（nav-item ハンドラー内に統合）

### 更新履歴 MD 読み込み（public/CHANGELOG.md）

- `public/CHANGELOG.md` を新設（ユーザーが手書きするファイル）
- `loadChangelog()`: fetch → `_simpleMarkdown()` でレンダリング → `#changelog-content` に描画
- `_simpleMarkdown()`: 外部ライブラリ不要の軽量 MD パーサー（h1–h4 / ul / table / hr / bold / code / link 対応）
- 更新履歴タブを開いた時点で初回 fetch（2回目以降は `data-loaded` フラグによりスキップ）

---

## [2026-03-29] 基準物理天体暦 A. 惑星基準物理天体暦（Planet-Physics）実装

### 追加機能

| 機能 | 概要 |
|---|---|
| `computeFromCenter(naifId, centerNaifId, jdTdb)` | 任意の観測中心から見た天体の黄道座標（光行時間補正あり） |
| `downloadCsv(filename, data)` | 2次元配列を UTF-8 BOM 付き CSV としてブラウザダウンロード |
| Planet-Physics フォーム | 観測中心・期間・ステップ・対象天体を指定して連続物理量を出力 |

### 設計詳細

- **観測中心**: 地心（地球）/ 水星〜冥王星重心 / 月重心の 10 種から選択
- **対象天体**: 全天体（観測中心を自動除外）or 個別選択（計 11 天体）
- **ステップ幅**: 1時間 / 6時間 / 1日 / 3日 / 7日
- **出力カラム**: JST日時 | 天体 | λ [deg] | ω [deg/day] | β [deg] | r [AU]
- **角速度 ω**: ステップ隣接値の中央差分（BSP コール数を最小化）
- **行数警告**: 5000 行超で confirm ダイアログ / 20000 行超で強警告
- **CSV**: ヘッダー + メタコメント + データ、UTF-8 BOM 付きで Excel 対応
- **表示**: ブラウザには先頭 100 行 + 「全 N 行 は CSV で」メッセージ

### B・C を除外した理由

| サブメニュー | 判断 | 理由 |
|---|---|---|
| B. 商用イベント抽出 | 除外（将来オプション） | A が実装されれば B は A の派生。既存の惑星イングレス検索とも重複 |
| C. 太陽物理基準天体暦（SIRF / 銀河面） | 除外 | 非常に専門的。SSB・太陽系不変面座標系は一般ユーザーの需要が限定的 |

### Python 版との相違点

| 項目 | Python版 | JS版 |
|---|---|---|
| 光行差補正 | あり（Skyfield apparent） | なし（物理量として幾何学的位置を返す） |
| 出力形式 | MD + CSV ファイル保存 | ブラウザ CSV ダウンロード |
| ステップ下限 | 1分（警告あり） | 1時間（ブラウザ性能を考慮） |
| 行数上限 | 警告のみ（10万行超） | 5000行超で confirm |

---

## [2026-03-29] 月の交点（Lunar Nodes）実装

### 追加機能

| 機能 | 概要 |
|---|---|
| `moonNode(jdTdb)` | ノースノード・サウスノードの黄経を返す（Meeus IAU 式、平均交点） |
| `moonNodeSpeed(jdTdb)` | 数値微分による交点の角速度（度/日、常に逆行） |

### 実装詳細

- **平均交点（Mean Node）**:  
  `Ω = 125.04452° − 1934.136261°T + 0.0020708°T² + T³/450000`  
  Meeus "Astronomical Algorithms" Ch.22 / IAU 式。Python `calc_lunar_nodes` と同一。
- **統合箇所**: `form-natal`（ネイタルチャート）、`form-modern-transit`（期間トランジット）、`form-modern-aspects`（アスペクト計算）
- 惑星テーブルに ☊ ノースノード・☋ サウスノードを追加
- アスペクト計算にも自動参加（他惑星との合・衝・トライン等を検出）

### Python 版との相違点

| 項目 | Python版 | JS版 |
|---|---|---|
| アルゴリズム | Meeus IAU 式（平均交点） | Meeus IAU 式（平均交点）★同一 |
| 真交点（True Node） | 未実装 | 未実装（摂動補正を追加すれば ±0.1° 精度で算出可能） |
| データソース | BSP 非依存・解析式 | BSP 非依存・解析式 |

---

## [2026-03-29] ヘリオ占星術・東洋占術・ボイドタイム 実装（3-3〜3-5）

> **注記**: 3-6 時代考証ホロスコープは **除外**。  
> 理由: DE440s の収録範囲（約 BC3000〜AD3000）を古代年で使用するとセグメント外エラーが発生するため。

### 追加機能

| No. | 機能名 | 概要 |
|---|---|---|
| 3-3-1 | ヘリオ黄道座標 & アスペクト | 日心9惑星の黄道座標とアスペクトを算出 |
| 3-3-2 | 日心アスペクト時系列 | 任意2惑星間の日心アスペクト通過時刻を期間検索 |
| 3-4-1 | 四柱推命 命式スケルトン | 立春基準・節気月柱で四柱を算出 |
| 3-4-2 | 紫微斗数 命盤スケルトン | 命宮・身宮・五行局・十四主星配置を算出 |
| 3-5 | 月のボイドタイム | 月が最後のアスペクト〜次イングレスまでを全期間検出 |

### 設計上のポイント

**3-3 ヘリオ占星術:**
- 日心9惑星: 水星・金星・地球・火星・木星・土星・天王星・海王星・冥王星（太陽を含まない）
- `computeHeliocentric(naifId, NAIF.SUN, jdTdb)` を利用し地心と同一のコードベースを共有
- 時系列は既存の `detectAspectCrossings` を日心計算関数に差し替えて再利用

**3-4 東洋占術:**
- 四柱推命: Python `sexagenary.py` をそのまま移植。節気の通過時刻は太陽黄経（315°, 345°, 15°, …, 285°）の二分探索で決定
- 年柱の立春調整も実装（生年と立春前後で実効年を切り替え）
- 紫微斗数: ユーザーが農暦の生年月日を入力。命宮支 = (農暦月 + 1 - 時支 + 12) % 12
- 五行局は60甲子テーブル参照、紫微星 = (農暦日 - 1) / 五行局 % 12

**3-5 ボイドタイム:**
- Python `void_of_course_calc.py` のアルゴリズムを移植
- ① 2時間サンプリング + 二分探索で月イングレスを検出
- ② 各星座滞在区間で1時間サンプリング + 二分探索でアスペクト exact 時刻を走査
- ③ 区間内最後のアスペクト = ボイド開始、次のイングレス = ボイド終了
- 計算期間の上限: 31日（Python 版と同一）

### Python 版との相違点

| 項目 | Python 版 | Stella-JS |
|---|---|---|
| 紫微斗数の農暦変換 | 天文計算で農暦日を自動算出 | ユーザーが農暦日を直接入力 |
| ボイドタイム: アスペクトステップ | 30分 | 1時間（UI 速度のため） |
| 時代考証ホロスコープ | 実装済み | **除外**（DE440s 収録範囲外エラーのため） |

### 単体テスト結果

```
✅ 四柱推命算術テスト: 年柱 庚午 (1990) JDN=2448027 時支=未 — 全合格
✅ ヘリオ黄道経度: 地球日心経度 ≈ 太陽地心経度+180° (差分 0.000°)
✅ 月イングレス検出: 2024/01/04〜01/10 で蠍座・射手座イングレスを正確検出
```

---

## [2026-03-29] 現代西洋占星術モード 残機能実装（3-1-2〜4）

### 追加機能

| No. | 機能名 | 概要 |
|---|---|---|
| 3-1-2 | 期間トランジット | 太陽黄経の角度中点を二分探索→代表日時のホロスコープ（全ハウス系・星座系対応） |
| 3-1-3 | 惑星星座運行計算 | 10惑星の30°星座境界通過を二分探索で検出（順行/逆行判定・角速度付き） |
| 3-1-4 | アスペクト計算 | 指定日時の全惑星ペアアスペクト（オーブ選択・接近/離脱判定付き） |

### アルゴリズム（期間トランジット）
- Python版と同方針：太陽黄経の角度中点（360°境界対応）を求め、その黄経を太陽が通過する日時を二分探索
- 期間が月内であれ長期であれ同一関数で処理（Python版の角度中点基準法に相当）

### 単体テスト結果

```
✓ solarAngularMidpoint: 2024-01 279.657° → 311.176° → 中点 295.416°
✓ 境界中点 350°→10°: 0.000°（0°/360°境界を正しく処理）
✓ 2000-01-01 アスペクト数（オーブ±6°）: 11 件
```

---

## [2026-03-29] 中世西洋占星術モード 実装（3-2）

### 追加機能

| No. | 機能名 | 固定設定 |
|---|---|---|
| 3-2-1 | ホロスコープ計算（カンパヌス式・トロピカル固定） | 7惑星（太陽〜土星）・角速度・古典5アスペクト（オーブ8°） |
| 3-2-2 | 惑星星座運行計算（イングレス） | 12星座境界（0°〜330°）通過検出・順行/逆行判定 |

### 設計上の差異（Python版との比較）

| 項目 | Python版 | JS版 | 理由 |
|---|---|---|---|
| 観測方式 | トポセントリック（視差あり） | 地心（geocentric） | DE440s から直接視差補正は非実装。差は月で最大数10秒 |
| 月のノード | 北交点・南交点を含む | **実装済み**（Meeus IAU 式） | BSP 不要・解析式で Python と同一アルゴリズム |

### 新規追加ファイル・関数

| ファイル | 追加内容 |
|---|---|
| `src/app.js` | `MEDIEVAL_PLANETS`・`MEDIEVAL_INGRESS_STEP` 定数、ホロスコープハンドラー・イングレスハンドラー各1件 |
| `public/index.html` | `astro-medieval` div に2サブメニュー・2フォームを追加 |

### 単体テスト結果

```
✓ housesCampanus: ASC = 23.391° / MC = 283.858°（2000-01-01 12:00 JST 東京）
✓ getHouseNum(ASC) = 1（一致）
✓ 7惑星（太陽〜土星）黄経計算: 全通過
  - 太陽:279.992° 月:218.808° 水星:271.312° 金星:241.117°
  - 火星:327.676° 木星:25.236° 土星:40.400°
✓ 牡羊座イングレス検出: 太陽 2024-03-19(358.88°) → 2024-03-21(0.87°) で 0° 境界通過
```

---

## [2026-03-29] 天体観測モード 6機能 実装

### 追加機能

| No. | 機能名 | アルゴリズム |
|---|---|---|
| 1 | 月相イベント（8相検出） | 月-太陽角 45°刻み二分探索 |
| 2 | 月相連続変化（照度・位相角） | N時間ごとサンプリング |
| 3 | 太陽の出没時刻 | 地平高度 −0.833° 二分探索（期間入力対応） |
| 4 | 月の出没時刻 | 同上（月、最大90日） |
| 5 | 天体風景（高度・方位） | 全天体の高度・方位角・黄経・距離 |
| 7 | 24節気カレンダー | 太陽黄経 15°刻み二分探索（前年12月〜翌年1月検索） |

### 新規追加ファイル・関数

| ファイル | 追加内容 |
|---|---|
| `src/astro/coordinates.js` | `altitudeAzimuth(ra, dec, jdUtc, obsLat, obsLon)` |
| `src/index.js` | `altitudeAzimuth` を re-export に追加 |
| `src/app.js` | `bodyAltitude`, `bodyAltAz`, `findRiseTransitSet`, `calculateMoonPhases`, `calculateMoonPhaseContinuous`, `calculateSolarTerms` の各純粋関数と6ハンドラー |
| `public/index.html` | 月相連続変化フォーム、月の出没フォーム、天体風景フォームを追加。太陽の出没を日付範囲入力に変更 |

### 単体テスト結果

```
テスト: altitudeAzimuth（南中時）
  alt = 74.30°（期待値 74.30°）✓
  az  = 180.00°（南）✓
```

---

## [2026-03-29] 精度検証：2026年春分 Python 版との比較

### 検証結果

| 実装 | 春分通過時刻（JST）| 差分 |
|---|---|---|
| Python 版（Skyfield） | 2026/03/20 23:45:57 | — |
| Stella-JS | 2026/03/20 23:46:48 | **+51秒** |

### 原因

51秒 ≈ 座標残差 **2.1"**（1°/日 換算）。

1983年条件では 0.6" だったが、2026年では 2.1" に拡大。章動の主要項（18.6年周期）の位相差が原因。
IAU 2006 + 106項章動への換装で < 0.1"（< 10秒）まで改善可能。詳細は `architecture.md` 参照。

---

## [2026-03-29] 8. 太陽黄経暦（1° 刻み）実装

### 追加機能

| 項目 | 内容 |
|---|---|
| 入力 | 対象年（1900〜2100）|
| 出力 | 360行（各 1° 通過時刻・節気・区分・星座・速度・滞在時間） |
| アルゴリズム | Python版 `calculate_solar_longitude_almanac()` と同方式。年初の黄経から昇順に各 1° の通過 JD を二分探索（精度 0.01h）|
| 速度 | ±0.5日差分（°/日）、ラップアラウンド対応 |
| 滞在時間 | 前の度数からの経過時間（Xday XXhXXm 形式）|
| 節気ハイライト | 24節気行を紫背景でハイライト |
| 節気定数 | `SOLAR_TERMS_BY_LON`（24節気・黄経→名称・節/中気） |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/app.js` | `SOLAR_TERMS_BY_LON`・`calculateSolarAlmanac()` 追加、form-solar-cal 実装 |

---

## [2026-03-29] 7. 任意境界角度通過検出 実装

### 追加機能

| 項目 | 内容 |
|---|---|
| 天体選択 | 太陽〜冥王星 + 全天体一括 |
| プリセット | 30°(12分割)・45°(8分割)・60°(6分割)・90°(4分割) |
| カスタム | カンマ区切り複数入力（例: 0,15,30,90）|
| 日時 | datetime-local（JST）|
| 検出方式 | `deviation = ((lon − boundary + 180) % 360) − 180` の符号反転 → 二分探索（精度 0.01h）|
| スキャンステップ | 月含む場合 0.1日、それ以外 0.25日 |
| 出力 | 日時（JST）・天体・境界°・λ°・ω(°/day)・逆行フラグ |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/app.js` | `detectBoundaryCrossings()`・`BOUNDARY_PRESETS`・`BOUNDARY_PLANETS` 追加、form-boundary 実装 |
| `public/index.html` | 天体選択を全惑星対応・60°追加・datetime-local・カスタムをカンマ区切りに変更 |

---

## [2026-03-29] マイナーアスペクト4種追加（Python版と同等）

### 追加内容

| 角度 | 名称 | 記号 | 対称角 |
|---|---|---|---|
| 30° | セミセクスタイル | ⚺ | 330° |
| 45° | セミスクエア | ∠ | 315° |
| 135° | セスキスクエア | ⚼ | 225° |
| 150° | クインカンクス | ⚻ | 210° |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/app.js` | `ASPECT_DEFS` に 30°/45°/135°/150° を追加 |
| `public/index.html` | アスペクト選択チェックボックスに4種を追加 |

---

## [2026-03-29] 6. 惑星間アスペクト時系列 実装

### 追加機能

| 項目 | 内容 |
|---|---|
| 天体 A/B | 太陽〜冥王星（10天体） |
| アスペクト種 | 合・セクスタイル・スクエア・トライン・オポジション（複数選択チェックボックス） |
| 検出方式 | `deviation = normAngle(λA−λB) − target` の符号反転を 1日刻りスキャン → 二分探索（精度 0.01h） |
| 対称角 | セクスタイル(60°/300°)・スクエア(90°/270°)・トライン(120°/240°)を両方検出 |
| スキャンステップ | 相対角速度から自動算出（4°/relSpeed、0.3〜20日にクリップ） |
| 出力 | 日時（JST）・アスペクト記号・両天体λ(°)・分離角。全アスペクトを時刻順にソート |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `public/index.html` | 天体選択を全惑星に拡充、アスペクト種チェックボックス追加、datetime-local に変更 |
| `src/app.js` | `ASPECT_DEFS`・`ASP_PLANET_MAP`・`detectAspectCrossings()`・ハンドラー追加 |
| `public/style.css` | `.checkbox-group`・`.form-row-top` スタイル追加 |

---

## [2026-03-29] 逆行期間計算 サブメニュー拡張（#3・#4 追加）

### 追加機能

| # | 機能 | 出力 |
|---|---|---|
| 3 | 物理量逆行計算（天文学用） | 生λ(°)・ω(°/day)・ピーク逆行速度(°/day)・Δλ(°)・期間。星座ラベルなし |
| 4 | 逆行連続物理量計算 | 逆行期間中の時系列 λ(°) / ω(°/day)。ステップ: 1時間/6時間/1日/3日 |

### 構造変更

- `astro-retro` を `sub-menu-2` / `sub-content-2` で3タブに分割
- 既存の #1 地心固定逆行計算は変更なし（`form-retro` / `result-retro` の ID 維持）

### 追加関数（app.js）

| 関数 | 責務 |
|---|---|
| `buildRetroPhysicalTable()` | #3 用テーブル HTML 生成（純粋関数） |
| `buildRetroContinuousSection()` | #4 用時系列テーブル HTML 生成（純粋関数） |

---

## [2026-03-29] 3. 逆行期間計算 実装

### 追加機能

| 項目 | 内容 |
|---|---|
| 計算対象 | 水星〜冥王星（8天体） |
| 検出方法 | `detectStationPoint` (transits.js) を繰り返し呼び、全留点を収集 |
| 表示内容 | 逆行開始・終了日時（JST）・黄経（星座表記）・逆行幅 Δλ・期間（日）|
| 座標系 | `settings.coordSystem` に連動（of-date / J2000.0） |
| 精度 | 留点の精度 ±0.5 時間（`detectStationPoint` の二分探索） |
| 部分逆行 | 検索期間の前後にまたがる逆行は「期間開始前」「期間終了後」として表示 |

### 追加ヘルパー関数（app.js）

| 関数 | 責務 |
|---|---|
| `dateStrToJdTdb(dateStr)` | "YYYY-MM-DD" → JD TDB（正午 UTC） |
| `jdToJstStr(jd)` | JD → "YYYY/MM/DD HH:MM JST" 文字列 |
| `makeRetroCalcFn(naifId)` | bspFile closure + 1時間差分 → `{ lon, lonspeed }` |
| `detectAllStations(calcFn, startJD, endJD)` | 全留点を反復検出 |
| `groupRetrogradePeriods(stations)` | 留点をD→R/R→Dペアに変換 |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/app.js` | 上記ヘルパー追加、`RETRO_PLANET_INFO` 定数、`form-retro` ハンドラー、未実装リストから除外 |

---

## [2026-03-29] 2. 太陽系計算（日心）実装

### 追加機能

| 項目 | 内容 |
|---|---|
| 計算対象 | 水星・金星・地球（EMB）・火星・木星・土星・天王星・海王星・冥王星 |
| 表示内容 | 黄経（of-date / J2000.0）・黄緯・太陽からの距離 (AU)・公転速度 (km/s) |
| 座標系 | 設定タブの「座標系」セレクタに連動（地心計算と共通） |
| 公転速度 | 1時間中心差分（|Δr| / 3600 s）で近似 |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/app.js` | `computeHeliocentric()` 追加、`HELIOCENTRIC_PLANETS` 定義、`form-helio` ハンドラー追加、未実装リストから除外 |

---

## [2026-03-29] 座標変換精度向上（Python/Skyfield との誤差 < 1"）

### 改修背景

検証条件（1983/07/05 15:42 JST、千葉県松戸市）で Python 版（spacefield/Skyfield）との黄経差が **37.2"** あることを発見。物理精度優先の方針から全面的に修正。

### 差分原因の特定

| 段階 | 追加した補正 | 残差 |
|---|---|---|
| 修正前（旧実装：ψ_A スカラー加算のみ） | — | 37.2" |
| 完全歳差行列（Lieske 1977 / Meeus Ch.21） | icrsToEcliptic 書き直し | 16.7"（黄緯は 0.000" に一致） |
| 光行時間補正 τ = dist/c | computeApparent() 追加 | ～16.7"（太陽は効果小） |
| 年周光行差（Meeus Ch.23 Eq.23.2） | annualAberration() 追加 | 16.0" |
| 章動 ΔΨ, Δε（IAU 1980 主要 5 項） | nutationAngles() 追加 | **0.60"** ← 達成 |

### 修正ファイル

| ファイル | 変更内容 |
|---|---|
| `src/astro/coordinates.js` | `icrsToEcliptic()` を歳差行列 + 章動 + 真傾斜角で全面書き直し。`nutationAngles()` / `annualAberration()` を新規追加 |
| `src/app.js` | `computeApparent()` ヘルパーを追加。惑星位置計算とホロスコープ計算の両方に適用 |
| `src/index.js` | `annualAberration` / `nutationAngles` を公開 API に追加 |

### 最終精度（2026-03-29 時点）

```
条件: 1983/07/05 15:42 JST（千葉県松戸市）
                  Python/Skyfield     Stella-JS       差分
太陽黄経 (of-date): 102.694636°       102.694471°     −0.60"
太陽黄緯:           −0.000077°        −0.000077°       0.000"
占星術表記:         蟹座 12.695°      蟹座 12.694°     実用上同一
```

### 残差の内訳（0.60"）

- 章動モデル差（5項 vs 106項 IAU 1980）: ~0.2"
- 歳差モデル差（IAU 1976 vs IAU 2006 F-W）: ~0.4"

→ 詳細は `architecture.md`「改修予定: IAU 2006 歳差 + IAU 1980 全章動への換装」参照

---

## [2026-03-29] Layer 4 UI 改修・バグ修正

### バグ修正

| # | 対象 | 症状 | 原因 | 修正 |
|---|---|---|---|---|
| 1 | `src/app.js` | 他タブで計算ボタンを押すと天文計算タブに戻る | 未実装フォーム8個に `submit` ハンドラなし → ページリロード | 未実装フォーム一括に `e.preventDefault()` ＋「実装予定」表示を登録 |
| 2 | `src/app.js` | ホロスコープ計算でボタンを押しても無反応 | `getAllAspects` の戻り値キーが `body1`/`body2` ではなく `planet1`/`planet2` | `a.body1.id` → `a.planet1` に修正 |
| 3 | `src/app.js` | ASC/MC が `undefined NaN° NaN'` | `housesXxx()` の戻り値 `angles` は配列 `[asc, mc, desc, ic]`。`.asc` プロパティは存在しない | `angles.asc` → `angles[0]`、`angles.mc` → `angles[1]` |
| 4 | `src/app.js` | アスペクト種別が `undefined` | `analyzeAspect` の戻り値に `symbol` プロパティはなく、`type`（角度数値）のみ | `ASPECT_SYMBOL` マップ `{ 0:'☌', 60:'⚹', 90:'□', 120:'△', 180:'☍' }` を追加 |
| 5 | `src/app.js` | アスペクト状態が全件「stationary」 | 単一日時計算では速度が 0 → `abs(speed) < 0.001` が常に true | 単一日時ではアスペクトに速度情報がないため「状態」列を削除 |

### 設計変更

| 変更 | 内容 |
|---|---|
| 天文計算モードの星座系セレクタ削除 | 「J2000.0固定」は星座系（トロピカル/サイデリアル）とは別次元（座標エポック）のため削除。天文計算は IAU of-date 固定。J2000 モードは将来の設定タブへ |
| 星座系に「フェーガン・ブラッドレー」追加 | 占星術モード（ホロスコープ計算）の星座系ドロップダウンに追加 |
| アスペクト種別ラベルを記号＋名称に | `☌` → `☌ コンジャンクション` など |

### 機能追加

| 機能 | 内容 |
|---|---|
| 惑星テーブルにハウス番号列追加 | `getHouseNum(lon, cusps)` を実装。円形折り返し（H12 が 330°→20°）も考慮 |
| ASC / MC / DSC / IC 表示 | ハウスカスプヘッダに4アングル全表示 |
| 住所ジオコーディング | Nominatim API（OpenStreetMap）を使った住所 → 緯度経度変換。`geocodeAddress(query)` 純粋 fetch 関数として実装。帰属表示 `© OpenStreetMap contributors (ODbL)` を結果行に自動表示 |

### 表示精度統一

| 変更 | 内容 |
|---|---|
| 小数点以下3桁・切り捨て | `trunc3(n)` = `Math.trunc(n × 1000) / 1000`。黄経・黄緯・距離すべてに適用 |
| 星座内黄経表示 | 度分表記（`12°42′`）→ 小数3桁（`12.704°`）。黄経列との一貫性を確保 |

### オフライン対応（改修予定として記録）

- `spacefield/resources/latest.csv`（27万6,631行、都道府県・市区町村・緯度経度）を Nominatim 失敗時の fallback として使う計画
- 詳細は `architecture.md` の「改修予定: 住所ジオコーディングのオフライン対応」参照

---

## [2026-03-28] Layer 1〜3 実装完了 / Layer 4 着手

- 詳細は `architecture.md` の各レイヤー実装記録を参照
