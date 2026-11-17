// 計算エンジン（画面に依存しない純粋なロジック）
// トークン種別:
//   num   {t:'num', v:'987', neg?:true}     打ち込んだ数字（履歴で編集可）
//   ref   {t:'ref', id:3, v:2961, neg?:true} 他の履歴の結果への参照（連動する）
//   const {t:'const', v:'π'|'e'}
//   op    {t:'op', v:'+'|'-'|'×'|'÷'|'^'}
//   fn    {t:'fn', v:'sin'|'cos'|'tan'|'log'|'ln'|'√'}  ※開きカッコを含む
//   post  {t:'post', v:'²'|'!'|'%'|'⁻¹'}
//   lp / rp  カッコ
//   err   {t:'err'}  参照元がエラーのまま消えた値
(function (root) {
  'use strict';

  const MAX_SIG = 12;

  function round12(x) {
    if (!isFinite(x)) return x;
    if (x === 0) return 0;
    return parseFloat(x.toPrecision(MAX_SIG));
  }

  // 表示用の数値フォーマット（13桁以上は指数表記）
  function formatNumber(x) {
    if (x === null || x === undefined || !isFinite(x)) return 'エラー';
    const n = round12(x);
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e13 || abs < 1e-9) {
      let [m, e] = n.toExponential(MAX_SIG - 1).split('e');
      if (m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, '');
      return m + 'e' + (e.startsWith('-') ? e : '+' + e.replace('+', ''));
    }
    let s = n.toPrecision(MAX_SIG);
    if (s.includes('e')) s = String(n);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function isValueEnd(tok) {
    return !!tok && (tok.t === 'num' || tok.t === 'ref' || tok.t === 'const' ||
      tok.t === 'rp' || tok.t === 'post' || tok.t === 'err');
  }
  function startsPrimary(tok) {
    return !!tok && (tok.t === 'num' || tok.t === 'ref' || tok.t === 'const' ||
      tok.t === 'fn' || tok.t === 'lp' || tok.t === 'err');
  }

  class CalcError extends Error {}

  function factorial(n) {
    if (n < 0 || !Number.isInteger(round12(n)) || n > 170) throw new CalcError('factorial');
    n = Math.round(n);
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }

  // tokens を評価する。resolveRef(id) は参照先の値（エラー時は null）を返す
  function evaluate(tokens, opts) {
    const angle = (opts && opts.angle) || 'deg';
    const resolveRef = (opts && opts.resolveRef) || (() => null);
    const toRad = x => angle === 'deg' ? x * Math.PI / 180 : x;
    let i = 0;
    const peek = () => tokens[i];

    function expr() {
      let v = term();
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        const op = tokens[i++].v;
        const r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function term() {
      let v = unary();
      for (;;) {
        const tk = peek();
        if (tk && tk.t === 'op' && (tk.v === '×' || tk.v === '÷')) {
          i++;
          const r = unary();
          if (tk.v === '÷') {
            if (r === 0) throw new CalcError('div0');
            v = v / r;
          } else v = v * r;
        } else if (startsPrimary(tk)) {
          v = v * unary(); // 暗黙の掛け算 2π, 3(4) など
        } else break;
      }
      return v;
    }
    function unary() {
      const tk = peek();
      if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
        i++;
        const v = unary();
        return tk.v === '-' ? -v : v;
      }
      return power();
    }
    function power() {
      const base = postfix();
      const tk = peek();
      if (tk && tk.t === 'op' && tk.v === '^') {
        i++;
        const ex = unary();
        const r = Math.pow(base, ex);
        if (!isFinite(r)) throw new CalcError('pow');
        return r;
      }
      return base;
    }
    function postfix() {
      let v = primary();
      while (peek() && peek().t === 'post') {
        const p = tokens[i++].v;
        if (p === '²') v = v * v;
        else if (p === '%') v = v / 100;
        else if (p === '!') v = factorial(v);
        else if (p === '⁻¹') {
          if (v === 0) throw new CalcError('div0');
          v = 1 / v;
        }
      }
      return v;
    }
    function primary() {
      const tk = tokens[i++];
      if (!tk) throw new CalcError('incomplete');
      switch (tk.t) {
        case 'num': {
          const s = tk.v === '' || tk.v === '.' ? '0' : tk.v;
          const v = parseFloat(s);
          if (isNaN(v)) throw new CalcError('num');
          return tk.neg ? -v : v;
        }
        case 'ref': {
          const v = resolveRef(tk.id, tk);
          if (v === null || v === undefined || !isFinite(v)) throw new CalcError('ref');
          return tk.neg ? -v : v;
        }
        case 'err': throw new CalcError('ref');
        case 'const': {
          const v = tk.v === 'π' ? Math.PI : Math.E;
          return tk.neg ? -v : v;
        }
        case 'lp': {
          const v = expr();
          if (peek() && peek().t === 'rp') i++;
          return v;
        }
        case 'fn': {
          const a = expr();
          if (peek() && peek().t === 'rp') i++;
          return applyFn(tk.v, a);
        }
        default:
          throw new CalcError('syntax');
      }
    }
    function applyFn(name, a) {
      let r;
      switch (name) {
        case 'sin': r = Math.sin(toRad(a)); break;
        case 'cos': r = Math.cos(toRad(a)); break;
        case 'tan': {
          if (angle === 'deg' && Math.abs(((a % 180) + 180) % 180 - 90) < 1e-12) throw new CalcError('tan');
          r = Math.tan(toRad(a)); break;
        }
        case 'log': if (a <= 0) throw new CalcError('log'); r = Math.log10(a); break;
        case 'ln': if (a <= 0) throw new CalcError('ln'); r = Math.log(a); break;
        case '√': if (a < 0) throw new CalcError('sqrt'); r = Math.sqrt(a); break;
        default: throw new CalcError('fn');
      }
      // sin(180°) が 1.2e-16 になるような誤差を消す
      if (Math.abs(r) < 1e-14) r = 0;
      return r;
    }

    try {
      if (!tokens.length) return null;
      const v = expr();
      if (i < tokens.length) throw new CalcError('trailing');
      if (!isFinite(v)) return null;
      return round12(v);
    } catch (e) {
      if (e instanceof CalcError) return null;
      throw e;
    }
  }

  // 閉じ忘れたカッコの数
  function openParens(tokens) {
    let d = 0;
    for (const tk of tokens) {
      if (tk.t === 'lp' || tk.t === 'fn') d++;
      else if (tk.t === 'rp') d = Math.max(0, d - 1);
    }
    return d;
  }

  // 履歴全体を古い順に再計算する。結果が変わった件数を返す
  function recalcAll(history) {
    const map = new Map();
    let changed = 0;
    for (const entry of history) {
      const resolveRef = id => (map.has(id) ? map.get(id) : null);
      for (const tk of entry.tokens) {
        if (tk.t === 'ref') tk.v = map.has(tk.id) ? map.get(tk.id) : null;
      }
      const r = evaluate(entry.tokens, { angle: entry.angle, resolveRef });
      if (r !== entry.result) changed++;
      entry.result = r;
      map.set(entry.id, r);
    }
    return { changed, map };
  }

  // 参照元が消えたとき、参照していたトークンをその時点の数値に固定する
  function detachRefs(tokens, removedId, value) {
    for (let k = 0; k < tokens.length; k++) {
      const tk = tokens[k];
      if (tk.t === 'ref' && tk.id === removedId) {
        if (value === null || value === undefined || !isFinite(value)) {
          tokens[k] = { t: 'err' };
        } else {
          const s = formatNumber(Math.abs(value));
          const neg = (value < 0) !== !!tk.neg;
          tokens[k] = { t: 'num', v: s.includes('e') ? String(Math.abs(value)) : s };
          if (neg) tokens[k].neg = true;
        }
      }
    }
  }

  const api = { round12, formatNumber, evaluate, openParens, recalcAll, detachRefs, isValueEnd, startsPrimary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CalcCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
