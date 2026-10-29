/* SPDX-License-Identifier: Apache-2.0 */
'use strict';

/* ============================================================================
 * Lua 思维可视化 · UX 概念原型
 * ----------------------------------------------------------------------------
 * 纯前端原型：简化 Lua 子集 解析器 + 显式事件流解释器 + trace 回放渲染。
 * 目的是验证一个产品判断——
 *   「把求值过程投影到语法树上，会不会真的像看到大脑在思考」。
 *
 * 正式版架构（见 README.md）：
 *   Rust（full-moon 解析 + 显式状态机解释器）→ WebAssembly → 同一套 UI
 * 本文件里的 JS 解析器/解释器只是可抛弃的验证外壳，不代表正式实现。
 * ========================================================================== */

/* ---------------- 1. 词法 ---------------- */
const KEYWORDS = new Set(('and break do else elseif end false for function if in ' +
  'local nil not or repeat return then true until while').split(' '));

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      const s = i;
      while (i < n && src[i] !== '\n') i++;
      toks.push({ type: 'comment', start: s, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const s = i; i++;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
      toks.push({ type: 'name', value: src.slice(s, i), start: s, end: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const s = i; i++;
      while (i < n && /[0-9]/.test(src[i])) i++;
      if (src[i] === '.') { i++; while (i < n && /[0-9]/.test(src[i])) i++; }
      toks.push({ type: 'num', value: Number(src.slice(s, i)), start: s, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; const s = i; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++;
      toks.push({ type: 'string', value: src.slice(s + 1, i - 1), start: s, end: Math.min(i, n) });
      continue;
    }
    const two = src.substr(i, 2);
    if (two === '==' || two === '~=' || two === '<=' || two === '>=' || two === '..' || two === '//' ||
        two === '<<' || two === '>>') {
      toks.push({ type: 'op', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    toks.push({ type: 'op', value: c, start: i, end: i + 1 });
    i++;
  }
  toks.push({ type: 'eof', value: '<eof>', start: n, end: n });
  return toks;
}

/* ---------------- 2. 语法（Lua 子集 → AST） ---------------- */
const BIN_PREC = {
  'or': 1, 'and': 2,
  '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
  '|': 4, '~': 5, '&': 6, '<<': 7, '>>': 7,
  '..': 8, '+': 9, '-': 9,
  '*': 10, '/': 10, '//': 10, '%': 10,
  '^': 12
};

function parse(src) {
  const raw = tokenize(src);
  const toks = raw.filter(t => t.type !== 'comment');
  let p = 0;
  let seq = 0;

  const mk = (k, s, e, props) => Object.assign({ k, id: ++seq, span: [s, e] }, props || {});
  const peek = (o) => toks[Math.min(p + (o || 0), toks.length - 1)];
  const isOp = (v) => { const t = peek(); return t.type === 'op' && t.value === v; };
  const isKw = (v) => { const t = peek(); return t.type === 'name' && t.value === v; };
  const isName = () => { const t = peek(); return t.type === 'name' && !KEYWORDS.has(t.value); };
  const fail = (msg) => {
    const t = peek();
    const upto = src.slice(0, t.start);
    const line = upto.split('\n').length;
    const col = t.start - upto.lastIndexOf('\n');
    throw new Error(msg + '（第 ' + line + ' 行第 ' + col + ' 列，字符 ' + t.start +
      '，附近：' + JSON.stringify(src.slice(t.start, t.start + 14)) + '）');
  };
  const next = () => { const t = peek(); p++; return t; };
  const expectOp = (v) => { if (!isOp(v)) fail('期望 "' + v + '"'); return next(); };
  const expectKw = (v) => { if (!isKw(v)) fail('期望关键字 "' + v + '"'); return next(); };
  const expectName = () => { if (!isName()) fail('期望名字'); return next(); };

  function block(terms) {
    const s = peek().start;
    const stmts = [];
    for (;;) {
      if (peek().type === 'eof') break;
      const t = peek();
      if (t.type === 'name' && terms.indexOf(t.value) >= 0) break;
      if (isOp(';')) { p++; continue; }
      stmts.push(stmt());
      while (isOp(';')) p++;
    }
    const e = stmts.length ? stmts[stmts.length - 1].span[1] : s;
    return mk('Block', s, e, { stmts });
  }

  function stmt() {
    const t = peek();
    if (isKw('local')) {
      const start = t.start; p++;
      if (isKw('function')) {
        const fnStart = peek().start; p++;
        const name = expectName().value;
        const fn = funcBody(fnStart, name);
        return mk('LocalFunction', start, fn.span[1], { name, func: fn });
      }
      const names = [expectName().value];
      while (isOp(',')) { p++; names.push(expectName().value); }
      let exprs = [];
      if (isOp('=')) { p++; exprs = exprList(); }
      const end = exprs.length ? exprs[exprs.length - 1].span[1] : toks[p - 1].end;
      return mk('Local', start, end, { names, exprs });
    }
    if (isKw('function')) {
      const start = t.start; p++;
      const name = expectName().value;
      const fn = funcBody(t.start, name);
      return mk('FunctionDecl', start, fn.span[1], { name, func: fn });
    }
    if (isKw('if')) return ifStmt();
    if (isKw('for')) return numForStmt();
    if (isKw('while')) return whileStmt();
    if (isKw('do')) return doStmt();
    if (isKw('return')) {
      const start = t.start; p++;
      let exprs = [];
      if (!(peek().type === 'eof' || isKw('end') || isKw('else') || isKw('elseif') || isOp(';'))) {
        exprs = exprList();
      }
      const end = exprs.length ? exprs[exprs.length - 1].span[1] : toks[p - 1].end;
      return mk('Return', start, end, { exprs });
    }
    const start = t.start;
    const target = suffixed();
    if (isOp('=')) {
      p++;
      const exprs = exprList();
      return mk('Assign', start, exprs[exprs.length - 1].span[1], { targets: [target], exprs });
    }
    if (target.k === 'Call') return mk('CallStmt', start, target.span[1], { call: target });
    fail('无法解析语句');
  }

  function ifStmt() {
    const start = peek().start;
    expectKw('if');
    const clauses = [];
    let cond = expr(0);
    expectKw('then');
    let body = block(['elseif', 'else', 'end']);
    clauses.push({ cond, body });
    while (isKw('elseif')) {
      p++;
      cond = expr(0);
      expectKw('then');
      body = block(['elseif', 'else', 'end']);
      clauses.push({ cond, body });
    }
    let elseBody = null;
    if (isKw('else')) { p++; elseBody = block(['end']); }
    const endTok = expectKw('end');
    return mk('If', start, endTok.end, { clauses, elseBody });
  }

  function numForStmt() {
    const start = peek().start;
    expectKw('for');
    const name = expectName().value;
    expectOp('=');
    const init = expr(0);
    expectOp(',');
    const limit = expr(0);
    let step = null;
    if (isOp(',')) { p++; step = expr(0); }
    expectKw('do');
    const body = block(['end']);
    const endTok = expectKw('end');
    return mk('NumFor', start, endTok.end, { name, init, limit, step, body });
  }

  function whileStmt() {
    const start = peek().start;
    expectKw('while');
    const cond = expr(0);
    expectKw('do');
    const body = block(['end']);
    const endTok = expectKw('end');
    return mk('While', start, endTok.end, { cond, body });
  }

  function doStmt() {
    const start = peek().start;
    expectKw('do');
    const body = block(['end']);
    const endTok = expectKw('end');
    return mk('Do', start, endTok.end, { body });
  }

  function funcBody(fnStart, name) {
    expectOp('(');
    const params = [];
    if (!isOp(')')) {
      params.push(expectName().value);
      while (isOp(',')) { p++; params.push(expectName().value); }
    }
    expectOp(')');
    const body = block(['end']);
    const endTok = expectKw('end');
    return mk('Function', fnStart, endTok.end, { name, params, body });
  }

  function exprList() {
    const list = [expr(0)];
    while (isOp(',')) { p++; list.push(expr(0)); }
    return list;
  }

  function expr(limit) {
    let left = unary();
    for (;;) {
      const t = peek();
      const prec = (t.type === 'op' || t.type === 'name') ? BIN_PREC[t.value] : undefined;
      if (prec == null || prec <= limit) break;
      p++;
      const rightAssoc = t.value === '^' || t.value === '..';
      const right = expr(rightAssoc ? prec - 1 : prec);
      left = mk('Bin', left.span[0], right.span[1], { op: t.value, l: left, r: right });
    }
    return left;
  }

  function unary() {
    if (isOp('-') || isOp('#') || isOp('~') || isKw('not')) {
      const t = next();
      const e = expr(11);
      return mk('Un', t.start, e.span[1], { op: t.value, e });
    }
    return suffixed();
  }

  function suffixed() {
    let e = primary();
    for (;;) {
      if (isOp('.')) {
        p++;
        const nm = expectName().value;
        e = mk('Field', e.span[0], toks[p - 1].end, { obj: e, name: nm });
      } else if (isOp('(')) {
        const args = argList();
        e = mk('Call', e.span[0], toks[p - 1].end, { fn: e, args });
      } else if (isOp('[')) {
        p++;
        const key = expr(0);
        const close = expectOp(']');
        e = mk('Index', e.span[0], close.end, { obj: e, key });
      } else break;
    }
    return e;
  }

  function argList() {
    expectOp('(');
    const args = [];
    if (!isOp(')')) {
      args.push(expr(0));
      while (isOp(',')) { p++; args.push(expr(0)); }
    }
    expectOp(')');
    return args;
  }

  function primary() {
    const t = peek();
    if (t.type === 'num') { next(); return mk('Num', t.start, t.end, { v: t.value }); }
    if (t.type === 'string') { next(); return mk('Str', t.start, t.end, { v: t.value }); }
    if (isKw('true') || isKw('false')) { next(); return mk('Bool', t.start, t.end, { v: t.value === 'true' }); }
    if (isKw('nil')) { next(); return mk('Nil', t.start, t.end); }
    if (isName()) { next(); return mk('Var', t.start, t.end, { name: t.value }); }
    if (isOp('(')) { next(); const e = expr(0); expectOp(')'); return e; }
    if (isOp('{')) return tableCtor();
    fail('无法解析表达式');
  }

  function tableCtor() {
    const s = peek().start;
    expectOp('{');
    const entries = [];
    while (!isOp('}')) {
      let key = null;
      if (isName() && peek(1).type === 'op' && peek(1).value === '=') {
        key = peek().value;
        p += 2;
      }
      const value = expr(0);
      entries.push({ key, value });
      if (isOp(',') || isOp(';')) p++; else break;
    }
    const close = expectOp('}');
    return mk('Table', s, close.end, { entries });
  }

  const chunkStmts = block([]).stmts;
  if (peek().type !== 'eof') fail('多余的内容');
  return mk('Chunk', 0, src.length, { stmts: chunkStmts });
}

/* AST 子节点（渲染与遍历共用） */
function childrenOf(n) {
  switch (n.k) {
    case 'Chunk': return n.stmts;
    case 'Block': return n.stmts;
    case 'Local': return n.exprs;
    case 'LocalFunction': return [n.func];
    case 'FunctionDecl': return [n.func];
    case 'Function': return [n.body];
    case 'If': {
      const arr = [];
      for (const c of n.clauses) { arr.push(c.cond); arr.push(c.body); }
      if (n.elseBody) arr.push(n.elseBody);
      return arr;
    }
    case 'NumFor': {
      const arr = [n.init, n.limit];
      if (n.step) arr.push(n.step);
      arr.push(n.body);
      return arr;
    }
    case 'While': return [n.cond, n.body];
    case 'Return': return n.exprs;
    case 'Assign': return n.targets.concat(n.exprs);
    case 'CallStmt': return [n.call];
    case 'Bin': return [n.l, n.r];
    case 'Un': return [n.e];
    case 'Field': return [n.obj];
    case 'Index': return [n.obj, n.key];
    case 'Call': return [n.fn].concat(n.args);
    case 'Table': return n.entries.map(e => e.value);
    case 'Do': return [n.body];
    default: return [];
  }
}

function linkParents(root) {
  const parentOf = new Map();
  const byId = new Map();
  const all = [];
  (function walk(n, parent) {
    parentOf.set(n.id, parent ? parent.id : null);
    byId.set(n.id, n);
    all.push(n);
    for (const c of childrenOf(n)) walk(c, n);
  })(root, null);
  return { parentOf, byId, all };
}

/* ---------------- 3. 值的格式化 ---------------- */
function fmtVal(v, depth) {
  depth = depth || 0;
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return "'" + v + "'";
  if (v.t === 'fn') return 'fn ' + (v.name || '匿名');
  if (v.t === 'builtin') return v.name + '()';
  if (v.t === 'table') {
    if (depth >= 1) return '…';
    const keys = (v.order && v.order.length ? v.order : Object.keys(v.map)).slice(0, 4);
    const body = keys.map(k => k + '=' + fmtVal(v.map[k], depth + 1)).join(', ');
    return 't' + v.id + ' {' + body + (keys.length >= 4 ? ', …' : '') + '}';
  }
  return String(v);
}

function fmtShort(v) {
  const s = fmtVal(v);
  return s.length > 16 ? s.slice(0, 15) + '…' : s;
}

function toStringLua(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fmtVal(v);
}

/* ---------------- 4. 解释器（显式事件流 / trace） ---------------- */
class ReturnSignal {
  constructor(values) { this.values = values; }
}

function run(ast, src, opts) {
  opts = opts || {};
  const maxEvents = opts.maxEvents || 40000;
  const maxDepth = opts.maxDepth || 10;
  const maxLoop = opts.maxLoop || 500;

  const events = [];
  let frame = 0;
  let callSeq = 0;
  let tableSeq = 0;
  let depth = 0;

  const globals = { vars: new Map(), parent: null };
  installStdLibs();

  function ev(e) {
    e.f = frame;
    events.push(e);
    if (events.length > maxEvents) throw new Error('事件数超过原型上限（' + maxEvents + '）——把示例调小一点（比如 n 改小）或减少循环次数再试');
  }

  function lookup(env, name) {
    let e = env;
    while (e) {
      if (e.vars.has(name)) return e.vars.get(name);
      e = e.parent;
    }
    return undefined;
  }
  function getVar(env, name) {
    const v = lookup(env, name);
    return v === undefined ? null : v;
  }
  function assignVar(env, name, value) {
    let e = env;
    while (e) {
      if (e.vars.has(name)) { e.vars.set(name, value); return; }
      e = e.parent;
    }
    globals.vars.set(name, value);
  }
  function truthy(v) { return !(v === null || v === false); }
  function numify(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
    throw new Error('需要数字，实际是 ' + fmtVal(v));
  }
  function eq(a, b) {
    if (a && a.t === 'table' && b && b.t === 'table') return a === b;
    return a === b;
  }
  function binop(op, a, b) {
    switch (op) {
      case '+': return numify(a) + numify(b);
      case '-': return numify(a) - numify(b);
      case '*': return numify(a) * numify(b);
      case '/': return numify(a) / numify(b);
      case '//': return Math.floor(numify(a) / numify(b));
      case '%': return numify(a) % numify(b);
      case '^': return Math.pow(numify(a), numify(b));
      case '..': return toStringLua(a) + toStringLua(b);
      case '==': return eq(a, b);
      case '~=': return !eq(a, b);
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '&': return numify(a) & numify(b);
      case '|': return numify(a) | numify(b);
      case '~': return numify(a) ^ numify(b);
      case '<<': return numify(a) << numify(b);
      case '>>': return numify(a) >>> numify(b);
      default: throw new Error('未知运算符 ' + op);
    }
  }
  function fieldPath(tgt) {
    if (tgt.obj && tgt.obj.k === 'Var') return tgt.obj.name + '.' + tgt.name;
    return '?.' + tgt.name;
  }
  function makeFn(fnNode, closure) {
    return { t: 'fn', name: fnNode.name, params: fnNode.params, body: fnNode.body, closure };
  }

  function luaTypeName(v) {
    if (v === null || v === undefined) return 'nil';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'string';
    if (typeof v === 'boolean') return 'boolean';
    if (v && v.t === 'table') return 'table';
    if (v && (v.t === 'fn' || v.t === 'builtin')) return 'function';
    return 'userdata';
  }
  function arrayLen(tb) {
    let i = 0;
    while (Object.prototype.hasOwnProperty.call(tb.map, i + 1)) i++;
    return i;
  }
  function lenOf(v) {
    if (typeof v === 'string') return v.length;
    if (v && v.t === 'table') return arrayLen(v);
    throw new Error('不能对 ' + fmtVal(v) + ' 取长度（#）');
  }
  function tableGet(o, key) {
    if (o === null || o === undefined) throw new Error('尝试索引 nil');
    if (!o || o.t !== 'table') throw new Error('尝试索引非表值（' + fmtVal(o) + '）');
    if (key === null || key === undefined) throw new Error('尝试用 nil 作为表下标');
    return Object.prototype.hasOwnProperty.call(o.map, key) ? o.map[key] : null;
  }
  function tableSet(o, key, val) {
    if (!o || o.t !== 'table') throw new Error('不能给非表值赋值');
    o.map[key] = val;
    if (!o.order) o.order = [];
    if (o.order.indexOf(key) < 0) {
      if (typeof key === 'number' && o.order.every(k => typeof k === 'number')) {
        o.order.push(key);
        o.order.sort((x, y) => x - y);
      } else {
        o.order.push(key);
      }
    }
  }
  function targetName(tgt) {
    if (tgt.k === 'Var') return tgt.name;
    if (tgt.k === 'Field') return fieldPath(tgt);
    if (tgt.k === 'Index') return (tgt.obj && tgt.obj.k === 'Var' ? tgt.obj.name : '?') + '[…]';
    return '?';
  }
  function makeLib(def) {
    const tb = { t: 'table', id: ++tableSeq, map: Object.create(null), order: [] };
    for (const k of Object.keys(def)) {
      tb.map[k] = { t: 'builtin', name: k, fn: def[k] };
      tb.order.push(k);
    }
    return tb;
  }
  function installStdLibs() {
    globals.vars.set('print', { t: 'builtin', name: 'print' });
    globals.vars.set('tonumber', { t: 'builtin', name: 'tonumber', fn: (a) => {
      const v = a[0];
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const s = v.trim();
        if (s === '') return null;
        const n = Number(s);
        return isNaN(n) ? null : n;
      }
      return null;
    } });
    globals.vars.set('tostring', { t: 'builtin', name: 'tostring', fn: (a) => toStringLua(a[0]) });
    globals.vars.set('type', { t: 'builtin', name: 'type', fn: (a) => luaTypeName(a[0]) });
    globals.vars.set('assert', { t: 'builtin', name: 'assert', fn: (a) => {
      if (!truthy(a[0])) throw new Error(a[1] != null ? toStringLua(a[1]) : 'assertion failed!');
      return a[0];
    } });
    globals.vars.set('error', { t: 'builtin', name: 'error', fn: (a) => { throw new Error(toStringLua(a[0])); } });
    globals.vars.set('math', makeLib({
      floor: (a) => Math.floor(numify(a[0])),
      ceil: (a) => Math.ceil(numify(a[0])),
      abs: (a) => Math.abs(numify(a[0])),
      sqrt: (a) => Math.sqrt(numify(a[0])),
      max: (a) => Math.max.apply(null, a.map((x) => numify(x))),
      min: (a) => Math.min.apply(null, a.map((x) => numify(x))),
      random: (a) => {
        if (!a.length) return Math.random();
        if (a.length === 1) return 1 + Math.floor(Math.random() * numify(a[0]));
        const lo = numify(a[0]);
        const hi = numify(a[1]);
        return lo + Math.floor(Math.random() * (hi - lo + 1));
      }
    }));
    globals.vars.set('string', makeLib({
      format: (a) => {
        const fmt = toStringLua(a[0]);
        let out = '';
        let argi = 1;
        for (let i = 0; i < fmt.length; i++) {
          if (fmt[i] === '%' && i + 1 < fmt.length) {
            const c = fmt[++i];
            if (c === '%') { out += '%'; continue; }
            const v = a[argi++];
            if (c === 'd' || c === 'i') out += String(Math.trunc(numify(v)));
            else if (c === 'f') out += String(numify(v));
            else if (c === 'x') out += Math.trunc(numify(v)).toString(16);
            else if (c === 'q') out += '"' + toStringLua(v) + '"';
            else out += toStringLua(v);
          } else out += fmt[i];
        }
        return out;
      },
      sub: (a) => {
        const s = toStringLua(a[0]);
        const i = Math.trunc(numify(a[1]));
        const j = a.length > 2 ? Math.trunc(numify(a[2])) : s.length;
        return s.substring(i - 1, j);
      },
      rep: (a) => {
        const s = toStringLua(a[0]);
        const n = a.length > 1 ? Math.trunc(numify(a[1])) : 1;
        return s.repeat(Math.max(0, n));
      },
      len: (a) => toStringLua(a[0]).length,
      upper: (a) => toStringLua(a[0]).toUpperCase(),
      lower: (a) => toStringLua(a[0]).toLowerCase(),
      reverse: (a) => toStringLua(a[0]).split('').reverse().join('')
    }));
    globals.vars.set('table', makeLib({
      insert: (a) => {
        const tb = a[0];
        if (!tb || tb.t !== 'table') throw new Error('table.insert 需要一个表');
        const n = arrayLen(tb);
        const pos = a.length > 2 ? Math.trunc(numify(a[1])) : n + 1;
        const val = a.length > 2 ? a[2] : a[1];
        for (let i = n; i >= pos; i--) tb.map[i + 1] = tb.map[i];
        tb.map[pos] = val;
        tb.order = [];
        for (let i = 1; i <= n + 1; i++) if (Object.prototype.hasOwnProperty.call(tb.map, i)) tb.order.push(i);
        return null;
      },
      concat: (a) => {
        const tb = a[0];
        if (!tb || tb.t !== 'table') throw new Error('table.concat 需要一个表');
        const sep = a.length > 1 ? toStringLua(a[1]) : '';
        const out = [];
        for (let i = 1; i <= arrayLen(tb); i++) out.push(toStringLua(tb.map[i]));
        return out.join(sep);
      }
    }));
    const argTable = { t: 'table', id: ++tableSeq, map: Object.create(null), order: [] };
    argTable.map[1] = '6';
    argTable.order.push(1);
    globals.vars.set('arg', argTable);
  }

  function evalExpr(node, env) {
    ev({ t: 'ent', id: node.id, k: node.k, span: node.span });
    let v;
    switch (node.k) {
      case 'Num': v = node.v; break;
      case 'Str': v = node.v; break;
      case 'Bool': v = node.v; break;
      case 'Nil': v = null; break;
      case 'Var': v = getVar(env, node.name); break;
      case 'Field': {
        const o = evalExpr(node.obj, env);
        if (!o || o.t !== 'table') throw new Error('尝试索引非表值（' + fmtVal(o) + '）');
        v = Object.prototype.hasOwnProperty.call(o.map, node.name) ? o.map[node.name] : null;
        break;
      }
      case 'Index': {
        const o = evalExpr(node.obj, env);
        const key = evalExpr(node.key, env);
        v = tableGet(o, key);
        break;
      }
      case 'Bin': {
        if (node.op === 'and') {
          const a = evalExpr(node.l, env);
          v = truthy(a) ? evalExpr(node.r, env) : a;
        } else if (node.op === 'or') {
          const a = evalExpr(node.l, env);
          v = truthy(a) ? a : evalExpr(node.r, env);
        } else {
          const a = evalExpr(node.l, env);
          const b = evalExpr(node.r, env);
          v = binop(node.op, a, b);
        }
        break;
      }
      case 'Un': {
        const a = evalExpr(node.e, env);
        if (node.op === '-') v = -numify(a);
        else if (node.op === 'not') v = !truthy(a);
        else if (node.op === '#') v = lenOf(a);
        else if (node.op === '~') v = ~numify(a);
        else throw new Error('未知一元运算符 ' + node.op);
        break;
      }
      case 'Table': {
        const t = { t: 'table', id: ++tableSeq, map: Object.create(null), order: [] };
        let idx = 0;
        for (const en of node.entries) {
          if (en.key !== null) {
            t.map[en.key] = evalExpr(en.value, env);
            t.order.push(en.key);
          } else {
            idx++;
            t.map[idx] = evalExpr(en.value, env);
            t.order.push(idx);
          }
        }
        v = t;
        break;
      }
      case 'Call': v = evalCall(node, env); break;
      default: throw new Error('无法求值节点 ' + node.k);
    }
    ev({ t: 'val', id: node.id, v });
    return v;
  }

  function evalCall(node, env) {
    const callee = evalExpr(node.fn, env);
    const args = [];
    for (const a of node.args) args.push(evalExpr(a, env));

    if (callee && callee.t === 'builtin') {
      if (callee.name === 'print') {
        const text = args.map(toStringLua).join('\t');
        ev({ t: 'print', text });
        return null;
      }
      if (typeof callee.fn === 'function') return callee.fn(args);
      throw new Error('未知内建函数 ' + callee.name);
    }
    if (!callee || callee.t !== 'fn') throw new Error('尝试调用非函数值（' + fmtVal(callee) + '）');
    if (depth >= maxDepth) throw new Error('原型限制：递归层数超过 ' + maxDepth);

    depth++;
    const caller = frame;
    const newFrame = ++callSeq;
    ev({ t: 'call', id: node.id, name: callee.name || '匿名', nf: newFrame, argc: args.length });
    frame = newFrame;

    const callEnv = { vars: new Map(), parent: callee.closure };
    callee.params.forEach((pName, i) => {
      const v = i < args.length ? args[i] : null;
      callEnv.vars.set(pName, v);
      ev({ t: 'set', name: pName, v: v, id: node.id });
    });

    let retVal = null;
    try {
      execBlock(callee.body.stmts, callEnv);
    } catch (err) {
      if (err instanceof ReturnSignal) retVal = err.values.length ? err.values[0] : null;
      else throw err;
    }
    ev({ t: 'ret', id: node.id, name: callee.name || '匿名', v: retVal });
    frame = caller;
    depth--;
    return retVal;
  }

  function execBlock(stmts, env) {
    for (const s of stmts) execStmt(s, env);
  }

  function execStmt(node, env) {
    ev({ t: 'ent', id: node.id, k: node.k, span: node.span });
    switch (node.k) {
      case 'Local': {
        for (let i = 0; i < node.names.length; i++) {
          const v = node.exprs[i] ? evalExpr(node.exprs[i], env) : null;
          env.vars.set(node.names[i], v);
          ev({ t: 'set', name: node.names[i], v: v, id: node.id });
        }
        break;
      }
      case 'LocalFunction': {
        const fn = makeFn(node.func, env);
        env.vars.set(node.name, fn);
        ev({ t: 'set', name: node.name, v: fn, id: node.id });
        break;
      }
      case 'FunctionDecl': {
        const fn = makeFn(node.func, env);
        assignVar(env, node.name, fn);
        ev({ t: 'set', name: node.name, v: fn, id: node.id });
        break;
      }
      case 'Assign': {
        for (let i = 0; i < node.targets.length; i++) {
          const val = evalExpr(node.exprs[i], env);
          const tgt = node.targets[i];
          if (tgt.k === 'Var') {
            assignVar(env, tgt.name, val);
            ev({ t: 'set', name: tgt.name, v: val, id: tgt.id });
          } else if (tgt.k === 'Field') {
            const obj = evalExpr(tgt.obj, env);
            if (!obj || obj.t !== 'table') throw new Error('不能给非表字段赋值');
            obj.map[tgt.name] = val;
            if (!obj.order) obj.order = [];
            if (obj.order.indexOf(tgt.name) < 0) obj.order.push(tgt.name);
            ev({ t: 'set', name: fieldPath(tgt), v: val, id: tgt.id });
          } else if (tgt.k === 'Index') {
            const obj = evalExpr(tgt.obj, env);
            const key = evalExpr(tgt.key, env);
            tableSet(obj, key, val);
            ev({ t: 'set', name: targetName(tgt), v: val, id: tgt.id });
          } else throw new Error('不支持的赋值目标');
        }
        break;
      }
      case 'CallStmt': evalExpr(node.call, env); break;
      case 'If': {
        let done = false;
        for (const c of node.clauses) {
          if (truthy(evalExpr(c.cond, env))) {
            execBlock(c.body.stmts, env);
            done = true;
            break;
          }
        }
        if (!done && node.elseBody) execBlock(node.elseBody.stmts, env);
        break;
      }
      case 'NumFor': {
        const a = numify(evalExpr(node.init, env));
        const b = numify(evalExpr(node.limit, env));
        const st = node.step ? numify(evalExpr(node.step, env)) : 1;
        if (st === 0) throw new Error('for 步长为 0');
        const fenv = { vars: new Map(), parent: env };
        let v = a;
        let guard = 0;
        while (st > 0 ? v <= b : v >= b) {
          if (++guard > maxLoop) throw new Error('原型限制：循环次数超过 ' + maxLoop);
          fenv.vars.set(node.name, v);
          ev({ t: 'iter', id: node.id, name: node.name, v: v });
          execBlock(node.body.stmts, fenv);
          v += st;
        }
        break;
      }
      case 'While': {
        let guard = 0;
        while (truthy(evalExpr(node.cond, env))) {
          if (++guard > maxLoop) throw new Error('原型限制：循环次数超过 ' + maxLoop);
          execBlock(node.body.stmts, env);
        }
        break;
      }
      case 'Return': {
        const vals = node.exprs.map(e => evalExpr(e, env));
        ev({ t: 'cls', id: node.id });
        throw new ReturnSignal(vals);
      }
      case 'Do': execBlock(node.body.stmts, env); break;
      case 'Block': execBlock(node.stmts, env); break;
      default: throw new Error('无法执行节点 ' + node.k);
    }
    ev({ t: 'cls', id: node.id });
  }

  try {
    execBlock(ast.stmts, globals);
    ev({ t: 'end' });
  } catch (err) {
    if (err instanceof ReturnSignal) {
      ev({ t: 'end' });
    } else {
      events.push({ t: 'error', f: frame, message: String((err && err.message) || err) });
    }
  }
  return { events, calls: callSeq, tables: tableSeq };
}

function compileProgram(src) {
  const ast = parse(src);
  const link = linkParents(ast);
  for (const n of link.all) {
    n._tight = src.slice(n.span[0], n.span[1]).indexOf('\n') < 0;
  }
  const trace = run(ast, src);
  return { ast, src, byId: link.byId, parentOf: link.parentOf, all: link.all, trace };
}

/* ---------------- 5. 示例程序 ---------------- */
const PROGRAMS = {
  loop: {
    label: '循环求和',
    src: [
      'local sum = 0',
      'for i = 1, 4 do',
      '  sum = sum + i * i',
      'end',
      'print(sum)'
    ].join('\n')
  },
  fact: {
    label: '递归调用',
    src: [
      'local function fact(n)',
      '  if n <= 1 then',
      '    return 1',
      '  end',
      '  return n * fact(n - 1)',
      'end',
      'print(fact(3))'
    ].join('\n')
  },
  alias: {
    label: '表别名',
    src: [
      'local a = {x = 1, y = 2}',
      'local b = a',
      'b.x = 10',
      'print(a.x + b.y)'
    ].join('\n')
  },
  queens: {
    label: 'N 皇后（位运算）',
    src: [
      '-- N 皇后：位运算回溯（Lua 5.3+）',
      'local n = tonumber(arg and arg[1]) or 12',
      'assert(n >= 1 and n <= 20, "n 建议在 1..20 之间")',
      '',
      'local full = (1 << n) - 1',
      'local count = 0',
      '',
      'local function dfs(cols, diag1, diag2)',
      '  if cols == full then',
      '    count = count + 1',
      '    return',
      '  end',
      '  local avail = full & ~(cols | diag1 | diag2)',
      '  while avail ~= 0 do',
      '    local bit = avail & -avail',
      '    avail = avail ~ bit',
      '    dfs(cols | bit, (diag1 | bit) << 1, (diag2 | bit) >> 1)',
      '  end',
      'end',
      '',
      'dfs(0, 0, 0)',
      'print(count)'
    ].join('\n')
  }
};

/* ---------------- 6. 渲染：常量与工具 ---------------- */
const PALETTE = ['#4f46e5', '#0f766e', '#b45309', '#be185d', '#7c3aed', '#0369a1'];
const TABLE_PALETTE = ['#4f46e5', '#0f766e', '#b45309', '#be185d', '#7c3aed'];

const KIND_NAME = {
  Chunk: ['程序', 'chunk'], Block: ['语句块', 'block'], Local: ['局部变量声明', 'local declaration'],
  LocalFunction: ['局部函数定义', 'local function'], FunctionDecl: ['函数定义', 'function definition'],
  Function: ['函数体', 'function body'], If: ['条件分支', 'if branch'], NumFor: ['数值 for 循环', 'numeric for loop'],
  While: ['while 循环', 'while loop'], Return: ['返回', 'return'], Assign: ['赋值', 'assignment'],
  CallStmt: ['调用语句', 'call statement'], Bin: ['二元运算', 'binary operation'], Un: ['一元运算', 'unary operation'],
  Num: ['数字', 'number'], Str: ['字符串', 'string'], Bool: ['布尔值', 'boolean'], Nil: ['nil', 'nil'],
  Var: ['变量引用', 'variable'], Field: ['字段访问', 'field access'], Index: ['下标访问', 'index access'],
  Call: ['函数调用', 'function call'], Table: ['表构造', 'table constructor'], Do: ['do 块', 'do block']
};

const KIND_CAT = {
  Chunk: 'blk', Block: 'blk',
  Local: 'stmt', LocalFunction: 'stmt', FunctionDecl: 'stmt', Function: 'stmt',
  If: 'stmt', NumFor: 'stmt', While: 'stmt', Return: 'stmt', Assign: 'stmt', CallStmt: 'stmt',
  Bin: 'op', Un: 'op', Num: 'lit', Str: 'lit', Bool: 'lit', Nil: 'lit',
  Var: 'id', Field: 'id', Index: 'id', Call: 'call', Table: 'lit', Do: 'stmt'
};

/* ---------------- 6.5 国际化（简体中文 / English） ---------------- */
const LANG_LS_KEY = 'lua-mindscape:lang';
const LAYOUT_LS_KEY = 'lua-mindscape:layout';

const I18N = {
  zh: {
    'doc.title': 'Lua 思维可视化 · 交互式语法树原型',
    'brand': 'Lua 思维可视化',
    'tag': '交互原型 v0.1',
    'chip.loop': '① 循环求和',
    'chip.fact': '② 递归调用',
    'chip.alias': '③ 表别名',
    'chip.queens': '④ N 皇后',
    'pane.code': '源代码',
    'pane.output': '输出',
    'pane.tree': '语法树 · 思考轨迹',
    'pane.state': '运行状态',
    'hint.code': '点代码编辑 · 靛蓝 = 求值中 · 琥珀 = 外层帧',
    'hint.codeEdit': '编辑中 · Ctrl+Enter 运行 · Tab 缩进 · Esc 取消',
    'hint.tree': '方框 = 当前节点 · 数字 = 求值结果 · ×n = 重复热点 · 右上切换布局',
    'hint.state': '栈帧 · 作用域',
    'speed': '速度',
    'btn.reset': '回到开头 (R)',
    'btn.prev': '上一步 (←)',
    'btn.play': '播放 / 暂停 (空格)',
    'btn.next': '下一步 (→)',
    'btn.zoomOut': '缩小',
    'btn.zoomIn': '放大',
    'btn.zoomFit': '回到跟随',
    'btn.layout': '布局：规整 / 神经元',
    'layout.grid': '▦ 规整',
    'layout.neuron': '◉ 神经元',
    'btn.edit': '编辑代码',
    'btn.editRun': '运行并退出编辑 (Ctrl+Enter)',
    'btn.run': '▶ 运行',
    'btn.restore': '↺ 示例',
    'btn.new': '新建代码',
    'btn.newText': '+ 新建',
    'btn.import': '导入 Lua 文件',
    'btn.importText': '导入',
    'hint.new': '新程序 · Ctrl+Enter 运行',
    'hint.imported': '已导入 {name}',
    'err.file': '文件读取失败',
    'btn.cancel': '取消编辑 (Esc)',
    'btn.lang': '切换语言 / Switch language',
    'aria.samples': '示例程序',
    'btn.install': '⤓ 安装应用',
    'btn.install.title': '安装到桌面 / 主屏幕',
    'install.hint': '在浏览器菜单中选择「安装应用 / 添加到主屏幕」即可安装',
    'footnote': '原型说明：解析器 / 解释器 / trace 回放均为简化版 JavaScript 实现，仅用于验证交互与视觉；正式版核心为 Rust（full-moon 解析 + 显式状态机解释器）→ WebAssembly。',
    'frame.main': '主函数',
    'frame.mainTag': 'main',
    'frame.idx': '栈帧 #{n}',
    'noLocals': '（暂无局部变量）',
    'frames.more': '另有 {n} 层调用栈',
    'ready': '准备执行…',
    'ev.enter': '进入 <b>{kind}</b>',
    'ev.finish': '完成 <b>{kind}</b>',
    'ev.value': '求值 <b>{v}</b>',
    'ev.assign': '赋值 <b>{name}</b> = <b>{v}</b>',
    'ev.call': '进入函数 <b>{name}(…)</b> · 新栈帧 #{nf}',
    'ev.ret': '从 <b>{name}(…)</b> 返回 <b>{v}</b>',
    'ev.iter': '<b>for</b> 迭代：{name} = <b>{v}</b>',
    'ev.print': '输出 <b>{text}</b>',
    'ev.end': '程序执行完毕 ✓',
    'ev.error': '运行时错误：{msg}',
    'label.callStmt': '调用语句',
    'label.block': '块',
    'err.parse': '解析失败：',
    'err.start': '启动失败：',
    'install.title': '安装到桌面 / 主屏幕'
  },
  en: {
    'doc.title': 'Lua Mindscape · Interactive AST Prototype',
    'brand': 'Lua Mindscape',
    'tag': 'interactive prototype v0.1',
    'chip.loop': '① Loop sum',
    'chip.fact': '② Recursion',
    'chip.alias': '③ Table alias',
    'chip.queens': '④ N-Queens',
    'pane.code': 'Source code',
    'pane.output': 'Output',
    'pane.tree': 'AST · thought trace',
    'pane.state': 'Runtime state',
    'hint.code': 'Click code to edit · indigo = evaluating · amber = caller frame',
    'hint.codeEdit': 'Editing · Ctrl+Enter to run · Tab to indent · Esc to cancel',
    'hint.tree': 'box = current node · numbers = computed value · ×n = repetition hotspot · switch layout at top-right',
    'hint.state': 'frames · scopes',
    'speed': 'Speed',
    'btn.reset': 'Restart (R)',
    'btn.prev': 'Previous step (←)',
    'btn.play': 'Play / pause (Space)',
    'btn.next': 'Next step (→)',
    'btn.zoomOut': 'Zoom out',
    'btn.zoomIn': 'Zoom in',
    'btn.zoomFit': 'Follow current node',
    'btn.layout': 'Layout: grid / neuron',
    'layout.grid': '▦ Grid',
    'layout.neuron': '◉ Neuron',
    'btn.edit': 'Edit code',
    'btn.editRun': 'Run and leave editor (Ctrl+Enter)',
    'btn.run': '▶ Run',
    'btn.restore': '↺ Sample',
    'btn.new': 'New code',
    'btn.newText': '+ New',
    'btn.import': 'Import Lua file',
    'btn.importText': 'Import',
    'hint.new': 'New program · Ctrl+Enter to run',
    'hint.imported': 'imported {name}',
    'err.file': 'Could not read the file',
    'btn.cancel': 'Cancel editing (Esc)',
    'btn.lang': '切换语言 / Switch language',
    'aria.samples': 'sample programs',
    'btn.install': '⤓ Install app',
    'btn.install.title': 'Install to desktop / home screen',
    'install.hint': 'Use the browser menu → “Install app / Add to Home Screen” to install',
    'footnote': 'Prototype note: parser, interpreter and trace playback are simplified JavaScript implementations, used only to validate interaction and visuals. The production core is Rust (full-moon parser + explicit-state interpreter) → WebAssembly.',
    'frame.main': 'main',
    'frame.mainTag': 'main',
    'frame.idx': 'frame #{n}',
    'noLocals': '(no locals yet)',
    'frames.more': '{n} more frame(s)',
    'ready': 'ready…',
    'ev.enter': 'enter <b>{kind}</b>',
    'ev.finish': 'finish <b>{kind}</b>',
    'ev.value': 'value <b>{v}</b>',
    'ev.assign': 'assign <b>{name}</b> = <b>{v}</b>',
    'ev.call': 'call <b>{name}(…)</b> · new frame #{nf}',
    'ev.ret': 'return from <b>{name}(…)</b> → <b>{v}</b>',
    'ev.iter': '<b>for</b> iteration: {name} = <b>{v}</b>',
    'ev.print': 'output <b>{text}</b>',
    'ev.end': 'program finished ✓',
    'ev.error': 'runtime error: {msg}',
    'label.callStmt': 'call stmt',
    'label.block': 'block',
    'err.parse': 'parse error: ',
    'err.start': 'failed to start: ',
    'install.title': 'Install to desktop / home screen'
  }
};

function t(key, params) {
  const table = I18N[app && app.lang === 'en' ? 'en' : 'zh'] || I18N.zh;
  let s = table[key] != null ? table[key] : (I18N.zh[key] != null ? I18N.zh[key] : key);
  if (params) {
    s = String(s).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : ''));
  }
  return s;
}

function kindName(k) {
  const pair = KIND_NAME[k];
  if (!pair) return '';
  return app && app.lang === 'en' ? pair[1] : pair[0];
}

function readSavedLang() {
  try { return localStorage.getItem(LANG_LS_KEY) || ''; } catch (err) { return ''; }
}
function writeSavedLang(lang) {
  try { localStorage.setItem(LANG_LS_KEY, lang); } catch (err) { /* noop */ }
}

function isCompactUI() {
  return typeof window !== 'undefined' && window.matchMedia &&
    window.matchMedia('(max-width:520px)').matches;
}

/* 手机端布局按钮只显示图标，把宽度留给缩放控件 */
function updateLayoutButton() {
  const btn = $('#btnLayout');
  if (!btn) return;
  const icon = app.layoutMode === 'neuron' ? '◉' : '▦';
  btn.dataset.icon = icon;
  btn.title = t('btn.layout');
  btn.textContent = isCompactUI() ? icon : (app.layoutMode === 'neuron' ? t('layout.neuron') : t('layout.grid'));
}

function applyI18n() {
  document.documentElement.lang = app.lang === 'en' ? 'en' : 'zh-CN';
  document.title = t('doc.title');
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  const langBtn = $('#btnLang');
  if (langBtn) {
    langBtn.textContent = app.lang === 'zh' ? 'EN' : '中';
    langBtn.title = t('btn.lang');
  }
  const installBtn = $('#btnInstall');
  if (installBtn) installBtn.title = t('btn.install.title');
  const runBtn = $('#btnRun');
  if (runBtn) runBtn.textContent = t('btn.run');
  const restoreBtn = $('#btnRestore');
  if (restoreBtn) restoreBtn.textContent = t('btn.restore');
  const editBtn = $('#btnEdit');
  if (editBtn) editBtn.title = app.editing ? t('btn.editRun') : t('btn.edit');
  setCodeHint(app.editing ? t('hint.codeEdit') : t('hint.code'));
  if (app.byId && app.nodeEls) {
    for (const [id, nd] of app.byId) {
      const el = app.nodeEls.get(id);
      if (el) el.title = kindName(nd.k) + '  [' + nd.span[0] + '..' + nd.span[1] + ']';
    }
  }
  updateLayoutButton();
  const stepLabel = $('#steplabel');
  if (stepLabel && !app.trace) stepLabel.textContent = t('ready');
}

function setLang(lang) {
  app.lang = lang === 'en' ? 'en' : 'zh';
  writeSavedLang(app.lang);
  applyI18n();
  if (app.trace) {
    buildCode();
    buildTree();
    seek(app.traceIdx);
    applyView();
  }
  if (app.editing) positionEditor();
  applyEditUi(!!app.editing);
}

function $(sel) { return document.querySelector(sel); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function shorten(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function tableColor(id) { return TABLE_PALETTE[(Math.max(1, id) - 1) % TABLE_PALETTE.length]; }

function labelOf(n) {
  switch (n.k) {
    case 'Bin': return n.op;
    case 'Un': return n.op;
    case 'Num': return String(n.v);
    case 'Str': return '"' + shorten(n.v, 8) + '"';
    case 'Bool': return String(n.v);
    case 'Nil': return 'nil';
    case 'Var': return n.name;
    case 'Field': return '.' + n.name;
    case 'Index': return '[ ]';
    case 'Do': return 'do';
    case 'Call': return 'call';
    case 'Table': return '{ }';
    case 'Local': return n.names.join(', ') + ' =';
    case 'LocalFunction': return 'local ' + n.name + '()';
    case 'FunctionDecl': return 'function ' + n.name + '()';
    case 'Function': return 'fn(' + n.params.join(',') + ')';
    case 'If': return 'if …';
    case 'NumFor': return 'for ' + n.name + ' =';
    case 'While': return 'while';
    case 'Return': return 'return';
    case 'Assign': return n.targets.map(tg => tg.k === 'Var' ? tg.name : tg.k === 'Field' ? '.' + tg.name : '[...]').join(',') + ' =';
    case 'CallStmt': return t('label.callStmt');
    case 'Block': return t('label.block');
    case 'Chunk': return 'chunk';
    default: return n.k;
  }
}

function eventLabel(e) {
  const nd = e.id != null ? app.byId.get(e.id) : null;
  const snip = nd ? esc(shorten(app.src.slice(nd.span[0], nd.span[1]).replace(/\s+/g, ' ').trim(), 42)) : '';
  const ssp = snip ? ' <span class="snip">' + snip + '</span>' : '';
  switch (e.t) {
    case 'ent': return t('ev.enter', { kind: esc(kindName(nd ? nd.k : '')) }) + ssp;
    case 'cls': return t('ev.finish', { kind: esc(kindName(nd ? nd.k : '')) }) + ssp;
    case 'val': return t('ev.value', { v: esc(fmtShort(e.v)) }) + ssp;
    case 'set': return t('ev.assign', { name: esc(e.name), v: esc(fmtShort(e.v)) });
    case 'call': return t('ev.call', { name: esc(e.name), nf: e.nf });
    case 'ret': return t('ev.ret', { name: esc(e.name), v: esc(fmtShort(e.v)) });
    case 'iter': return t('ev.iter', { name: esc(e.name), v: esc(fmtShort(e.v)) });
    case 'print': return t('ev.print', { text: esc(e.text) });
    case 'end': return t('ev.end');
    case 'error': return '<span class="err-inline">' + t('ev.error', { msg: esc(e.message) }) + '</span>';
    default: return '';
  }
}

/* ---------------- 7. 应用状态 ---------------- */
const app = {
  key: 'loop',
  src: '',
  ast: null,
  trace: null,
  byId: new Map(),
  parentOf: new Map(),
  nodeEls: new Map(),
  edgeEls: new Map(),
  tokenEls: [],
  lineEls: [],
  starts: [],
  lines: [],
  traceIdx: 0,
  state: null,
  playing: false,
  timer: 0,
  speed: 180,
  scale: 1,
  tx: 0,
  ty: 0,
  userPanned: false,
  dragging: null,
  suppressClick: false,
  treeW: 0,
  treeH: 0,
  curId: null,
  editing: false,
  editBackup: null,
  lang: 'zh',
  layoutMode: 'grid'
};

/* ---------------- 8. 回放状态机 ---------------- */
function createState() {
  return {
    open: [],
    framesView: [{ id: 0, name: t('frame.main'), vars: new Map() }],
    values: new Map(),
    counts: new Map(),
    done: new Set(),
    outputs: [],
    iter: null,
    last: null
  };
}

function applyEvent(st, e) {
  st.last = e;
  switch (e.t) {
    case 'ent':
      st.open.push({ id: e.id, f: e.f });
      st.counts.set(e.id, (st.counts.get(e.id) || 0) + 1);
      break;
    case 'cls':
      st.open = st.open.filter(o => !(o.id === e.id && o.f === e.f));
      st.done.add(e.id);
      break;
    case 'val':
      st.open = st.open.filter(o => !(o.id === e.id && o.f === e.f));
      st.done.add(e.id);
      st.values.set(e.id, e.v);
      break;
    case 'set': {
      let fr = null;
      for (const f of st.framesView) if (f.id === e.f) fr = f;
      if (!fr) fr = st.framesView[st.framesView.length - 1];
      fr.vars.set(e.name, e.v);
      break;
    }
    case 'call':
      st.framesView.push({ id: e.nf != null ? e.nf : e.f + 1, name: e.name, vars: new Map() });
      break;
    case 'ret':
      st.framesView.pop();
      st.open = st.open.filter(o => o.f !== e.f);
      break;
    case 'iter':
      st.iter = e.v;
      break;
    case 'print':
      st.outputs.push(e.text);
      break;
    case 'error':
      st.outputs.push('[运行时错误] ' + e.message);
      break;
  }
}

function frameCursor(st, fid) {
  for (let i = st.open.length - 1; i >= 0; i--) {
    if (st.open[i].f === fid) return st.open[i].id;
  }
  return null;
}

/* ---------------- 9. 构建：源码 / 语法树 ---------------- */
function buildCode() {
  const codeEl = $('#code');
  codeEl.innerHTML = '';
  const raw = tokenize(app.src);
  const lines = app.src.split('\n');
  const starts = [];
  let off = 0;
  for (const ln of lines) { starts.push(off); off += ln.length + 1; }

  const byLine = lines.map(() => []);
  for (const t of raw) {
    if (t.type === 'eof') continue;
    let li = lineOfRaw(starts, t.start);
    if (li >= 0 && li < lines.length) byLine[li].push(t);
  }

  const lineEls = [];
  const tokenEls = [];
  lines.forEach((ln, i) => {
    const lineEl = document.createElement('div');
    lineEl.className = 'line';
    const num = document.createElement('span');
    num.className = 'ln';
    num.textContent = String(i + 1);
    lineEl.appendChild(num);

    const toks = document.createElement('span');
    toks.className = 'toks';
    let pos = starts[i];
    const end = pos + ln.length;
    for (const t of byLine[i]) {
      if (t.start > pos) toks.appendChild(document.createTextNode(app.src.slice(pos, t.start)));
      const sp = document.createElement('span');
      sp.className = 'tok';
      sp.textContent = app.src.slice(t.start, t.end);
      toks.appendChild(sp);
      tokenEls.push({ el: sp, start: t.start, end: t.end });
      pos = t.end;
    }
    if (pos < end) toks.appendChild(document.createTextNode(app.src.slice(pos, end)));
    if (!ln.length) toks.appendChild(document.createTextNode(' '));
    lineEl.appendChild(toks);
    codeEl.appendChild(lineEl);
    lineEls.push(lineEl);
  });

  app.tokenEls = tokenEls;
  app.lineEls = lineEls;
  app.lines = lines;
  app.starts = starts;
}

function lineOfRaw(starts, offset) {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function lineOf(offset) { return lineOfRaw(app.starts, offset); }

function buildTree() {
  const treeEl = $('#tree');
  treeEl.innerHTML = '';
  app.nodeEls = new Map();
  app.edgeEls = new Map();
  treeEl.classList.toggle('layout-neuron', app.layoutMode === 'neuron');
  treeEl.classList.toggle('layout-grid', app.layoutMode !== 'neuron');

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'edges');
  const gEl = document.createElementNS(NS, 'g');
  svg.appendChild(gEl);
  treeEl.appendChild(svg);

  const ROW = 30;
  const COL = 114;
  const all = [];
  let leaf = 0;
  const hash01 = (seed) => {
    let h = (seed * 2654435761) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = (h * 1274126177) >>> 0;
    return ((h >>> 8) % 1000) / 1000;
  };

  if (app.layoutMode === 'neuron') {
    /* 神经元布局：根在左侧，子树像树突/轴突一样呈扇形伸展，
       节点位置带确定性抖动，使分布不规则但每次刷新都稳定。 */
    (function countLeaves(n) {
      const kids = childrenOf(n);
      n._leafCount = kids.length ? kids.reduce((s, c) => s + countLeaves(c), 0) : 1;
      return n._leafCount;
    })(app.ast);
    (function place(n, x, y, ang, span) {
      n.gx = x;
      n.gy = y;
      const kids = childrenOf(n);
      if (!kids.length) { all.push(n); return; }
      const total = kids.reduce((s, c) => s + c._leafCount, 0);
      let a = ang - span / 2;
      kids.forEach(c => {
        const frac = c._leafCount / total;
        const mid = a + span * frac / 2;
        const jitter = (hash01(c.id) - 0.5) * 0.26;
        const r = 126 + (hash01(c.id * 7 + 3) - 0.5) * 30;
        place(c, x + Math.cos(mid + jitter) * r, y + Math.sin(mid + jitter) * r,
          mid + jitter, Math.max(0.24, span * frac * 1.45));
        a += span * frac;
      });
      all.push(n);
    })(app.ast, 0, 0, 0, 1.55);
    let minX = Infinity;
    let minY = Infinity;
    for (const n of all) { minX = Math.min(minX, n.gx); minY = Math.min(minY, n.gy); }
    for (const n of all) { n.gx += 26 - minX; n.gy += 26 - minY; }
  } else {
    (function place(n, depth) {
      n.gx = depth * COL + 10;
      const kids = childrenOf(n);
      if (!kids.length) {
        n.gy = leaf * ROW;
        leaf++;
      } else {
        kids.forEach((c, i) => {
          if (i > 0) leaf += 0.35; // 兄弟子树之间留呼吸间距，避免不同父节点的分支在视觉上混成一片
          place(c, depth + 1);
        });
        n.gy = (kids[0].gy + kids[kids.length - 1].gy) / 2;
      }
      all.push(n);
    })(app.ast, 0);
  }

  (function create(n) {
    const el = document.createElement('div');
    el.className = 'node c-' + (KIND_CAT[n.k] || 'stmt');
    el.dataset.id = String(n.id);
    el.style.left = n.gx + 'px';
    el.style.top = n.gy + 'px';
    el.innerHTML = '<span class="lbl">' + esc(labelOf(n)) + '</span>' +
      '<span class="val"></span><span class="heat"></span>';
    el.title = kindName(n.k) + '  [' + n.span[0] + '..' + n.span[1] + ']';
    el.addEventListener('click', () => {
      if (app.suppressClick) return;
      jumpToNode(n.id);
    });
    treeEl.appendChild(el);
    app.nodeEls.set(n.id, el);
    n._el = el;
    for (const c of childrenOf(n)) create(c);
  })(app.ast);

  if (app.layoutMode === 'neuron') {
    /* 简单的斥力松弛：节点互相压住时向外推开，让分布自然一些 */
    for (let iter = 0; iter < 48; iter++) {
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i];
          const b = all[j];
          const aw = ((a._el && a._el.offsetWidth) || 60) / 2 + 14;
          const ah = ((a._el && a._el.offsetHeight) || 24) / 2 + 10;
          const bw = ((b._el && b._el.offsetWidth) || 60) / 2 + 14;
          const bh = ((b._el && b._el.offsetHeight) || 24) / 2 + 10;
          let dx = b.gx - a.gx;
          let dy = b.gy - a.gy;
          const overlapX = aw + bw - Math.abs(dx);
          const overlapY = ah + bh - Math.abs(dy);
          if (overlapX > 0 && overlapY > 0) {
            if (dx === 0) dx = 0.01;
            if (dy === 0) dy = 0.01;
            const d = Math.hypot(dx, dy) || 1;
            const push = Math.min(overlapX, overlapY) * 0.5 + 0.5;
            const nx = dx / d;
            const ny = dy / d;
            a.gx -= nx * push;
            a.gy -= ny * push;
            b.gx += nx * push;
            b.gy += ny * push;
          }
        }
      }
    }
    let mnX = Infinity;
    let mnY = Infinity;
    for (const n of all) { mnX = Math.min(mnX, n.gx); mnY = Math.min(mnY, n.gy); }
    for (const n of all) {
      n.gx += 26 - mnX;
      n.gy += 24 - mnY;
      if (n._el) {
        n._el.style.left = n.gx + 'px';
        n._el.style.top = n.gy + 'px';
      }
    }
  }

  let maxX = 0;
  let maxY = 0;
  for (const n of all) {
    maxX = Math.max(maxX, n.gx + n._el.offsetWidth);
    maxY = Math.max(maxY, n.gy + 22);
  }
  const treeW = Math.max(320, maxX + (app.layoutMode === 'neuron' ? 56 : 80));
  const treeH = app.layoutMode === 'neuron'
    ? Math.max(160, maxY + 56)
    : Math.max(160, leaf * ROW + 40);
  app.treeW = treeW;
  app.treeH = treeH;
  treeEl.style.width = treeW + 'px';
  treeEl.style.height = treeH + 'px';
  svg.setAttribute('width', String(treeW));
  svg.setAttribute('height', String(treeH));

  for (const n of all) {
    const pid = app.parentOf.get(n.id);
    if (pid == null) continue;
    const pn = app.byId.get(pid);
    if (!pn) continue;
    const pW = pn._el.offsetWidth || 60;
    const path = document.createElementNS(NS, 'path');
    if (app.layoutMode === 'neuron') {
      const nW = n._el.offsetWidth || 60;
      const x1 = pn.gx + pW / 2;
      const y1 = pn.gy;
      const x2 = n.gx + nW / 2;
      const y2 = n.gy;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const bend = (hash01(n.id * 17 + 5) - 0.5) * len * 0.55;
      const c1x = x1 + ux * len * 0.35 - uy * bend;
      const c1y = y1 + uy * len * 0.35 + ux * bend;
      const c2x = x2 - ux * len * 0.35 - uy * bend * 0.6;
      const c2y = y2 - uy * len * 0.35 + ux * bend * 0.6;
      path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + c1x + ' ' + c1y + ', ' +
        c2x + ' ' + c2y + ', ' + x2 + ' ' + y2);
    } else {
      const x1 = pn.gx + pW;
      const y1 = pn.gy;
      const x2 = n.gx - 3;
      const y2 = n.gy;
      const dx = Math.max(22, (x2 - x1) * 0.6);
      path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' +
        (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2);
    }
    path.setAttribute('class', 'e');
    gEl.appendChild(path);
    app.edgeEls.set(n.id, path);
  }
}

/* ---------------- 10. 视图变换 ---------------- */
function applyView() {
  const el = $('#tree');
  el.style.transform = 'translate(' + app.tx.toFixed(1) + 'px,' + app.ty.toFixed(1) + 'px) scale(' + app.scale + ')';
}

/* 跟随当前节点：只在节点离开「视口内圈」时做最小幅度平移，避免视角快速来回跳动。
 * center=true 用于节点点击 / 缩放复位等明确想居中的场景。 */
function followTo(nodeId, center) {
  if (app.userPanned) return;
  const vp = $('#treeviewport');
  if (!vp) return;
  const W = vp.clientWidth;
  const H = vp.clientHeight;
  if (W < 40 || H < 40) return;
  const n = (nodeId != null && app.byId.get(nodeId)) || app.ast;
  if (!n) return;
  const s = app.scale;
  const nw = (n._el && n._el.offsetWidth) || 70;
  const nh = (n._el && n._el.offsetHeight) || 24;
  const x1 = n.gx * s + app.tx;
  const x2 = (n.gx + nw) * s + app.tx;
  const y1 = n.gy * s + app.ty;
  const y2 = (n.gy + nh) * s + app.ty;
  let dx = 0;
  let dy = 0;
  if (center) {
    dx = W / 2 - (x1 + x2) / 2;
    dy = H / 2 - (y1 + y2) / 2;
  } else {
    /* 只要节点完整地待在视口里就绝不动画面；越界了才一次性把它放到中间 */
    const M = 20;
    if (x2 > W - M || x1 < M || y2 > H - M || y1 < M) {
      dx = W / 2 - (x1 + x2) / 2;
      dy = H / 2 - (y1 + y2) / 2;
    }
  }
  if (!dx && !dy) return;
  app.tx += dx;
  app.ty += dy;
  applyView();
}

/* 缩放到「整棵树刚好放进视口」，并复位到跟随模式 */
function fitTree() {
  const vp = $('#treeviewport');
  if (!vp) return;
  const W = vp.clientWidth - 32;
  const H = vp.clientHeight - 32;
  const s = Math.min(W / Math.max(1, app.treeW), H / Math.max(1, app.treeH));
  app.scale = Math.max(0.7, Math.min(1, Math.round(s * 100) / 100));
  app.userPanned = false;
  $('#tree').classList.remove('nofollow');
  app.tx = (vp.clientWidth - app.treeW * app.scale) / 2;
  app.ty = (vp.clientHeight - app.treeH * app.scale) / 2;
  applyView();
  followTo(app.curId != null ? app.curId : (app.ast && app.ast.id));
}

function zoomBy(f) {
  app.scale = Math.max(0.35, Math.min(1.8, Math.round(app.scale * f * 100) / 100));
  app.userPanned = false;
  $('#tree').classList.remove('nofollow');
  followTo(app.curId != null ? app.curId : (app.ast && app.ast.id), true);
}

function readSavedLayout() {
  try { return localStorage.getItem(LAYOUT_LS_KEY) || ''; } catch (err) { return ''; }
}
function writeSavedLayout(mode) {
  try { localStorage.setItem(LAYOUT_LS_KEY, mode); } catch (err) { /* noop */ }
}
/* 切换布局：grid = 规整；neuron = 神经元 */
function setLayoutMode(mode) {
  const next = mode === 'neuron' ? 'neuron' : 'grid';
  if (next === app.layoutMode && app.trace) return;
  app.layoutMode = next;
  writeSavedLayout(next);
  applyI18n();
  if (app.trace) {
    buildTree();
    app.scale = 1;
    app.userPanned = false;
    fitTree();
    render();
  }
}

/* ---------------- 11. 主渲染 ---------------- */
function render() {
  const st = app.state;
  if (!st) return;
  const nf = st.framesView.length;
  const cursors = st.framesView.map(fr => frameCursor(st, fr.id));
  let cur = cursors[nf - 1];
  if (cur == null && st.last && st.last.id != null) cur = st.last.id;
  const curIdx = nf - 1;
  const pathSet = new Set();
  if (cur != null) {
    let pid = cur;
    let guard = 0;
    while (pid != null && guard++ < 80) {
      pathSet.add(pid);
      pid = app.parentOf.get(pid);
    }
  }
  const parentCursors = new Set();
  for (let i = 0; i < nf - 1; i++) if (cursors[i] != null) parentCursors.add(cursors[i]);

  const curNode = cur != null ? app.byId.get(cur) : null;
  app.curId = cur;

  /* 节点 */
  for (const [id, el] of app.nodeEls) {
    const nd = app.byId.get(id);
    const cls = ['node', 'c-' + (KIND_CAT[nd ? nd.k : ''] || 'stmt')];
    if (cur === id) {
      cls.push('n-active');
      el.style.setProperty('--fc', PALETTE[curIdx % PALETTE.length]);
    } else if (parentCursors.has(id)) {
      cls.push('n-parent');
      const fi = cursors.indexOf(id);
      el.style.setProperty('--fc', PALETTE[(fi < 0 ? 0 : fi) % PALETTE.length]);
    } else if (pathSet.has(id)) cls.push('n-path');
    else if (st.done.has(id)) cls.push('n-done');
    else cls.push('n-pending');
    if ((st.counts.get(id) || 0) > 2) cls.push('n-hot');
    el.className = cls.join(' ');

    const valEl = el.querySelector('.val');
    const isLiteral = nd && (nd.k === 'Num' || nd.k === 'Str' || nd.k === 'Bool' || nd.k === 'Nil');
    if (st.values.has(id) && !isLiteral) {
      valEl.textContent = '= ' + fmtShort(st.values.get(id));
    } else {
      valEl.textContent = '';
    }
    const heatEl = el.querySelector('.heat');
    const c = st.counts.get(id) || 0;
    heatEl.textContent = c > 2 ? '×' + c : '';
  }

  /* 连线 */
  for (const [childId, path] of app.edgeEls) {
    const pid = app.parentOf.get(childId);
    let cls = 'e';
    if (pathSet.has(childId) && pid != null && pathSet.has(pid)) cls += ' path';
    else if (parentCursors.has(childId)) cls += ' parent';
    else if (st.done.has(childId)) cls += ' done';
    path.setAttribute('class', cls);
  }

  /* 源码 token */
  const curTight = curNode && curNode._tight;
  for (const t of app.tokenEls) {
    let cls = 'tok';
    if (curTight && t.start >= curNode.span[0] && t.end <= curNode.span[1]) {
      cls += ' tok-active';
    } else {
      let hit = false;
      for (let i = st.open.length - 1; i >= 0; i--) {
        const o = st.open[i];
        if (o.f !== (st.framesView[nf - 1] && st.framesView[nf - 1].id)) continue;
        const nd = app.byId.get(o.id);
        if (nd && nd._tight && t.start >= nd.span[0] && t.end <= nd.span[1]) { hit = true; break; }
      }
      if (hit) cls += ' tok-open';
      else {
        for (const pc of parentCursors) {
          const nd = app.byId.get(pc);
          if (nd && nd._tight && t.start >= nd.span[0] && t.end <= nd.span[1]) { cls += ' tok-parent'; break; }
        }
      }
    }
    t.el.className = cls;
  }

  /* 行高亮 */
  for (const el of app.lineEls) el.className = 'line';
  if (curNode) {
    const li = lineOf(curNode.span[0]);
    if (app.lineEls[li]) app.lineEls[li].classList.add('active');
  }
  for (const pc of parentCursors) {
    const nd = app.byId.get(pc);
    if (!nd) continue;
    const li = lineOf(nd.span[0]);
    if (app.lineEls[li]) app.lineEls[li].classList.add('parent');
  }
  /* 让当前执行的代码行始终可见（手机等小屏尤其重要） */
  if (curNode) {
    const li = lineOf(curNode.span[0]);
    if (app.lineEls[li]) app.lineEls[li].scrollIntoView({ block: 'nearest' });
  }

  /* 状态面板 / 进度 / 输出 */
  renderFrames(st, nf);
  const evs = app.trace.events;
  const ev = evs[app.traceIdx];
  const labelEl = $('#steplabel');
  labelEl.innerHTML = ev ? eventLabel(ev) : t('ready');
  $('#counter').textContent = (app.traceIdx + 1) + ' / ' + evs.length;
  const sc = $('#scrub');
  if (document.activeElement !== sc) sc.value = String(app.traceIdx);
  $('#btnPlay').textContent = app.playing ? '⏸' : '▶';

  const out = $('#output');
  out.textContent = st.outputs.map(x => '> ' + x).join('\n');
  out.scrollTop = out.scrollHeight;

  followTo(cur != null ? cur : (app.ast && app.ast.id));
}

function valueHTML(v) {
  if (v === null || v === undefined) return '<span class="nil">nil</span>';
  if (typeof v === 'string') return '<span class="s">' + esc(fmtVal(v)) + '</span>';
  if (typeof v === 'number' || typeof v === 'boolean') return '<span class="n">' + esc(String(v)) + '</span>';
  if (v.t === 'fn') return '<span class="fn">fn ' + esc(v.name || '匿名') + '</span>';
  if (v.t === 'builtin') return '<span class="fn">builtin ' + esc(v.name) + '</span>';
  if (v.t === 'table') {
    const keys = (v.order && v.order.length ? v.order : Object.keys(v.map)).slice(0, 3);
    const body = keys.map(k => k + '=' + fmtVal(v.map[k], 1)).join(', ');
    return '<span class="tbl"><span class="dot" style="--tc:' + tableColor(v.id) + '"></span>' +
      '<span class="tid">t' + v.id + '</span><span class="tv">{' + esc(body) + (keys.length >= 3 ? ', …' : '') + '}</span></span>';
  }
  return esc(String(v));
}

function renderFrames(st, nf) {
  const el = $('#frames');
  el.innerHTML = '';
  const compact = isCompactUI();
  /* 手机端只展示最内层栈帧，其余折叠成一行摘要，避免状态栏拥挤 */
  const from = compact ? nf - 1 : 0;
  for (let i = nf - 1; i >= from; i--) {
    const fr = st.framesView[i];
    const color = PALETTE[i % PALETTE.length];
    const box = document.createElement('div');
    box.className = 'frame' + (i === nf - 1 ? ' cur' : '');
    box.style.setProperty('--fc', color);

    const head = document.createElement('h3');
    head.innerHTML = '<span>' + esc(i === 0 ? t('frame.main') : fr.name + '()') + '</span>' +
      '<span class="fidx">' + (i === 0 ? t('frame.mainTag') : t('frame.idx', { n: fr.id })) + '</span>';
    box.appendChild(head);

    if (!fr.vars.size) {
      const empty = document.createElement('div');
      empty.className = 'empty-row';
      empty.textContent = t('noLocals');
      box.appendChild(empty);
    } else {
      let count = 0;
      for (const [name, v] of fr.vars) {
        if (count++ >= (compact ? 4 : 8)) break;
        const row = document.createElement('div');
        row.className = 'var';
        row.innerHTML = '<span class="k">' + esc(name) + '</span><span class="v">' + valueHTML(v) + '</span>';
        box.appendChild(row);
      }
    }
    el.appendChild(box);
  }
  if (compact && nf > 1) {
    const more = document.createElement('div');
    more.className = 'frames-more';
    more.textContent = t('frames.more', { n: nf - 1 });
    el.appendChild(more);
  }
}

/* ---------------- 12. 时间轴 ---------------- */
function pause() {
  app.playing = false;
  if (app.timer) { clearTimeout(app.timer); app.timer = 0; }
  const b = $('#btnPlay');
  if (b) b.textContent = '▶';
}

function seek(i) {
  const evs = app.trace.events;
  if (!evs.length) return;
  i = Math.max(0, Math.min(evs.length - 1, Math.floor(i)));
  const st = createState();
  for (let k = 0; k <= i; k++) applyEvent(st, evs[k]);
  app.state = st;
  app.traceIdx = i;
  render();
}

function stepBy(d) {
  pause();
  seek(app.traceIdx + d);
}

function play() {
  if (app.playing) { pause(); return; }
  if (!app.trace || !app.trace.events.length) return;
  if (app.traceIdx >= app.trace.events.length - 1) seek(0);
  app.playing = true;
  const b = $('#btnPlay');
  if (b) b.textContent = '⏸';
  const tick = () => {
    if (!app.playing) return;
    if (app.traceIdx >= app.trace.events.length - 1) { pause(); return; }
    seek(app.traceIdx + 1);
    app.timer = setTimeout(tick, app.speed);
  };
  app.timer = setTimeout(tick, app.speed);
}

/* ---------------- 13. 加载与交互 ---------------- */
/* ---------------- 13. 加载源码 / 代码编辑 ---------------- */
const EDITOR_LS_KEY = 'lua-mindscape:src';

function setActiveChip(key) {
  document.querySelectorAll('.programs .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.program === key);
  });
}

