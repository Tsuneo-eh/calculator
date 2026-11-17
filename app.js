(function () {
  'use strict';
  const C = window.CalcCore;
  const STORE_KEY = 'calc.v1';
  const MAX_HISTORY = 100;
  const MAX_DIGITS = 15;

  // ---------- 状態 ----------
  const state = {
    history: [],      // {id, tokens, angle, result}
    nextId: 1,
    angle: 'deg',
    mode: 'std',      // 'std' | 'fn'
    input: [],
    justEvaluated: false,
    lastRefId: null,
    lastResult: null,
    lastExpr: null,
    editing: null,    // {id, idx, buf, neg, prevMode}
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (Array.isArray(d.history)) state.history = d.history;
      if (d.nextId) state.nextId = d.nextId;
      if (d.angle === 'rad') state.angle = 'rad';
      if (d.mode === 'fn') state.mode = 'fn';
      C.recalcAll(state.history);
    } catch (e) { /* 読み込めなくても空で起動する */ }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        history: state.history, nextId: state.nextId, angle: state.angle, mode: state.mode,
      }));
    } catch (e) { /* 保存できない環境でも動作は続ける */ }
  }

  // ---------- 要素 ----------
  const $ = id => document.getElementById(id);
  const elHistory = $('history');
  const elBig = $('big');
  const elExpr = $('exprLine');
  const elMsg = $('msg');
  const elBadge = $('angleBadge');
  const elKeys = $('keys');

  // ---------- 表示用ヘルパー ----------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MINUS = '−';
  const OP_LABEL = { '+': '+', '-': MINUS, '×': '×', '÷': '÷', '^': '^' };

  function tokenText(tk) {
    switch (tk.t) {
      case 'num': return (tk.neg ? MINUS : '') + (tk.v === '' ? '0' : tk.v);
      case 'ref': return (tk.neg ? MINUS : '') + C.formatNumber(tk.v);
      case 'const': return (tk.neg ? MINUS : '') + tk.v;
      case 'op': return OP_LABEL[tk.v];
      case 'fn': return tk.v + '(';
      case 'post': return tk.v;
      case 'lp': return '(';
      case 'rp': return ')';
      case 'err': return 'エラー';
    }
    return '';
  }

  // トークン列をHTMLにする。where: 'hist'（履歴行）| 'input'（表示部）
  function tokensHTML(tokens, where, entryId) {
    let html = '';
    tokens.forEach((tk, idx) => {
      const txt = esc(tokenText(tk));
      if (tk.t === 'num' && where === 'hist') {
        const ed = state.editing && state.editing.id === entryId && state.editing.idx === idx;
        const shown = ed ? esc(editingText()) : txt;
        html += `<span class="tk num${ed ? ' editing' : ''}" data-act="num" data-idx="${idx}">${shown}</span>`;
      } else if (tk.t === 'ref') {
        html += `<span class="tk ref" data-act="ref" data-ref="${tk.id}">${txt}</span>`;
      } else if (tk.t === 'op') {
        html += `<span class="tk op">${txt}</span>`;
      } else if (tk.t === 'err') {
        html += `<span class="tk err">${txt}</span>`;
      } else {
        html += `<span class="tk">${txt}</span>`;
      }
    });
    return html;
  }

  function editingText() {
    const e = state.editing;
    const entry = findEntry(e.id);
    const tk = entry.tokens[e.idx];
    const v = e.buf === '' ? (tk.v === '' ? '0' : tk.v) : e.buf;
    return (e.neg ? MINUS : '') + v;
  }

  const findEntry = id => state.history.find(h => h.id === id);

  // ---------- 描画 ----------
  function renderHistory(scrollToBottom) {
    if (!state.history.length) {
      elHistory.innerHTML = '<p class="empty">計算すると、ここに履歴が残ります</p>';
      return;
    }
    const prevScroll = elHistory.scrollTop;
    elHistory.innerHTML = state.history.map(h => {
      const err = h.result === null;
      return `<div class="row${state.editing && state.editing.id === h.id ? ' is-editing' : ''}" data-id="${h.id}">
        <div class="expr">${tokensHTML(h.tokens, 'hist', h.id)}<span class="eq">=</span><span class="res${err ? ' err' : ''}" data-act="res">${esc(C.formatNumber(h.result))}</span></div>
        <button class="x" data-act="del" aria-label="この履歴を削除">✕</button>
      </div>`;
    }).join('');
    // 長い式は右端（結果側）が見えるように
    elHistory.querySelectorAll('.expr').forEach(ex => { ex.scrollLeft = ex.scrollWidth; });
    elHistory.scrollTop = scrollToBottom ? elHistory.scrollHeight : prevScroll;
  }

  let msgTimer = null;
  function flashMsg(text, ms) {
    elMsg.textContent = text;
    clearTimeout(msgTimer);
    if (ms !== 0) msgTimer = setTimeout(() => { if (!state.editing) elMsg.textContent = ''; }, ms || 2000);
  }

  function renderDisplay() {
    elBadge.textContent = state.angle.toUpperCase();
    elBadge.hidden = state.mode !== 'fn';
    if (state.editing) {
      const e = state.editing;
      const tk = findEntry(e.id).tokens[e.idx];
      const orig = tokenText(tk);
      const now = editingText();
      elExpr.textContent = '';
      elBig.innerHTML = `<span class="editing-big">${esc(now)}</span>`;
      elMsg.textContent = `編集中：${orig} → ${now}（＝で確定 / ACで取消）`;
      clearTimeout(msgTimer);
    } else if (state.justEvaluated) {
      elExpr.innerHTML = state.lastExpr || '';
      elBig.textContent = C.formatNumber(state.lastResult);
    } else {
      elExpr.textContent = '';
      elBig.innerHTML = state.input.length ? tokensHTML(state.input, 'input') : '0';
    }
    fitBig();
  }

  // 桁が増えたら文字を小さくする
  function fitBig() {
    const maxSize = 56, minSize = 22;
    let size = maxSize;
    elBig.style.fontSize = size + 'px';
    while (elBig.scrollWidth > elBig.clientWidth && size > minSize) {
      size -= 2;
      elBig.style.fontSize = size + 'px';
    }
    elBig.scrollLeft = elBig.scrollWidth;
  }

  // ---------- キー配列 ----------
  const TOP_ROW = [
    { k: 'mode' }, { k: 'lp', l: '(' }, { k: 'rp', l: ')' }, { k: 'pi', l: 'π' }, { k: 'ans', l: 'Ans' },
  ];
  const PAD_STD = [
    ['AC', 'ac', 'k-sub'], ['⌫', 'back', 'k-sub'], ['%', 'pct', 'k-sub'], ['÷', 'div', 'k-op'],
    ['7', '7'], ['8', '8'], ['9', '9'], ['×', 'mul', 'k-op'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['−', 'sub', 'k-op'],
    ['1', '1'], ['2', '2'], ['3', '3'], ['+', 'add', 'k-op'],
    ['+/−', 'neg'], ['0', '0'], ['.', 'dot'], ['=', 'eq', 'k-eq'],
  ];
  const PAD_FN = [
    ['AC', 'ac', 'k-sub'], ['⌫', 'back', 'k-sub'], ['%', 'pct', 'k-sub'], ['÷', 'div', 'k-op'],
    ['sin', 'sin', 'k-f'], ['cos', 'cos', 'k-f'], ['tan', 'tan', 'k-f'], ['×', 'mul', 'k-op'],
    ['log', 'log', 'k-f'], ['ln', 'ln', 'k-f'], ['√', 'sqrt', 'k-f'], ['−', 'sub', 'k-op'],
    ['x²', 'sq', 'k-f'], ['xʸ', 'pow', 'k-f'], ['!', 'fact', 'k-f'], ['+', 'add', 'k-op'],
    ['e', 'e', 'k-f'], ['1/x', 'inv', 'k-f'], ['ANGLE', 'angle', 'k-sub'], ['=', 'eq', 'k-eq'],
  ];

  function renderKeys() {
    const top = TOP_ROW.map(b => b.k === 'mode'
      ? `<button class="key k-mode" data-k="mode">${state.mode === 'std' ? '関数' : '標準'}</button>`
      : `<button class="key k-top" data-k="${b.k}">${b.l}</button>`).join('');
    const pad = (state.mode === 'std' ? PAD_STD : PAD_FN).map(([l, k, cls]) => {
      const label = k === 'angle' ? state.angle.toUpperCase() : l;
      return `<button class="key ${cls || 'k-num'}" data-k="${k}">${label}</button>`;
    }).join('');
    elKeys.innerHTML = `<div class="toprow">${top}</div><div class="pad">${pad}</div>`;
  }

  function renderAll(scrollToBottom) {
    renderHistory(scrollToBottom);
    renderDisplay();
  }

  // ---------- 入力ロジック ----------
  const last = () => state.input[state.input.length - 1];
  const numTok = d => ({ t: 'num', v: d });

  function startFresh() {
    if (state.justEvaluated) { state.input = []; state.justEvaluated = false; }
  }
  // = の直後に演算子などを押したら、直前の結果から続ける
  function continueFromResult() {
    if (!state.justEvaluated) return;
    state.justEvaluated = false;
    const entry = state.lastRefId != null ? findEntry(state.lastRefId) : null;
    if (entry) state.input = [{ t: 'ref', id: entry.id, v: entry.result }];
    else if (state.lastResult !== null && isFinite(state.lastResult)) state.input = valueToTokens(state.lastResult);
    else state.input = [];
  }
  function valueToTokens(v) {
    const tk = numTok(String(Math.abs(v)));
    if (v < 0) tk.neg = true;
    return [tk];
  }

  function pressDigit(d) {
    startFresh();
    const tk = last();
    if (tk && tk.t === 'num') {
      if (tk.v === '0') tk.v = d;
      else if (tk.v.replace('.', '').length < MAX_DIGITS) tk.v += d;
      return;
    }
    if (C.isValueEnd(tk)) state.input.push({ t: 'op', v: '×' });
    state.input.push(numTok(d));
  }
  function pressDot() {
    startFresh();
    const tk = last();
    if (tk && tk.t === 'num') { if (!tk.v.includes('.')) tk.v += '.'; return; }
    if (C.isValueEnd(tk)) state.input.push({ t: 'op', v: '×' });
    state.input.push(numTok('0.'));
  }
  function pressOp(o) {
    continueFromResult();
    const tk = last();
    if (!tk) { if (o === '-') state.input.push({ t: 'op', v: o }); return; }
    if (tk.t === 'op') {
      const prev = state.input[state.input.length - 2];
      if (!prev || prev.t === 'lp' || prev.t === 'fn') { // 先頭の符号マイナス
        if (o !== '-') state.input.pop();
        return;
      }
      tk.v = o;
      return;
    }
    if (tk.t === 'lp' || tk.t === 'fn') { if (o === '-') state.input.push({ t: 'op', v: o }); return; }
    state.input.push({ t: 'op', v: o });
  }
  function pressFn(name) { startFresh(); state.input.push({ t: 'fn', v: name }); }
  function pressConst(c) { startFresh(); state.input.push({ t: 'const', v: c }); }
  function pressPost(p) {
    continueFromResult();
    if (C.isValueEnd(last())) state.input.push({ t: 'post', v: p });
  }
  function pressLP() { startFresh(); state.input.push({ t: 'lp' }); }
  function pressRP() {
    if (state.justEvaluated) return;
    if (C.openParens(state.input) > 0 && C.isValueEnd(last())) state.input.push({ t: 'rp' });
  }
  function pressNeg() {
    continueFromResult();
    const tk = last();
    if (tk && (tk.t === 'num' || tk.t === 'ref' || tk.t === 'const')) {
      if (tk.neg) delete tk.neg; else tk.neg = true;
      return;
    }
    if (C.isValueEnd(tk)) return;
    state.input.push({ t: 'num', v: '0', neg: true });
  }
  function pressBack() {
    if (state.justEvaluated) return;
    const tk = last();
    if (!tk) return;
    if (tk.t === 'num' && tk.v.length > 1) tk.v = tk.v.slice(0, -1);
    else state.input.pop();
  }
  function pressAC() {
    state.input = [];
    state.justEvaluated = false;
    state.lastExpr = null;
    elMsg.textContent = '';
  }

  // 値トークン（履歴の結果・Ans）を今の入力に入れる
  function insertValueToken(tok) {
    if (state.justEvaluated) { state.input = [tok]; state.justEvaluated = false; return; }
    const tk = last();
    if (!tk || tk.t === 'op' || tk.t === 'lp' || tk.t === 'fn') state.input.push(tok);
    else if (tk.t === 'num' || tk.t === 'ref' || tk.t === 'const' || tk.t === 'err') state.input[state.input.length - 1] = tok;
    else { state.input.push({ t: 'op', v: '×' }); state.input.push(tok); }
  }
  function useResult(id) {
    const entry = findEntry(id);
    if (!entry) return;
    if (entry.result === null) { flashMsg('エラーの結果は使えません'); return; }
    insertValueToken({ t: 'ref', id: entry.id, v: entry.result });
  }
  function pressAns() {
    const latest = state.history[state.history.length - 1];
    if (!latest) { flashMsg('まだ履歴がありません'); return; }
    useResult(latest.id);
  }

  function resolveRef(id) {
    const e = findEntry(id);
    return e ? e.result : null;
  }

  function pressEquals() {
    if (state.justEvaluated || !state.input.length) return;
    const tokens = state.input.map(t => ({ ...t }));
    for (let n = C.openParens(tokens); n > 0; n--) tokens.push({ t: 'rp' });
    const result = C.evaluate(tokens, { angle: state.angle, resolveRef });
    if (result === null) { flashMsg('計算できません'); return; }

    const exprHTML = tokensHTML(tokens, 'input') + ' =';
    if (tokens.length === 1 && tokens[0].t === 'num') {
      // 数字1つだけなら履歴には残さない
      state.lastRefId = null;
    } else {
      const entry = { id: state.nextId++, tokens, angle: state.angle, result };
      state.history.push(entry);
      while (state.history.length > MAX_HISTORY) removeEntry(state.history[0].id, true);
      state.lastRefId = entry.id;
      flashMsg('履歴に保存しました');
      save();
    }
    state.input = [];
    state.lastResult = result;
    state.lastExpr = exprHTML;
    state.justEvaluated = true;
    renderAll(true);
  }

  // ---------- 履歴の削除と再計算 ----------
  function removeEntry(id, silent) {
    const entry = findEntry(id);
    if (!entry) return;
    if (state.editing && state.editing.id === id) endEdit(false);
    for (const h of state.history) if (h !== entry) C.detachRefs(h.tokens, id, entry.result);
    C.detachRefs(state.input, id, entry.result);
    state.history = state.history.filter(h => h !== entry);
    if (state.lastRefId === id) state.lastRefId = null;
    if (!silent) { recalc(); save(); }
  }

  function recalc() {
    const { changed, map } = C.recalcAll(state.history);
    for (const tk of state.input) if (tk.t === 'ref' && map.has(tk.id)) tk.v = map.get(tk.id);
    if (state.justEvaluated && state.lastRefId != null && map.has(state.lastRefId)) {
      state.lastResult = map.get(state.lastRefId);
      const e = findEntry(state.lastRefId);
      state.lastExpr = tokensHTML(e.tokens, 'input') + ' =';
    }
    return changed;
  }

  function clearAll() {
    if (!state.history.length) return;
    if (!confirm('計算履歴をすべて削除しますか？')) return;
    if (state.editing) endEdit(false);
    for (const h of state.history) C.detachRefs(state.input, h.id, h.result);
    state.history = [];
    state.lastRefId = null;
    save();
    renderAll();
  }

  // ---------- 履歴の数字の編集 ----------
  function startEdit(id, idx) {
    const entry = findEntry(id);
    if (!entry || !entry.tokens[idx] || entry.tokens[idx].t !== 'num') return;
    if (state.editing) endEdit(false);
    const prevMode = state.mode;
    state.editing = { id, idx, buf: '', neg: !!entry.tokens[idx].neg, prevMode };
    if (state.mode === 'fn') { state.mode = 'std'; renderKeys(); } // 数字を打てるよう標準に
    renderAll();
  }

  function endEdit(commit) {
    const e = state.editing;
    if (!e) return;
    state.editing = null;
    let changedMsg = null;
    const entry = findEntry(e.id);
    if (commit && entry) {
      const tk = entry.tokens[e.idx];
      let v = e.buf;
      if (v !== '') {
        if (v.startsWith('.')) v = '0' + v;
        if (v.endsWith('.')) v = v.slice(0, -1);
        v = v.replace(/^0+(?=\d)/, '');
        tk.v = v;
      }
      if (e.neg) tk.neg = true; else delete tk.neg;
      const changed = recalc();
      save();
      changedMsg = changed > 0 ? `${changed}件を再計算しました` : '結果は変わりませんでした';
    }
    if (state.mode !== e.prevMode) { state.mode = e.prevMode; renderKeys(); }
    elMsg.textContent = '';
    renderAll();
    if (changedMsg) flashMsg(changedMsg);
  }

  function editKey(k) {
    const e = state.editing;
    if (/^\d$/.test(k)) {
      if (e.buf === '0') e.buf = k;
      else if (e.buf.replace('.', '').length < MAX_DIGITS) e.buf += k;
    } else if (k === 'dot') {
      if (!e.buf.includes('.')) e.buf = (e.buf === '' ? '0' : e.buf) + '.';
    } else if (k === 'back') {
      e.buf = e.buf.slice(0, -1);
    } else if (k === 'neg') {
      e.neg = !e.neg;
    } else if (k === 'eq') {
      endEdit(true); return;
    } else if (k === 'ac') {
      endEdit(false); return;
    } else if (k === 'mode') {
      return; // 編集中は標準モードのまま
    } else {
      flashKeyHint();
      return;
    }
    renderAll();
  }
  function flashKeyHint() {
    elMsg.classList.remove('shake');
    void elMsg.offsetWidth;
    elMsg.classList.add('shake');
  }

  // ---------- イベント ----------
  const KEY_ACTIONS = {
    ac: pressAC, back: pressBack, neg: pressNeg, dot: pressDot, eq: pressEquals,
    add: () => pressOp('+'), sub: () => pressOp('-'), mul: () => pressOp('×'), div: () => pressOp('÷'),
    pow: () => pressOp('^'),
    pct: () => pressPost('%'), sq: () => pressPost('²'), fact: () => pressPost('!'), inv: () => pressPost('⁻¹'),
    sin: () => pressFn('sin'), cos: () => pressFn('cos'), tan: () => pressFn('tan'),
    log: () => pressFn('log'), ln: () => pressFn('ln'), sqrt: () => pressFn('√'),
    pi: () => pressConst('π'), e: () => pressConst('e'),
    lp: pressLP, rp: pressRP, ans: pressAns,
  };

  function toggleAngle() {
    state.angle = state.angle === 'deg' ? 'rad' : 'deg';
    save();
    renderKeys();
    renderDisplay();
  }

  elKeys.addEventListener('click', ev => {
    const btn = ev.target.closest('button[data-k]');
    if (!btn) return;
    const k = btn.dataset.k;
    if (ev.isTrusted && navigator.vibrate) navigator.vibrate(8);
    if (state.editing) { editKey(k); return; }
    if (k === 'mode') {
      state.mode = state.mode === 'std' ? 'fn' : 'std';
      save(); renderKeys(); renderDisplay();
      return;
    }
    if (k === 'angle') { toggleAngle(); return; }
    if (k === 'eq') { pressEquals(); return; }
    if (/^\d$/.test(k)) pressDigit(k);
    else if (KEY_ACTIONS[k]) KEY_ACTIONS[k]();
    renderDisplay();
  });

  elBadge.addEventListener('click', () => { if (!state.editing) toggleAngle(); });

  elHistory.addEventListener('click', ev => {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const row = t.closest('.row');
    const id = Number(row.dataset.id);
    switch (t.dataset.act) {
      case 'res':
        if (state.editing) endEdit(false);
        useResult(id); renderDisplay(); break;
      case 'num':
        startEdit(id, Number(t.dataset.idx)); break;
      case 'ref':
        jumpTo(Number(t.dataset.ref)); break;
      case 'del':
        removeEntry(id); renderAll(); break;
    }
  });

  // 参照元へスクロールして光らせる
  function jumpTo(id) {
    const row = elHistory.querySelector(`.row[data-id="${id}"]`);
    if (!row) return;
    const top = row.offsetTop - elHistory.offsetTop - (elHistory.clientHeight - row.offsetHeight) / 2;
    elHistory.scrollTo({ top, behavior: 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }

  $('clearAll').addEventListener('click', clearAll);

  // PCのキーボードでも操作できるように
  document.addEventListener('keydown', ev => {
    const map = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '^': 'pow', '.': 'dot', '%': 'pct',
      '(': 'lp', ')': 'rp', Enter: 'eq', '=': 'eq', Backspace: 'back', Escape: 'ac', '!': 'fact' };
    const k = /^\d$/.test(ev.key) ? ev.key : map[ev.key];
    if (!k) return;
    ev.preventDefault();
    const btn = elKeys.querySelector(`button[data-k="${k}"]`);
    if (btn) btn.click();
    else if (state.editing) editKey(k);
    else {
      if (/^\d$/.test(k)) pressDigit(k);
      else if (KEY_ACTIONS[k]) KEY_ACTIONS[k]();
      renderDisplay();
    }
  });

  window.addEventListener('resize', fitBig);

  // ---------- 起動 ----------
  load();
  renderKeys();
  renderAll(true);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
