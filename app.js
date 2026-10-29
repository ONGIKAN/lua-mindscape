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
    if (two === '==' || two === '~=' || two === '<=' || two === '>=' || two === '..' || two === '//') {
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
  '..': 4, '+': 5, '-': 5,
  '*': 6, '/': 6, '//': 6, '%': 6,
  '^': 8
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
    throw new Error(msg + '（字符 ' + t.start + ' 附近：' + JSON.stringify(src.slice(t.start, t.start + 14)) + '）');
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
    if (isOp('-') || isOp('#') || isKw('not')) {
      const t = next();
      const e = expr(7);
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
    case 'Call': return [n.fn].concat(n.args);
    case 'Table': return n.entries.map(e => e.value);
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
  globals.vars.set('print', { t: 'builtin', name: 'print' });

  function ev(e) {
    e.f = frame;
    events.push(e);
    if (events.length > maxEvents) throw new Error('事件数超过原型上限（' + maxEvents + '）');
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
        else v = toStringLua(a).length;
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
  }
};

/* ---------------- 6. 渲染：常量与工具 ---------------- */
const PALETTE = ['#4f46e5', '#0f766e', '#b45309', '#be185d', '#7c3aed', '#0369a1'];
const TABLE_PALETTE = ['#4f46e5', '#0f766e', '#b45309', '#be185d', '#7c3aed'];

const KIND_NAME = {
  Chunk: '程序', Block: '语句块', Local: '局部变量声明', LocalFunction: '局部函数定义',
  FunctionDecl: '函数定义', Function: '函数体', If: '条件分支', NumFor: '数值 for 循环',
  While: 'while 循环', Return: '返回', Assign: '赋值', CallStmt: '调用语句', Bin: '二元运算',
  Un: '一元运算', Num: '数字', Str: '字符串', Bool: '布尔值', Nil: 'nil', Var: '变量引用',
  Field: '字段访问', Call: '函数调用', Table: '表构造'
};

const KIND_CAT = {
  Chunk: 'blk', Block: 'blk',
  Local: 'stmt', LocalFunction: 'stmt', FunctionDecl: 'stmt', Function: 'stmt',
  If: 'stmt', NumFor: 'stmt', While: 'stmt', Return: 'stmt', Assign: 'stmt', CallStmt: 'stmt',
  Bin: 'op', Un: 'op', Num: 'lit', Str: 'lit', Bool: 'lit', Nil: 'lit',
  Var: 'id', Field: 'id', Call: 'call', Table: 'lit'
};

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
    case 'Assign': return n.targets.map(t => t.k === 'Var' ? t.name : '.' + t.name).join(',') + ' =';
    case 'CallStmt': return '调用语句';
    case 'Block': return '块';
    case 'Chunk': return 'chunk';
    default: return n.k;
  }
}