function currentChipKey() {
  const b = document.querySelector('.programs .chip.active');
  return b ? b.dataset.program : null;
}

/* 编译并重建整页（源码、树、时间轴、状态） */
function runSource(src) {
  pause();
  app.src = src;
  const compiled = compileProgram(src);
  app.ast = compiled.ast;
  app.trace = compiled.trace;
  app.byId = compiled.byId;
  app.parentOf = compiled.parentOf;
  buildCode();
  buildTree();
  app.state = createState();
  app.traceIdx = 0;
  app.userPanned = false;
  app.scale = 1;
  app.curId = null;
  $('#scrub').max = String(Math.max(0, app.trace.events.length - 1));
  applyView();
  seek(0);
  fitTree();
}

function loadProgram(key) {
  app.key = key;
  setActiveChip(key);
  runSource(PROGRAMS[key].src);
}

/* ---------- 编辑层（透明 textarea 覆盖在高亮层上，像素对齐） ---------- */
function readSavedSrc() {
  try { return localStorage.getItem(EDITOR_LS_KEY) || ''; } catch (err) { return ''; }
}
function writeSavedSrc(src) {
  try { localStorage.setItem(EDITOR_LS_KEY, src); } catch (err) { /* 隐私模式下忽略 */ }
}

function setCodeHint(text) {
  const el = $('#codeHint');
  if (el) el.textContent = text;
}

