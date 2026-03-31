"""
bsp_extractor.py
================
JPL DE440s / DE440 BSP ファイルから指定 JD 範囲のセグメントを抽出し、
軽量な BSP ファイルを生成するビルドスクリプト。

使い方:
    python3 scripts/bsp_extractor.py

出力:
    Stella-JS/public/data/de440s-modern.bsp   (~3 MB, 1873-01-01 ~ 2100-12-31)
    Stella-JS/public/data/de440-history.bsp   (~15 MB, 1550-01-01 ~ 1872-12-31)
    Stella-JS/public/data/de440-future.bsp    (~10 MB, 2101-01-01 ~ 2650-12-31)

設計方針:
    - 純粋関数（計算）と副作用関数（I/O）を分離する
    - Chebyshev 係数を再フィットしない（原本データをそのままコピー）
    - 絶対パスをハードコードしない（__file__ からの相対パスで解決）
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import numpy as np
from jplephem.spk import SPK
import spiceypy as spice

# ── パス解決 ─────────────────────────────────────────────────────────────
_SCRIPTS_DIR = Path(__file__).parent.resolve()
_STELLA_JS_DIR = _SCRIPTS_DIR.parent
_WORKSPACE_DIR = _STELLA_JS_DIR.parent
_CATALOGS_DIR = _WORKSPACE_DIR / "data" / "catalogs"
_OUTPUT_DIR = _STELLA_JS_DIR / "public" / "data"

# ── 定数 ─────────────────────────────────────────────────────────────────
J2000_JD = 2451545.0  # JD of J2000.0 epoch (2000-01-01 12:00 UTC)
FRAME_J2000 = "J2000"  # SPICE frame name for J2000


# ════════════════════════════════════════════════════════════════════════
# 純粋関数層（副作用なし）
# ════════════════════════════════════════════════════════════════════════

def jd_from_date(year: int, month: int, day: int) -> float:
    """グレゴリオ暦の日付から Julian Date (JD、0:00 UTC) を返す（純粋関数）。"""
    a = (14 - month) // 12
    y = year + 4800 - a
    m = month + 12 * a - 3
    jdn = (day
           + (153 * m + 2) // 5
           + 365 * y
           + y // 4
           - y // 100
           + y // 400
           - 32045)
    return float(jdn) - 0.5  # JDN は正午基準 → 0:00 UTC は -0.5


def jd_to_tdb_sec(jd: float) -> float:
    """JD → J2000 基準の TDB 秒へ変換（純粋関数）。"""
    return (jd - J2000_JD) * 86400.0


def extract_intervals(
    raw: np.ndarray,
    init: float,
    intlen: float,
    rsize: int,
    n_total: int,
    start_jd: float,
    end_jd: float,
) -> Optional[dict]:
    """
    セグメントの raw DAF データから指定 JD 範囲の Chebyshev 区間を抽出する（純粋関数）。

    係数は再フィットせず原本の値をそのまま返す。
    MIDPT / RADIUS（各レコード末尾 2 doubles）は spiceypy の spkw02 が不要とするため除去。

    Returns:
        dict: {init_sec, intlen_sec, n_intervals, degree, cdata}
        None: 指定範囲にデータが存在しない場合
    """
    start_sec = jd_to_tdb_sec(start_jd)
    end_sec = jd_to_tdb_sec(end_jd)

    # 対象区間インデックス（区間は [INIT + i*INTLEN, INIT + (i+1)*INTLEN）
    idx_start = max(0, int((start_sec - init) / intlen))
    idx_end_raw = (end_sec - init) / intlen
    idx_end = min(n_total - 1, int(idx_end_raw))
    # end_sec がちょうど区間境界と一致する場合、1つ手前の区間が最後
    if idx_end_raw == float(idx_end) and idx_end > 0:
        idx_end -= 1

    if idx_start > idx_end:
        return None

    # SPK Type 2 レコード構造:
    #   [MIDPT, RADIUS, coeff_x0, ..., coeff_x(D), coeff_y0, ..., coeff_z(D)]
    #   MIDPT と RADIUS は先頭 2 要素。spkw02 では不要のため除去する。
    degree = (rsize - 2) // 3 - 1  # rsize = (degree+1)*3 + 2

    # 各区間から係数だけ取り出して結合（先頭 2 要素 = MIDPT/RADIUS をスキップ）
    parts = [
        raw[i * rsize + 2 : (i + 1) * rsize]
        for i in range(idx_start, idx_end + 1)
    ]
    cdata = np.concatenate(parts)

    return {
        "init_sec": init + idx_start * intlen,
        "intlen_sec": intlen,
        "n_intervals": idx_end - idx_start + 1,
        "degree": degree,
        "cdata": cdata,
    }


# ════════════════════════════════════════════════════════════════════════
# 副作用層（I/O）
# ════════════════════════════════════════════════════════════════════════

def read_segment_intervals(
    seg, start_jd: float, end_jd: float
) -> Optional[dict]:
    """
    jplephem セグメントから DAF raw データを読み取り、
    extract_intervals() を呼び出して結果を返す（副作用: ファイル読み込み）。

    Returns:
        dict: {target, center, **extract_intervals の結果}
        None: 指定範囲にデータが存在しない場合
    """
    raw = seg.daf.map_array(seg.start_i, seg.end_i)
    init, intlen, rsize, n_total = raw[-4:]
    rsize = int(rsize)
    n_total = int(n_total)

    result = extract_intervals(raw, init, intlen, rsize, n_total, start_jd, end_jd)
    if result is None:
        return None

    return {
        "target": seg.target,
        "center": seg.center,
        **result,
    }


def write_bsp(
    output_path: Path,
    segments_data: list[dict],
    label: str,
) -> None:
    """
    spiceypy を使って新しい SPK Type 2 BSP ファイルを書き出す（副作用: ファイル書き込み）。

    segments_data の各要素:
        target, center, init_sec, intlen_sec, n_intervals, degree, cdata
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if output_path.exists():
        output_path.unlink()

    handle = spice.spkopn(str(output_path), label, 80)
    try:
        for seg in segments_data:
            first = seg["init_sec"]
            last = first + seg["n_intervals"] * seg["intlen_sec"]
            segid = f"{seg['center']}->{seg['target']}"
            spice.spkw02(
                handle,
                seg["target"],
                seg["center"],
                FRAME_J2000,
                first,
                last,
                segid,
                seg["intlen_sec"],
                seg["n_intervals"],
                seg["degree"],
                seg["cdata"].tolist(),
                first,
            )
    finally:
        spice.spkcls(handle)


