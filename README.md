# りんご力学 (Stella-JS)

JPL DE440s をブラウザ内で直接読み込む、高精度天文・占星術計算アプリ。  
サーバー不要。GitHub Pages で動作。スマートフォンにも対応。

🔗 **公開URL**: https://takashi-cw.github.io/Stella_JS/ （2026-03-31 公開）

---

## 特徴

- **JPL DE440s 直読み** — NASA の天体暦データ（.bsp）をブラウザ内で直接解析。再近似による精度劣化なし
- **サーバー不要** — 全計算がブラウザ内で完結。外部 API への通信なし
- **高精度** — 歳差（IAU 2006）・章動（IAU 2000B）・光行差・光行時間補正を実装
- **プライバシー保護** — 生年月日等の個人情報が外部に送信されることは一切ない
- **MIT ライセンス** — AGPL 汚染なし。商用・非商用を問わず自由に利用可能

---

## 実装済みメニュー

| カテゴリ | 機能 |
|---|---|
| 天文計算 | 惑星位置・星座判定、逆行検出、任意境界角度通過検出、合・衝・矩・最大離角 |
| 天文計算 | 基準物理天体暦（.txt ダウンロード）、暦変換計算 |
| 占星術 | ネイタルチャート、ホラリー占星術、中世西洋占星術（トポセントリック）|
| 占星術 | ヘリオセントリック占星術、ボイドオブコース |
| 四柱推命 | 四柱推命、紫微斗数 |
| 設定 | 座標系切替（of-date / J2000.0）、天体暦ファイル切替（BSP 選択）|

---

## アーキテクチャ

```
JPL DE440s (.bsp)  ← NASA（Public Domain）
  ↓
src/core/          ← DAF 解析 + Chebyshev 評価（jplephem 相当）
  ↓
src/astro/         ← 座標変換・歳差・章動・ハウス計算（Skyfield 相当）
  ↓
src/chart/         ← アスペクト・トランジット・月暦
  ↓
src/app.js         ← UI ロジック統合
  ↓
public/            ← GitHub Pages で静的配信
```

---

## ディレクトリ構造

```
stella-js/
├── src/
│   ├── core/
│   │   ├── bsp-reader.js       DAF ヘッダー解析 + SPK セグメント検索
│   │   ├── bsp-validator.js    BSP カバー範囲チェック
│   │   ├── chebyshev.js        Chebyshev 多項式評価（Clenshaw algorithm）
│   │   ├── constants.js        天文定数（obliquity, AU 等）
│   │   └── timescale.js        暦 ↔ JD 変換 + ΔT + 時刻系（UTC/TDB/TT）
│   ├── astro/
│   │   ├── coordinates.js      座標変換（ICRS → 黄道 → 赤道）
│   │   ├── precession.js       歳差・章動（IAU 2006 / IAU 2000B）
│   │   └── houses.js           ハウスカスプ計算（Placidus, Koch, Campanus 等）
│   ├── chart/
│   │   ├── aspects.js          アスペクト計算
│   │   ├── transits.js         トランジット・プログレス
│   │   ├── lunar-calendar.js   月暦・朔望
│   │   └── renderer.js         チャート描画（Canvas / SVG）
│   ├── app.js                  UI ロジック統合（メインファイル）
│   └── index.js                定数・パス定義
├── public/
│   ├── index.html              メイン UI
│   ├── help.html               ヘルプページ
│   ├── style.css               スタイル
│   ├── data/                   .bsp ファイル（.gitignore 対象）
│   └── CHANGELOG.md            変更履歴（公開用）
├── test/
│   ├── core/                   6 ファイル（221 テスト・全合格）
│   ├── astro/                  3 ファイル
│   └── chart/                  4 ファイル
├── scripts/
│   └── bsp_extractor.py        BSP 分割スクリプト（開発者用・Python）
├── docs/                       設計ドキュメント
├── package.json
├── .gitignore
├── DATA_ETHICS.md              データ倫理方針
├── LICENSE                     MIT
└── README.md                   本ファイル
```

---

## データ倫理

全計算はブラウザ内で完結します。生年月日等の個人情報が外部サーバーに送信されることはありません。  
詳細は [DATA_ETHICS.md](DATA_ETHICS.md) を参照。

---

## ライセンス

- **ソースコード**: MIT — 詳細は [LICENSE](LICENSE) を参照
- **計算結果データ（.txt 出力）**: CC BY-NC-SA 4.0 — 出力ファイルにライセンス情報が付記されます
- **JPL DE440s**: Public Domain（NASA）

---

## 関連

- [Skyfield](https://rhodesmill.org/skyfield/) — Python の天文計算ライブラリ（MIT）。本プロジェクトの設計参考
- [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) — NASA の天体位置計算サービス
- オンラインカウンセリングルーム「[しがたかしホッとライン](https://www.shigatkashi.com)」— 開発者