function showEditError(msg) {
  const el = $('#codeError');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.hidden = true; el.textContent = ''; }
}

function positionEditor() {
  const code = $('#code');
  const ta = $('#editor');
  const wrap = $('.code-wrap');
  if (!code || !ta || !wrap) return;
  const toks = code.querySelector('.toks');
  const cr = code.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  const tr = toks ? toks.getBoundingClientRect() : cr;
  const left = tr.left - wr.left + code.scrollLeft;
  const top = tr.top - wr.top + code.scrollTop;
  ta.style.left = left + 'px';
  ta.style.top = top + 'px';
  ta.style.width = Math.max(40, wrap.clientWidth - left - 2) + 'px';
  ta.style.height = Math.max(30, wrap.clientHeight - top - 2) + 'px';
}

function syncEditorScroll() {
  const code = $('#code');
  const ta = $('#editor');
  if (!code || !ta) return;
  code.scrollTop = ta.scrollTop;
  code.scrollLeft = ta.scrollLeft;
}

/* 输入时重建高亮层：语法着色实时更新（不重跑解释器） */
function refreshEditorBackdrop() {
  const ta = $('#editor');
  if (!ta || !app.editing) return;
  const st = ta.scrollTop, sl = ta.scrollLeft;
  app.src = ta.value;
  buildCode();
  positionEditor();
  const code = $('#code');
  code.scrollTop = st;
  code.scrollLeft = sl;
  ta.scrollTop = st;
  ta.scrollLeft = sl;
}