function eventLabel(e) {
  const nd = e.id != null ? app.byId.get(e.id) : null;
  const snip = nd ? esc(shorten(app.src.slice(nd.span[0], nd.span[1]).replace(/\s+/g, ' ').trim(), 42)) : '';
  const ssp = snip ? ' <span class="snip">' + snip + '</span>' : '';
  switch (e.t) {
    case 'ent': return '进入 <b>' + esc(KIND_NAME[nd ? nd.k : ''] || '') + '</b>' + ssp;
    case 'cls': return '完成 <b>' + esc(KIND_NAME[nd ? nd.k : ''] || '') + '</b>' + ssp;
    case 'val': return '求值 <b>' + esc(fmtShort(e.v)) + '</b>' + ssp;
    case 'set': return '赋值 <b>' + esc(e.name) + '</b> = <b>' + esc(fmtShort(e.v)) + '</b>';
    case 'call': return '进入函数 <b>' + esc(e.name) + '(…)</b> · 新栈帧 #' + e.nf;
    case 'ret': return '从 <b>' + esc(e.name) + '(…)</b> 返回 <b>' + esc(fmtShort(e.v)) + '</b>';
    case 'iter': return '<b>for</b> 迭代：' + esc(e.name) + ' = <b>' + esc(fmtShort(e.v)) + '</b>';
    case 'print': return '输出 <b>' + esc(e.text) + '</b>';
    case 'end': return '程序执行完毕 ✓';
    case 'error': return '<span style="color:#ff8ab8">运行时错误：' + esc(e.message) + '</span>';
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
  curId: null
};

/* ---------------- 8. 回放状态机 ---------------- */
function createState() {
  return {
    open: [],
    framesView: [{ id: 0, name: '主函数', vars: new Map() }],
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

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'edges');
  const gEl = document.createElementNS(NS, 'g');
  svg.appendChild(gEl);
  treeEl.appendChild(svg);

  const ROW = 46;
  const COL = 178;
  const all = [];
  let leaf = 0;

  (function place(n, depth) {
    n.gx = depth * COL + 12;
    const kids = childrenOf(n);
    if (!kids.length) {
      n.gy = leaf * ROW;
      leaf++;
    } else {
      kids.forEach((c, i) => {
        if (i > 0) leaf += 0.6; // 兄弟子树之间留呼吸间距，避免不同父节点的分支在视觉上混成一片
        place(c, depth + 1);
      });
      n.gy = (kids[0].gy + kids[kids.length - 1].gy) / 2;
    }
    all.push(n);
  })(app.ast, 0);

  (function create(n) {
    const el = document.createElement('div');
    el.className = 'node c-' + (KIND_CAT[n.k] || 'stmt');
    el.dataset.id = String(n.id);
    el.style.left = n.gx + 'px';
    el.style.top = n.gy + 'px';
    el.innerHTML = '<span class="lbl">' + esc(labelOf(n)) + '</span>' +
      '<span class="val"></span><span class="heat"></span>';
    el.title = KIND_NAME[n.k] + '  [' + n.span[0] + '..' + n.span[1] + ']';
    el.addEventListener('click', () => {
      if (app.suppressClick) return;
      jumpToNode(n.id);
    });
    treeEl.appendChild(el);
    app.nodeEls.set(n.id, el);
    n._el = el;
    for (const c of childrenOf(n)) create(c);
  })(app.ast);

  let maxX = 0;
  for (const n of all) maxX = Math.max(maxX, n.gx + n._el.offsetWidth);
  const treeW = Math.max(320, maxX + 80);
  const treeH = Math.max(160, leaf * ROW + 40);
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
    const x1 = pn.gx + pW;
    const y1 = pn.gy;
    const x2 = n.gx - 4;
    const y2 = n.gy;
    const dx = Math.max(28, (x2 - x1) * 0.6);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' +
      (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2);
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

function followTo(nodeId) {
  if (app.userPanned) return;
  const vp = $('#treeviewport');
  if (!vp) return;
  const W = vp.clientWidth;
  const H = vp.clientHeight;
  if (W < 20 || H < 20) return;
  const n = (nodeId != null && app.byId.get(nodeId)) || app.ast;
  if (!n) return;
  const s = app.scale;
  const nw = n._el ? n._el.offsetWidth : 60;
  /* 把当前节点放在「视口横向 45% / 纵向 50%」附近 */
  let tx = W * 0.45 - (n.gx + nw / 2) * s;
  let ty = H * 0.5 - n.gy * s;
  const tw = app.treeW * s;
  const th = app.treeH * s;
  /* 限制：树比视口大时，允许最多 64px 的越界留白，保证当前节点一定可见 */
  const MARGIN = 64;
  if (tw <= W - 16) tx = (W - tw) / 2;
  else tx = Math.min(MARGIN, Math.max(W - tw - MARGIN, tx));
  if (th <= H - 16) ty = (H - th) / 2;
  else ty = Math.min(MARGIN, Math.max(H - th - MARGIN, ty));
  app.tx = tx;
  app.ty = ty;
  applyView();
}

/* 缩放到「整棵树刚好放进视口」，并复位到跟随模式 */
function fitTree() {
  const vp = $('#treeviewport');
  if (!vp) return;
  const W = vp.clientWidth - 32;
  const H = vp.clientHeight - 32;
  const s = Math.min(W / Math.max(1, app.treeW), H / Math.max(1, app.treeH));
  app.scale = Math.max(0.35, Math.min(1, Math.round(s * 100) / 100));
  app.userPanned = false;
  $('#tree').classList.remove('nofollow');
  followTo(app.curId != null ? app.curId : (app.ast && app.ast.id));
}

function zoomBy(f) {
  app.scale = Math.max(0.35, Math.min(1.8, Math.round(app.scale * f * 100) / 100));
  app.userPanned = false;
  $('#tree').classList.remove('nofollow');
  followTo(app.curId != null ? app.curId : (app.ast && app.ast.id));
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
  labelEl.innerHTML = ev ? eventLabel(ev) : '准备执行…';
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
  for (let i = nf - 1; i >= 0; i--) {
    const fr = st.framesView[i];
    const color = PALETTE[i % PALETTE.length];
    const box = document.createElement('div');
    box.className = 'frame' + (i === nf - 1 ? ' cur' : '');
    box.style.setProperty('--fc', color);

    const head = document.createElement('h3');
    head.innerHTML = '<span>' + esc(i === 0 ? '主函数' : fr.name + '()') + '</span>' +
      '<span class="fidx">' + (i === 0 ? 'main' : '栈帧 #' + fr.id) + '</span>';
    box.appendChild(head);

    if (!fr.vars.size) {
      const empty = document.createElement('div');
      empty.className = 'empty-row';
      empty.textContent = '（暂无局部变量）';
      box.appendChild(empty);
    } else {
      let count = 0;
      for (const [name, v] of fr.vars) {
        if (count++ >= 8) break;
        const row = document.createElement('div');
        row.className = 'var';
        row.innerHTML = '<span class="k">' + esc(name) + '</span><span class="v">' + valueHTML(v) + '</span>';
        box.appendChild(row);
      }
    }
    el.appendChild(box);
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
function loadProgram(key) {
  pause();
  app.key = key;
  app.src = PROGRAMS[key].src;
  const compiled = compileProgram(app.src);
  app.ast = compiled.ast;
  app.trace = compiled.trace;
  app.byId = compiled.byId;
  app.parentOf = compiled.parentOf;

  document.querySelectorAll('.programs .chip').forEach(b => {
    b.classList.toggle('active', b.dataset.program === key);
  });

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
  if (target >= 0) { pause(); seek(target); }
}

function bindControls() {
  document.querySelectorAll('.programs .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      try {
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

  const vp = $('#treeviewport');
  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;
    app.dragging = { x: e.clientX, y: e.clientY, tx: app.tx, ty: app.ty, moved: 0 };
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
    followTo(app.curId != null ? app.curId : (app.ast && app.ast.id));
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
  const codeEl = $('#code');
  if (codeEl) {
    codeEl.innerHTML = '<div style="color:#ff8ab8;padding:10px;line-height:1.7">' +
      '解析/执行失败：<br>' + esc(err && err.message ? err.message : String(err)) + '</div>';
  }
  console.error(err);
}

/* ---------------- 14. 启动 ---------------- */
function boot() {
  const params = new URLSearchParams(location.search);
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
  try {
    loadProgram(key);
  } catch (err) {
    showFatal(err);
    return;
  }
  if (params.get('scale')) {
    const s = Number(params.get('scale'));
    if (isFinite(s) && s > 0) {
      app.scale = Math.max(0.35, Math.min(1.8, s));
      app.userPanned = false;
      followTo(app.curId != null ? app.curId : (app.ast && app.ast.id));
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
    app, compileProgram, PROGRAMS, tokenize, parse, run, eventLabel, applyEvent, seek, play, pause, fitTree
  };
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
