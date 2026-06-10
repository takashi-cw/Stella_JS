# Licensing Notes — Stella-JS

このドキュメントは、Stella-JS のライセンス適用根拠を説明するものです。  
プロジェクト全体のライセンス方針は  
`../LICENSING_NOTES.md`（Stella Series ルート）を参照してください。

法的効力を持つライセンス条文は `LICENSE` ファイルを参照してください。

---

## Stella-JS が MIT である根拠

Stella-JS は天体計算ライブラリです。MIT ライセンスを適用できる根拠は以下の通りです。

### Swiss Ephemeris との独立性

- Swiss Ephemeris（AGPL）のコードには **一切使用していない・一切触れていない**
- Swiss Ephemeris ライブラリには使用していない・触れていないため、実行時の **呼び出しようがない**
- 一次資料（球面三角法の標準定式・天文学文献）から **独立実装している**

### 計算の独立実装

すべての天体計算は以下の標準数式・規約に基づき、Stella-JS として独自に実装しています：

- VSOP87（惑星位置理論）
- IAU 規約（座標系・章動理論）
- 球面三角法の標準定式

### ライセンス衛生の確認

Stella-JS のソースコードは sweep-check によるスキャンを受けており、  
Swiss Ephemeris 関連シグネチャの検出結果は  
`../lab/sweep-check/Report/` に保存されています。

---

## 免責事項（MIT に加えて）

- Stella-JS が出力する天体位置・ハウスカスプ等の計算結果は **情報提供目的** であり、
  占星術的判断・法的判断の根拠として保証するものではありません。
- 計算精度は実装および使用する暦データの精度に依存します。

---

## 上位ドキュメント

- `../LICENSING_NOTES.md` — Stella Series プロジェクト共通のライセンス解釈方針
- `LICENSE` — MIT ライセンス条文（法的効力）
- `LICENSE.ja.md` — MIT ライセンス日本語参考訳

---

# Licensing Notes — Stella-JS (English Translation)

This document explains the license basis for Stella-JS.  
For the project-wide licensing policy, see `../LICENSING_NOTES.md`
(Stella Series root).

The legally binding license text is in the `LICENSE` file.

---

## Basis for MIT License in Stella-JS

Stella-JS is an astronomical calculation library. The grounds for applying the
MIT License are as follows.

### Independence from Swiss Ephemeris

- Has **never used or touched** any code from Swiss Ephemeris (AGPL)
- Has never used or touched the Swiss Ephemeris library — there is **no way it could be called** at runtime
- Is **independently implemented** from primary sources (standard spherical trigonometry formulas and astronomical literature)

### Independent Implementation of Calculations

All astronomical calculations are independently implemented in Stella-JS, based on
the following standard formulas and conventions:

- VSOP87 (planetary position theory)
- IAU conventions (coordinate systems, nutation theory)
- Standard spherical trigonometry formulas

### License Hygiene Verification

The Stella-JS source code has been scanned by sweep-check.  
The detection results for Swiss Ephemeris-related signatures are stored in  
`../lab/sweep-check/Report/`.

---

## Disclaimer (in addition to MIT)

- Calculation results produced by Stella-JS (planetary positions, house cusps, etc.)
  are provided **for informational purposes only** and are not warranted as the basis
  for astrological or legal judgments.
- Calculation accuracy depends on the implementation and the precision of the
  ephemeris data used.

---

## Parent Documents

- `../LICENSING_NOTES.md` — Stella Series project-wide licensing interpretation policy
- `LICENSE` — MIT License text (legally binding)
- `LICENSE.ja.md` — Japanese reference translation of the MIT License