function applyEditUi(on) {
  const pane = $('#codePane');
  if (pane) pane.classList.toggle('editing', on);
  const editBtn = $('#btnEdit');
  editBtn.classList.toggle('on', on);
  editBtn.title = on ? t('btn.editRun') : t('btn.edit');
  $('#btnRun').hidden = !on;
  $('#btnRestore').hidden = !on;
  $('#btnCancel').hidden = !on;
  ['#btnReset', '#btnPrev', '#btnPlay', '#btnNext'].forEach(sel => {
    const b = $(sel);
    if (b) b.disabled = on;
  });
  const sc = $('#scrub');
  if (sc) sc.disabled = on;
  setCodeHint(on ? t('hint.codeEdit') : t('hint.code'));
}

function enterEdit() {
  if (app.editing) return;
  pause();
  app.editing = true;
  app.editBackup = { src: app.src, idx: app.traceIdx, key: app.key, chip: currentChipKey() };
  const ta = $('#editor');
  ta.value = app.src;
  applyEditUi(true);
  app.src = ta.value;
  buildCode();
  positionEditor();
  ta.scrollTop = 0;
  ta.scrollLeft = 0;
  $('#code').scrollTop = 0;
  $('#code').scrollLeft = 0;
  showEditError('');
  ta.focus();
  const pos = ta.value.length;
  try { ta.setSelectionRange(pos, pos); } catch (err) { /* noop */ }
}

