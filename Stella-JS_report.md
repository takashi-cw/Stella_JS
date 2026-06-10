
sweep-check スキャン結果: /GitHub/Stella_JS
  スキャン日時: 2026-06-10 23:06:11 UTC
  .sweep-ignore 有効: 3 パターン / 3 ファイル除外
────────────────────────────────────────────────────────────
✅ Swiss Ephemeris 依存の疑いは検出されませんでした。

────────────────────────────────────────────────────────────

📋 ディレクトリ別分析
  すべてのディレクトリでシグネチャ一致なし

📊 総評
  ✅ 全体クリーン — Swiss Ephemeris 依存の疑いなし

📋 除外ルール台帳（.sweep-ignore）
  除外ファイル合計: 3 ファイル / 3 パターン

  パターン: docs/src/astro/houses.js
  理由    : 「歴史的実装（Swiss Ephemeris 等）と一致する定義」の説明コメント（独立実装の宣言）
  除外数  : 1 ファイル
             docs/src/astro/houses.js

  パターン: docs/src/astro/precession.js
  理由    : 「SE_SIDM_FAGAN_BRADLEY と同値だが、独立した公開天文値」の独立宣言コメント
  除外数  : 1 ファイル
             docs/src/astro/precession.js

  パターン: test/chart/aspects.test.js
  理由    : テストの基準値コメントに "flatlib props.py 準拠" の言及がある（計算検証の出典明示）
  除外数  : 1 ファイル
             test/chart/aspects.test.js

────────────────────────────────────────────────────────────
  本レポートは既知の Swiss Ephemeris 関連シグネチャに基づく静的検査であり、
  法的判断・派生性判定を行うものではない。
  TRUE / REVIEW / INFO は人間による確認を支援するための分類である。

