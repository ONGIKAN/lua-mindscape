'use strict';
/*
 * inspect-trace.js —— 调试助手：把解释器事件流打印成可读的时间线。
 *
 * 用法：
 *   node tools/inspect-trace.js                  # 三个示例，打印全部事件
 *   node tools/inspect-trace.js fact 40          # 只打印 fact 程序前 40 步后的状态
 *   node tools/inspect-trace.js alias 20 --all   # 打印前 20 步 + 完整事件列表
 */
const path = require('path');
const { compileProgram, PROGRAMS, fmtShort } = require(path.join(__dirname, '..', 'app.js'));

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const key = PROGRAMS[args[0]] ? args[0] : 'loop';
const upto = args[1] !== undefined ? Math.floor(Number(args[1])) : Infinity;
const showAll = flags.has('--all');

function apply(events, n) {
  const open = [];
  const frames = [{ id: 0, name: '主函数', vars: new Map() }];
  const done = new Set();
  const values = new Map();
  const outputs = [];
  for (let i = 0; i < n && i < events.length; i++) {
    const e = events[i];
    switch (e.t) {
      case 'ent':
        open.push({ id: e.id, f: e.f });
        break;
      case 'cls':
        for (let k = open.length - 1; k >= 0; k--) if (open[k].id === e.id && open[k].f === e.f) { open.splice(k, 1); break; }
        done.add(e.id);
        break;
      case 'val':
        for (let k = open.length - 1; k >= 0; k--) if (open[k].id === e.id && open[k].f === e.f) { open.splice(k, 1); break; }
        done.add(e.id);
        values.set(e.id, e.v);
        break;
      case 'set': {
        let fr = frames.find(f => f.id === e.f) || frames[frames.length - 1];
        fr.vars.set(e.name, e.v);
        break;
      }
      case 'call':
        frames.push({ id: e.nf != null ? e.nf : e.f + 1, name: e.name, vars: new Map() });
        break;
      case 'ret':
        frames.pop();
        for (let k = open.length - 1; k >= 0; k--) if (open[k].f === e.f) open.splice(k, 1);
        break;
      case 'print':
        outputs.push(e.text);
        break;
      case 'error':
        outputs.push('[error] ' + e.message);
        break;
    }
  }
  return { open, frames, done, values, outputs };
}

const prog = PROGRAMS[key];
const compiled = compileProgram(prog.src);
const events = compiled.trace.events;
const n = Math.min(upto, events.length);

const KIND_NAME = {
  Chunk: '程序', Block: '语句块', Local: '局部变量声明', LocalFunction: '局部函数定义',
  FunctionDecl: '函数定义', Function: '函数体', If: '条件分支', NumFor: '数值 for 循环',
  While: 'while 循环', Return: '返回', Assign: '赋值', CallStmt: '调用语句', Bin: '二元运算',
  Un: '一元运算', Num: '数字', Str: '字符串', Bool: '布尔值', Nil: 'nil', Var: '变量引用',
  Field: '字段访问', Call: '函数调用', Table: '表构造'
};

function snippet(id) {
  const nd = compiled.byId.get(id);
  if (!nd) return '';
  return prog.src.slice(nd.span[0], nd.span[1]).replace(/\s+/g, ' ').trim().slice(0, 46);
}

function lineOf(off) {
  return prog.src.slice(0, off).split('\n').length;
}

console.log('══ 程序：' + prog.label + ' ═══════════════════════════════════════');
console.log(prog.src.split('\n').map((l, i) => String(i + 1).padStart(3) + '  ' + l).join('\n'));
console.log('\n事件总数: ' + events.length + '   函数调用数: ' + compiled.trace.calls + '   表对象数: ' + compiled.trace.tables);
console.log('\n── 事件流（前 ' + n + ' 条）────────────────────────────');

for (let i = 0; i < n; i++) {
  const e = events[i];
  const nd = e.id != null ? compiled.byId.get(e.id) : null;
  const where = nd ? 'L' + lineOf(nd.span[0]) : '--';
  let desc = '';
  switch (e.t) {
    case 'ent': desc = '进入 ' + (KIND_NAME[nd && nd.k] || '') + '  「' + snippet(e.id) + '」'; break;
    case 'cls': desc = '完成 ' + (KIND_NAME[nd && nd.k] || '') + '  「' + snippet(e.id) + '」'; break;
    case 'val': desc = '求值 ' + fmtShort(e.v) + '  「' + snippet(e.id) + '」'; break;
    case 'set': desc = '赋值 ' + e.name + ' = ' + fmtShort(e.v); break;
    case 'call': desc = '调用 ' + e.name + '(…)  新栈帧 #' + e.nf; break;
    case 'ret': desc = '返回 ' + e.name + '(…) = ' + fmtShort(e.v); break;
    case 'iter': desc = 'for 迭代 ' + e.name + ' = ' + fmtShort(e.v); break;
    case 'print': desc = 'print → ' + e.text; break;
    case 'end': desc = '程序结束'; break;
    case 'error': desc = '错误：' + e.message; break;
    default: desc = e.t;
  }
  console.log(String(i).padStart(5) + '  ' + ('[' + 'f' + e.f + ']').padEnd(6) + ' ' + where.padEnd(4) + '  ' + e.t.padEnd(6) + '  ' + desc);
}

const st = apply(events, n);
console.log('\n── 第 ' + n + ' 步之后的回放状态 ────────────────────────');
console.log('栈帧（深→浅）:');
for (let i = st.frames.length - 1; i >= 0; i--) {
  const fr = st.frames[i];
  const vars = Array.from(fr.vars.entries()).map(([k, v]) => k + ' = ' + fmtShort(v)).join('， ');
  console.log('  [' + (i === 0 ? 'main' : '#' + fr.id) + '] ' + (i === 0 ? '主函数' : fr.name + '()') + '   { ' + (vars || '—') + ' }');
}
console.log('打开中的节点（深→浅）:');
for (let i = st.open.length - 1; i >= 0; i--) {
  const nd = compiled.byId.get(st.open[i].id);
  console.log('  f' + st.open[i].f + '  ' + (nd ? nd.k : '?') + '  「' + snippet(st.open[i].id) + '」');
}
console.log('输出: ' + (st.outputs.length ? JSON.stringify(st.outputs) : '（无）'));
console.log('已完成节点数: ' + st.done.size + ' / 有值节点数: ' + st.values.size);

if (showAll || !isFinite(upto)) {
  const errors = events.filter(e => e.t === 'error');
  const prints = events.filter(e => e.t === 'print').map(e => e.text);
  console.log('\n── 汇总 ──────────────────────────────────');
  console.log('print 列表: ' + JSON.stringify(prints));
  console.log('运行时错误: ' + (errors.length ? JSON.stringify(errors.map(e => e.message)) : '无'));
}

if (process.exitCode === undefined) process.exitCode = 0;