function leaveEdit() {
  app.editing = false;
  app.editBackup = null;
  applyEditUi(false);
  showEditError('');
}

function cancelEdit() {
  if (!app.editing) return;
  const backup = app.editBackup;
  leaveEdit();
  if (backup) {
    app.key = backup.key;
    setActiveChip(backup.chip);
    runSource(backup.src);
    seek(Math.min(backup.idx, app.trace.events.length - 1));
  }
}

function restoreSample() {
  const ta = $('#editor');
  if (!ta) return;
  ta.value = (PROGRAMS[app.key] || PROGRAMS.loop).src;
  refreshEditorBackdrop();
  showEditError('');
  ta.focus();
}

function runEditor() {
  const ta = $('#editor');
  if (!ta || !app.editing) return;
  const src = ta.value;
  try {
    runSource(src);
  } catch (err) {
    showEditError(t('err.parse') + (err && err.message ? err.message : String(err)));
    return;
  }
  writeSavedSrc(src);
  setActiveChip(null);
  leaveEdit();
  if (!app.stillMode) play();
}

const NEW_TEMPLATE = [
  'local n = 0',
  'for i = 1, 5 do',
  '  n = n + i',
  'end',
  'print(n)'
].join('\n');

function newProgram() {
  pause();
  if (!app.editing) enterEdit();
  const ta = $('#editor');
  if (!ta) return;
  ta.value = NEW_TEMPLATE;
  refreshEditorBackdrop();
  showEditError('');
  app.key = null;
  setActiveChip(null);
  setCodeHint(t('hint.new'));
  ta.focus();
  try { ta.setSelectionRange(0, 0); } catch (err) { /* noop */ }
}