def extract_bsp(
    source_path: Path,
    output_path: Path,
    start_jd: float,
    end_jd: float,
    label: str,
) -> None:
    """
    ソース BSP から指定 JD 範囲のデータを抽出して新しい BSP を生成する（副作用関数）。
    """
    print(f"\n[{label}]")
    print(f"  ソース : {source_path.name}")
    print(f"  出力  : {output_path}")
    print(f"  JD 範囲: {start_jd} ~ {end_jd}")

    if not source_path.exists():
        print(f"  ⚠️  ソースファイルが見つかりません: {source_path}")
        sys.exit(1)

    kernel = SPK.open(str(source_path))
    segments_data = []
    try:
        for seg in kernel.segments:
            # セグメントが対象 JD 範囲と重なるか確認
            if seg.end_jd < start_jd or seg.start_jd > end_jd:
                print(f"    スキップ (範囲外): center={seg.center} -> target={seg.target}")
                continue

            print(f"    抽出中: center={seg.center} -> target={seg.target} ...", end="", flush=True)
            result = read_segment_intervals(seg, start_jd, end_jd)
            if result is None:
                print(" データなし")
                continue

            segments_data.append(result)
            print(f" {result['n_intervals']} 区間 (degree={result['degree']})")

    finally:
        kernel.close()

    if not segments_data:
        print("  ⚠️  抽出できたセグメントがありません")
        return

    write_bsp(output_path, segments_data, label)

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"  ✅ 生成完了: {size_mb:.2f} MB")


# ════════════════════════════════════════════════════════════════════════
# 設定とメイン
# ════════════════════════════════════════════════════════════════════════

#: 生成する BSP ファイルの定義
#: JD 境界は jd_from_date() で計算した正確な値を使用
#:   1873-01-01 = JD 2405159.5  (1872-12-31 = JD 2405158.5)
#:   2100-12-31 = JD 2488433.5  (2101-01-01 = JD 2488434.5)
#:   1550-01-01 = JD 2287185.5  (2650-12-31 = JD 2689316.5)
BSP_TARGETS = [
    {
        "label": "de440s-modern (1873-01-01 ~ 2100-12-31)",
        "source": _CATALOGS_DIR / "de440s.bsp",
        "output": _OUTPUT_DIR / "de440s-modern.bsp",
        "start_jd": jd_from_date(1873, 1, 1),   # 2405159.5
        "end_jd":   jd_from_date(2100, 12, 31),  # 2488433.5
    },
    {
        "label": "de440s-history (1550-01-01 ~ 1872-12-31)",
        "source": _CATALOGS_DIR / "de440.bsp",
        "output": _OUTPUT_DIR / "de440s-history.bsp",
        "start_jd": jd_from_date(1550, 1, 1),    # 2287185.5
        "end_jd":   jd_from_date(1872, 12, 31),  # 2405158.5
    },
    {
        "label": "de440s-future (2101-01-01 ~ 2650-12-31)",
        "source": _CATALOGS_DIR / "de440.bsp",
        "output": _OUTPUT_DIR / "de440s-future.bsp",
        "start_jd": jd_from_date(2101, 1, 1),    # 2488434.5
        "end_jd":   jd_from_date(2650, 12, 31),  # 2689316.5
    },
]


def main(targets: list[str] | None = None) -> None:
    """
    BSP 抽出を実行する。

    Args:
        targets: 生成するファイルのキーワードリスト（例: ['modern', 'history']）。
                 None の場合は全ファイルを生成。
    """
    print("=== bsp_extractor.py ===")
    print(f"出力先: {_OUTPUT_DIR}")

    for cfg in BSP_TARGETS:
        if targets and not any(kw in cfg["label"] for kw in targets):
            continue
        extract_bsp(
            source_path=cfg["source"],
            output_path=cfg["output"],
            start_jd=cfg["start_jd"],
            end_jd=cfg["end_jd"],
            label=cfg["label"],
        )

    print("\n完了")


if __name__ == "__main__":
    # コマンドライン引数でターゲットを絞れる
    # 例: python3 bsp_extractor.py modern
    #     python3 bsp_extractor.py history future
    args = sys.argv[1:] or None
    main(targets=args)
