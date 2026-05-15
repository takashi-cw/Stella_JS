/**
 * ui-settings.js — 設定・暦変換 UI ハンドラ群
 *
 * 担当セクション（元 app.js L4814–L5028 相当）:
 *   - CHANGELOG.md の遅延レンダリング
 *   - 日付・暦変換フォーム（form-cal-conv）
 *
 * 使用方法:
 *   import { init, loadChangelog } from './ui-settings.js';
 *   init();
 */

import {
  dateToJd, jdToDate,
  astroYearToHistorical, historicalYearToAstro,
} from './index.js';

// ── 暦変換ユーティリティ ──────────────────────────────────────────────────

const _UNIX_EPOCH_JD = 2440587.5;
const _MJD_OFFSET    = 2400000.5;

function _pad(n, w = 2) { return String(Math.abs(n)).padStart(w, '0'); }

function _jdToDisplayStr(jd, cal, tz = 'UTC') {
  const { year, month, day, hour, minute, second } = jdToDate(jd, cal);
  const { absYear, era } = astroYearToHistorical(year);
  const eraStr = era === 'BC' ? `BC ${absYear}` : `${absYear}`;
  const secInt = Math.floor(second);
  const ms     = Math.round((second - secInt) * 1000);
  const secStr = ms > 0
    ? `${_pad(secInt)}.${String(ms).padStart(3, '0')}`
    : _pad(secInt);
  return `${eraStr}年 ${_pad(month)}月 ${_pad(day)}日 ${_pad(hour)}:${_pad(minute)}:${secStr} ${tz}`;
}

// ── Markdown レンダラー ───────────────────────────────────────────────────

function _mdInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function _simpleMarkdown(md) {
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = md.split('\n');
  const out = [];
  let inList = false;
  let inTable = false;
  let tableRows = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    out.push('<table class="result-table cl-table">');
    out.push('<thead><tr>');
    tableRows[0].forEach(c => out.push(`<th>${_mdInline(escape(c))}</th>`));
    out.push('</tr></thead><tbody>');
    for (let r = 1; r < tableRows.length; r++) {
      out.push('<tr>');
      tableRows[r].forEach(c => out.push(`<td>${_mdInline(escape(c))}</td>`));
      out.push('</tr>');
    }
    out.push('</tbody></table>');
    tableRows = [];
  };

  for (const rawLine of lines) {
    const line    = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith('|')) {
      if (!inList && inList !== false) { out.push('</ul>'); inList = false; }
      if (!inTable) inTable = true;
      if (/^\|[-:| ]+\|$/.test(trimmed)) continue;
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
      inTable = false;
    }

    if (/^[-*] /.test(trimmed)) {
      if (!inList) { out.push('<ul class="changelog-list">'); inList = true; }
      out.push(`<li>${_mdInline(escape(trimmed.slice(2)))}</li>`);
      continue;
    } else if (inList) {
      out.push('</ul>');
      inList = false;
    }

    const hm = trimmed.match(/^(#{1,4}) (.+)$/);
    if (hm) {
      const level = Math.min(hm[1].length + 2, 6);
      const cls = ['cl-h2', 'cl-h3', 'cl-h4', 'cl-h5'][hm[1].length - 1] || 'cl-h5';
      out.push(`<h${level} class="${cls}">${_mdInline(escape(hm[2]))}</h${level}>`);
      continue;
    }

    if (/^[-*]{3,}$/.test(trimmed)) {
      out.push('<hr>');
      continue;
    }

    if (trimmed === '') continue;

    out.push(`<p class="cl-p">${_mdInline(escape(trimmed))}</p>`);
  }

  if (inList) out.push('</ul>');
  if (inTable) flushTable();

  return out.join('\n');
}

/**
 * ./CHANGELOG.md を fetch してレンダリングする（遅延読み込み・一度だけ）。
 * nav-item ハンドラーから呼ばれる。
 */