function importText(text, name) {
  if (text == null) return;
  pause();
  if (!app.editing) enterEdit();
  const ta = $('#editor');
  if (!ta) return;
  ta.value = String(text);
  refreshEditorBackdrop();
  showEditError('');
  app.key = null;
  setActiveChip(null);
  setCodeHint(t('hint.imported', { name: esc(name || 'code.lua') }));
  ta.focus();
  runEditor();
}

function readFileIntoEditor(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => importText(String(reader.result == null ? '' : reader.result), file.name);
  reader.onerror = () => showEditError(t('err.file'));
  reader.readAsText(file);
}

function jumpToNode(id) {
  const evs = app.trace.events;
  let target = -1;
  for (let i = app.traceIdx + 1; i < evs.length; i++) {
    if (evs[i].id === id) { target = i; break; }
  }
  if (target < 0) {
    for (let i = 0; i <= app.traceIdx; i++) {
      if (evs[i].id === id) { target = i; break; }
    }
  }
  if (target >= 0) {
    pause();
    seek(target);
    app.userPanned = false;
    $('#tree').classList.remove('nofollow');
    followTo(id, true);
  }
}

let deferredInstallPrompt = null;

function bindControls() {
  document.querySelectorAll('.programs .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      try {
        if (app.editing) leaveEdit();
        loadProgram(btn.dataset.program);
        if (!app.stillMode) play();
      } catch (err) {
        showFatal(err);
      }
    });
  });

  $('#btnReset').addEventListener('click', () => { pause(); seek(0); });
  $('#btnPrev').addEventListener('click', () => stepBy(-1));
  $('#btnNext').addEventListener('click', () => stepBy(1));
  $('#btnPlay').addEventListener('click', () => play());

  $('#scrub').addEventListener('input', (e) => {
    pause();
    seek(Number(e.target.value));
  });

  $('#speed').addEventListener('change', (e) => {
    app.speed = Number(e.target.value);
  });

  $('#zoomIn').addEventListener('click', () => zoomBy(1.18));
  $('#zoomOut').addEventListener('click', () => zoomBy(1 / 1.18));
  $('#zoomFit').addEventListener('click', () => fitTree());
  const layoutBtn = $('#btnLayout');
  if (layoutBtn) {
    layoutBtn.addEventListener('click', () => {
      setLayoutMode(app.layoutMode === 'neuron' ? 'grid' : 'neuron');
    });
  }

  /* 新建 / 导入 */
  $('#btnNew').addEventListener('click', newProgram);
  $('#btnImport').addEventListener('click', () => { const fi = $('#fileInput'); if (fi) fi.click(); });
  const fileInput = $('#fileInput');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) readFileIntoEditor(f);
      fileInput.value = '';
    });
  }
  const codePane = $('#codePane');
  if (codePane) {
    ['dragenter', 'dragover'].forEach(ev => codePane.addEventListener(ev, (e) => {
      e.preventDefault();
      codePane.classList.add('drop');
    }));
    codePane.addEventListener('dragleave', (e) => {
      if (e.target === codePane) codePane.classList.remove('drop');
    });
    codePane.addEventListener('drop', (e) => {
      e.preventDefault();
      codePane.classList.remove('drop');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFileIntoEditor(f);
    });
  }

  /* 编辑入口与编辑层交互 */
  $('#btnEdit').addEventListener('click', () => (app.editing ? runEditor() : enterEdit()));
  $('#btnRun').addEventListener('click', () => runEditor());
  $('#btnCancel').addEventListener('click', () => cancelEdit());
  $('#btnRestore').addEventListener('click', () => restoreSample());

  const langBtn = $('#btnLang');
  if (langBtn) langBtn.addEventListener('click', () => setLang(app.lang === 'zh' ? 'en' : 'zh'));

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const b = $('#btnInstall');
    if (b) b.hidden = false;
  });
  const installBtn = $('#btnInstall');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt = null;
        installBtn.hidden = true;
      } else {
        setCodeHint(t('install.hint'));
      }
    });
  }

  $('#code').addEventListener('click', () => { if (!app.editing) enterEdit(); });

  const editor = $('#editor');
  let editTimer = 0;
  editor.addEventListener('input', () => {
    if (!app.editing) return;
    clearTimeout(editTimer);
    editTimer = setTimeout(refreshEditorBackdrop, 160);
  });
  editor.addEventListener('scroll', syncEditorScroll);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      clearTimeout(editTimer);
      editTimer = setTimeout(refreshEditorBackdrop, 0);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clearTimeout(editTimer);
      runEditor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });
  window.addEventListener('resize', () => { if (app.editing) positionEditor(); });

  const vp = $('#treeviewport');
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;
    app.dragging = { x: e.clientX, y: e.clientY, tx: app.tx, ty: app.ty, moved: 0 };
    $('#tree').classList.add('nofollow');
    try { vp.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  });
  vp.addEventListener('pointermove', (e) => {
    if (!app.dragging) return;
    const dx = e.clientX - app.dragging.x;
    const dy = e.clientY - app.dragging.y;
    app.dragging.moved = Math.max(app.dragging.moved, Math.abs(dx) + Math.abs(dy));
    if (app.dragging.moved > 4) {
      app.userPanned = true;
      app.suppressClick = true;
      app.tx = app.dragging.tx + dx;
      app.ty = app.dragging.ty + dy;
      $('#tree').classList.add('nofollow');
      applyView();
    }
  });
  const endDrag = () => {
    if (app.dragging && app.dragging.moved > 4) {
      setTimeout(() => { app.suppressClick = false; }, 0);
    }
    if (!app.userPanned) $('#tree').classList.remove('nofollow');
    app.dragging = null;
  };
  vp.addEventListener('pointerup', endDrag);
  vp.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); play(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); stepBy(1); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); stepBy(-1); }
    else if (e.key === 'r' || e.key === 'R') { pause(); seek(0); }
  });

  window.addEventListener('resize', () => {
    updateLayoutButton();
    if (app.state) renderFrames(app.state, app.state.framesView.length);
    if (app.editing) return;
    if (!app.userPanned) fitTree();
    else followTo(app.curId != null ? app.curId : (app.ast && app.ast.id));
  });

  if (new URLSearchParams(location.search).get('debug') === '1') {
    setTimeout(() => {
      const vp = $('#treeviewport');
      const n = app.curId != null ? app.byId.get(app.curId) : null;
      document.title = 'DBG ' + JSON.stringify({
        idx: app.traceIdx,
        W: vp.clientWidth, H: vp.clientHeight,
        tx: app.tx, ty: app.ty, scale: app.scale,
        treeW: app.treeW, treeH: app.treeH,
        curId: app.curId,
        cur: n ? { k: n.k, gx: n.gx, gy: n.gy, w: n._el.offsetWidth } : null,
        userPanned: app.userPanned,
        events: app.trace ? app.trace.events.length : -1
      });
    }, 400);
  }
}

