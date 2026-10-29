#!/usr/bin/env node
/*
 * qa.mjs —— 原型无头浏览器 QA / 截图工具（零依赖，用 Node 内置 WebSocket + Edge CDP）。
 *
 * 用法示例：
 *   node tools/qa.mjs --program fact --step 60 --out refs/shot-fact.png
 *   node tools/qa.mjs --program loop --step 45 --scale 0.8 --width 1920 --height 1080 \
 *        --out refs/shot-loop-1920.png --eval "window.__luaBrain.app.state.framesView.length"
 *
 * 输出 JSON：页面异常、页内 console error、eval 结果、截图路径、最终相机状态。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const program = arg('program', 'loop');
const step = Number(arg('step', '0'));
const scale = arg('scale', '');
const width = Number(arg('width', '1600'));
const height = Number(arg('height', '1000'));
const still = arg('still', '1') === '1';
const out = arg('out', path.join(ROOT, 'refs', `shot-${program}-step${step}.png`));
const evals = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--eval') evals.push(argv[i + 1]);
const extra = arg('extra', '');

const localUrl = 'file://' + ROOT.replace(/\\/g, '/') +
  `/index.html?program=${encodeURIComponent(program)}` +
  (still ? '&still=1&step=' + step : '') +
  (scale ? '&scale=' + encodeURIComponent(scale) : '') +
  (extra ? '&' + extra : '');
const url = arg('url', '') || localUrl;

const port = 9400 + Math.floor(Math.random() * 400);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lua-brain-qa-'));

function log(...a) { process.stderr.write(a.join(' ') + '\n'); }

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  '--window-size=' + width + ',' + height,
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + userDir,
  url
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && /^(https?|file):/.test(t.url));
      if (page) return page;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Edge remote debugging target not found');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = { exceptions: [], consoleErrors: [], load: false };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = e => reject(new Error('WS error'));
  });
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      events.exceptions.push((d.exception && d.exception.description) || d.text || 'unknown exception');
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      if (msg.params.type === 'error') {
        events.consoleErrors.push((msg.params.args || []).map(a => a.value || a.description || '').join(' '));
      }
    } else if (msg.method === 'Page.loadEventFired') {
      events.load = true;
    }
  };
  function send(method, params) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  }
  return { ws, send, events, ready };
}

const report = { url, program, step, scale: scale || null, width, height, ok: false };
let cdp = null;
try {
  const page = await waitTarget();
  cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  /* 等页面完成渲染（__appReady 由 boot 末尾置位） */
  let readyState = null;
  for (let i = 0; i < 80; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: '!!window.__appReady', returnByValue: true });
    readyState = r.result && r.result.value;
    if (readyState) break;
    await sleep(100);
  }
  report.appReady = !!readyState;
  await sleep(500); // 让 CSS transition 稳定

  report.camera = (await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const b = window.__luaBrain; if (!b) return null;
      const a = b.app; const vp = document.getElementById('treeviewport');
      const node = a.curId != null ? a.byId.get(a.curId) : null;
      const W = vp.clientWidth, H = vp.clientHeight;
      const sx = a.tx + (node ? node.gx * a.scale : 0);
      const sy = a.ty + (node ? node.gy * a.scale : 0);
      return {
        W, H, tx: a.tx, ty: a.ty, scale: a.scale,
        treeW: a.treeW, treeH: a.treeH,
        curId: a.curId,
        curKind: node ? node.k : null,
        curOnScreen: node ? (sx > 4 && sx < W - 4 && sy > 4 && sy < H - 4) : null,
        frames: a.state.framesView.length,
        framesView: a.state.framesView.map(f => ({ id: f.id, name: f.name, vars: Array.from(f.vars.keys()) })),
        outputs: a.state.outputs.slice(),
        traceIdx: a.traceIdx,
        total: a.trace.events.length,
        activeNodes: Array.from(document.querySelectorAll('.node.n-active')).map(e => e.dataset.id),
        title: document.title,
        stepLabel: (document.getElementById('steplabel') || {}).textContent
      };
    })()`,
    returnByValue: true
  })).result.value;

  report.evals = [];
  for (const expr of evals) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    report.evals.push({ expr, value: r.result && ('value' in r.result ? r.result.value : r.result.description), exception: r.exceptionDetails ? (r.exceptionDetails.text || 'exception') : null });
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  report.screenshot = out;
  report.ok = !cdp.events.exceptions.length && report.appReady;

  report.exceptions = cdp.events.exceptions;
  report.consoleErrors = cdp.events.consoleErrors;
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  report.error = String(err && err.stack || err);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  try { if (cdp && cdp.ws) cdp.ws.close(); } catch (e) { /* noop */ }
  try { edge.kill(); } catch (e) { /* noop */ }
  await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
}