export async function loadChangelog() {
  const el = document.getElementById('changelog-content');
  if (!el || el.dataset.loaded) return;

  el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">読み込み中…</p>';
  try {
    const res = await fetch('./CHANGELOG.md', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    el.innerHTML = _simpleMarkdown(text);
    el.dataset.loaded = '1';
  } catch (e) {
    el.innerHTML = `<p style="color:var(--accent-warn);font-size:13px">
      更新履歴を読み込めませんでした（${e.message}）<br>
      <span style="font-size:11px;color:var(--text-muted)">
        public/CHANGELOG.md が存在するか確認してください。
      </span>
    </p>`;
  }
}

// ── モジュール初期化 ──────────────────────────────────────────────────────

export function init() {
  _registerHandlers();
}

function _registerHandlers() {

  // ── 日付・暦変換 ──────────────────────────────────────────────────────
  document.getElementById('form-cal-conv')?.addEventListener('submit', e => {
    e.preventDefault();
    const resultEl = document.getElementById('result-cal-conv');

    const era      = document.getElementById('cal-conv-era').value;
    const absYear  = parseInt(document.getElementById('cal-conv-year').value,   10);
    const month    = parseInt(document.getElementById('cal-conv-month').value,  10);
    const day      = parseInt(document.getElementById('cal-conv-day').value,    10);
    const hour     = parseInt(document.getElementById('cal-conv-hour').value,   10) || 0;
    const minute   = parseInt(document.getElementById('cal-conv-minute').value, 10) || 0;
    const second   = parseInt(document.getElementById('cal-conv-second').value, 10) || 0;
    const calendar = document.getElementById('cal-conv-calendar').value;

    if (isNaN(absYear) || isNaN(month) || isNaN(day)) {
      resultEl.innerHTML = '<p style="color:var(--accent-warn)">年・月・日を入力してください。</p>';
      return;
    }

    const year = historicalYearToAstro(absYear, era);

    let jd;
    try {
      jd = dateToJd(year, month, day, hour - 9, minute, second, calendar);
    } catch (err) {
      resultEl.innerHTML = `<p style="color:var(--accent-warn)">${err.message}</p>`;
      return;
    }

    const mjd  = jd - _MJD_OFFSET;
    const unix = (jd - _UNIX_EPOCH_JD) * 86400;

    const gregStr    = _jdToDisplayStr(jd,           'gregorian', 'UTC');
    const julStr     = _jdToDisplayStr(jd,           'julian',    'UTC');
    const gregJstStr = _jdToDisplayStr(jd + 9 / 24, 'gregorian', 'JST');
    const julJstStr  = _jdToDisplayStr(jd + 9 / 24, 'julian',    'JST');
    const astroYearSign = year >= 0 ? `+${year}` : `${year}`;
    const unixNote = unix < 0
      ? ' <span style="color:var(--text-muted);font-size:11px">（負値: 1970-01-01 UTC 以前）</span>'
      : '';

    resultEl.innerHTML = `
      <table class="result-table" style="width:100%;border-collapse:collapse;font-size:13px">
        <colgroup><col style="width:42%"><col style="width:58%"></colgroup>
        <thead>
          <tr><th colspan="2" style="text-align:left;padding:6px 8px;background:var(--bg-sub);border-bottom:1px solid var(--border)">変換結果</th></tr>
        </thead>
        <tbody>
          <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">グレゴリオ暦 (UTC)</td>
              <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${gregStr}</td></tr>
          <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">グレゴリオ暦 (JST)</td>
              <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${gregJstStr} <span style="font-size:11px;color:var(--text-muted)">(+09:00)</span></td></tr>
          <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">ユリウス暦 (UTC)</td>
              <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${julStr}</td></tr>
          <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">ユリウス暦 (JST)</td>
              <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${julJstStr} <span style="font-size:11px;color:var(--text-muted)">(+09:00)</span></td></tr>
          <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">天文学年番号 (Year 0 あり)</td>
              <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${astroYearSign}年 ${_pad(month)}月 ${_pad(day)}日</td></tr>
          <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">ユリウス日 (JD)</td>
              <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${jd.toFixed(6)}</td></tr>
          <tr><td style="padding:6px 8px;color:var(--text-muted);border-bottom:1px solid var(--border)">修正ユリウス日 (MJD)</td>
              <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-family:monospace">${mjd.toFixed(6)}</td></tr>
          <tr><td style="padding:6px 8px;color:var(--text-muted)">Unix タイムスタンプ (秒)</td>
              <td style="padding:6px 8px;font-family:monospace">${unix < 0 ? unix.toFixed(3) : Math.round(unix)}${unixNote}</td></tr>
        </tbody>
      </table>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">
        入力暦: <b>${calendar === 'auto' ? '自動' : calendar === 'gregorian' ? 'グレゴリオ暦' : 'ユリウス暦'}</b>
        &nbsp;|&nbsp; 入力時刻系: JST（UTC+9）
      </p>
    `;
  });

}