function showFatal(err) {
  const msg = err && err.message ? err.message : String(err);
  showEditError(t('err.start') + msg);
  const codeEl = $('#code');
  if (codeEl) codeEl.textContent = t('err.start') + msg;
  console.error(err);
}

/* ---------------- 14. 启动 ---------------- */
function boot() {
  const params = new URLSearchParams(location.search);
  const urlLang = params.get('lang');
  if (urlLang === 'en' || urlLang === 'zh') app.lang = urlLang;
  else app.lang = readSavedLang() === 'en' ? 'en' : 'zh';
  const urlLayout = params.get('layout');
  app.layoutMode = (urlLayout || readSavedLayout()) === 'neuron' ? 'neuron' : 'grid';
  const key = PROGRAMS[params.get('program')] ? params.get('program') : 'loop';
  const still = params.get('still') === '1';
  const step = Math.floor(Number(params.get('step') || '0')) || 0;
  const speed = Number(params.get('speed') || '0');
  if (speed > 0) app.speed = speed;

  app.stillMode = still;
  if (params.get('speed')) {
    const sel = $('#speed');
    if (sel) {
      const opt = Array.prototype.find.call(sel.options, o => Number(o.value) === app.speed);
      if (opt) sel.value = opt.value;
    }
  }

  bindControls();
  applyI18n();
  const programParam = PROGRAMS[params.get('program')] ? params.get('program') : null;
  const savedSrc = programParam ? '' : readSavedSrc();
  let loaded = false;
  try {
    if (programParam) {
      loadProgram(programParam);
      loaded = true;
    } else if (savedSrc) {
      runSource(savedSrc);
      app.key = 'loop';
      setActiveChip(null);
      loaded = true;
    }
  } catch (err) {
    loaded = false;
  }
  if (!loaded) {
    try {
      loadProgram('loop');
    } catch (err) {
      showFatal(err);
      return;
    }
  }
  applyI18n();
  if (params.get('scale')) {
    const s = Number(params.get('scale'));
    if (isFinite(s) && s > 0) {
      app.scale = Math.max(0.35, Math.min(1.8, s));
      app.userPanned = false;
      followTo(app.curId != null ? app.curId : (app.ast && app.ast.id), true);
    }
  }
  if (still) {
    pause();
    seek(step);
  } else {
    seek(0);
    setTimeout(() => play(), 700);
  }
  window.__luaBrain = {
    app, compileProgram, PROGRAMS, tokenize, parse, run, eventLabel, applyEvent, seek, play, pause, fitTree,
    enterEdit, leaveEdit, cancelEdit, runEditor, runSource, setLang, t, setLayoutMode,
    newProgram, importText,
    isEditing: () => !!app.editing,
    getEditorValue: () => { const ta = $('#editor'); return ta ? ta.value : ''; },
    setEditorValue: (v) => {
      const ta = $('#editor');
      if (!ta) return;
      ta.value = String(v == null ? '' : v);
      refreshEditorBackdrop();
    }
  };
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* file:// 或浏览器不支持时忽略 */ });
  }
  window.__appReady = true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot();
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tokenize, parse, linkParents, childrenOf, run, compileProgram,
    PROGRAMS, fmtVal, fmtShort, eventLabel, app
  };
}
