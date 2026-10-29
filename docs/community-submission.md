# Lua 社区提交材料（草稿包）

> 目标：把「Lua 思维可视化 / Lua Mindscape」介绍给 Lua 社区。
> 本文件是**可直接使用的草稿**；所有对外发布动作（PR / wiki / 邮件 / 发帖）
> 都要先经你过目确认后再执行。
>
> 说明：本机网络受限（无法访问 github.com / lua.org 核对最新规则），
> 渠道与格式基于公开常识整理；执行前以各渠道首页的现行说明为准。

---

## 一、渠道矩阵（能不能提交 / 怎么提交）

| 渠道 | 能否提交 | 形式 | 对项目的适配度 |
| --- | --- | --- | --- |
| [awesome-lua](https://github.com/LewisJEllis/awesome-lua) | ✅ | GitHub PR，按 `contributing.md` 格式 | 高。`IDEs and Plugins` 类目已有 GUI 工具先例；偏好「能装、能用」的成熟工具 |
| [lua-users wiki](http://lua-users.org/wiki/) | ✅ | 注册登录后建项目页，链到 `LuaProjects` / 相关类目 | 高，门槛低；适合放早期项目 |
| [lua-l 邮件列表](https://www.lua.org/lua-l.html) | ✅ | 订阅后用订阅地址发纯文本邮件（announcements 明确欢迎） | 高，Lua 核心社区，适合发布概念/原型求反馈 |
| [Lua Discord / Telegram / IRC](https://www.lua.org/community.html) | ✅ | 聊天区自荐 + 演示链接 | 高，反馈快 |
| Reddit [r/lua](https://www.reddit.com/r/lua/) | ✅ | 发帖（注意自我推广比例） | 高，适合晒 demo 截图 |
| Lua.Space 博客 / Lua Users Foundation | ⚠️ | 需联系投稿 | 中 |
| Lua Workshop / Lua Conf | ⚠️ | 向 lua-l 提案或报名 CFP | 低（成本高，适合成熟期） |
| LuaRocks | ❌ | 收录 Lua 模块/CLI 工具（rockspec 构建） | 不适合 GUI/Web 应用；除非把核心抽成纯 Lua 库单独发 rock |

**结论**：可以提交，但没有统一投稿入口，需要按渠道分别投。对本项目最现实的顺序是：
**先发布 repo + 在线 demo → lua-l / Reddit / Discord 求反馈 → 再提 awesome-lua 与 wiki**。

---

## 二、发布前置条件（Checklist）

- [x] 代码推送到公开仓库：<https://github.com/ONGIKAN/lua-mindscape>（已完成）
- [x] 部署在线 demo：<https://ongikan.github.io/lua-mindscape/>（GitHub Pages，已完成）
- [x] 中英双语文档：`README.md` / `README.en.md` / `docs/DESIGN.md` / `docs/DESIGN.en.md`（已完成）
- [x] 可安装客户端（PWA：manifest + Service Worker + 图标；离线可用；正式版为 Tauri 2）（已完成）
- [x] `README.md` 含英文摘要（已写好，见仓库根目录）
- [x] 添加 `LICENSE` + `NOTICE`（Apache-2.0，已完成）
- [x] 仓库与演示页互相指向：页面右上角 / 页脚有 GitHub 链接，README 首屏有 Live demo，GitHub About 的 homepage 指向演示页
- [x] 对外名称：英文 **Lua Mindscape**，中文 **Lua 思维可视化**
- [ ] 确认提交范围：只提本项目，还是也要处理 `ONGIKAN/lua-node-studio`（另一个仓库）（待用户确认）
- [ ] 对外投放：本文件 4 份草稿已随功能更新，等用户确认后再依次发 wiki / lua-l / Reddit / awesome-lua

---

## 三、草稿

### 3.1 GitHub 仓库元信息

- **Repo name**: `lua-mindscape`
- **Description (English)**: `Interactive visual debugger that projects Lua evaluation traces onto the AST in real time — watch recursion, scope frames and table aliases like a thought process.`
- **Topics**: `lua` `visualization` `ast` `debugger` `interpreter` `webassembly` `education` `programming-education`
- **Release notes (English, v0.1.0)**:

```markdown
## v0.1.0 — UX prototype

First public prototype: a single-page, zero-dependency web demo that visualizes
Lua's evaluation trace on top of the AST.

- Four built-in programs: loop sum, recursion, table aliases, and an **N-Queens solver**
  using Lua 5.3 bitwise operators (`& | ~ << >>`) — real algorithm code running on the trace visualizer
- Playback timeline: play / pause / step / scrub / click a node to jump in time
- Call-stack panel with per-frame colors; values shown as node badges
- Table identity colors (aliasing visible at a glance)
- Inline Lua editor: edit the source and run it; parse errors shown inline (line/column)
- New / import Lua files (file picker or drag & drop), then run them immediately
- Bilingual UI (English / Chinese) with a persisted language toggle
- Installable as a desktop / mobile client (PWA) and works offline
- Light, minimal theme; responsive layout for desktop / tablet / phone

Try it: https://ongikan.github.io/lua-mindscape/
Source: https://github.com/ONGIKAN/lua-mindscape
Note: parser & interpreter here are simplified JS implementations, used only to
validate the interaction model. The production core is planned in Rust
(full-moon + explicit-state-machine interpreter) compiled to WebAssembly.
```

### 3.2 awesome-lua PR

**类目**：`IDEs and Plugins`（次选：`Miscellaneous`）

**条目（英文，按列表格式）**：

```markdown
- [Lua Mindscape](https://github.com/ONGIKAN/lua-mindscape) - An interactive visual debugger that projects Lua's evaluation trace onto the AST in real time; makes recursion, scope frames and table aliases visible, with an inline Lua editor, English/Chinese UI and installable web app.
```

**PR 标题**：`Add Lua Mindscape to IDEs and Plugins`

**PR 描述模板**：

```markdown
### What I added
- Added **Lua Mindscape** to the *IDEs and Plugins* section.

### About the project
Lua Mindscape is a browser-based visualization tool for Lua's evaluation
process: it renders the AST and animates the interpreter's trace on it
(current node, path highlight, computed values, call-stack frames, table
aliasing). It's aimed at teaching, debugging and interactive tutorials.

- Live demo: https://ongikan.github.io/lua-mindscape/
- Source: https://github.com/ONGIKAN/lua-mindscape
- License: Apache-2.0
- Additional features: inline Lua editor (edit & re-run, inline parse errors),
  bilingual UI (English / Chinese), installable PWA that also works offline.

### Why it fits this list
The list already includes GUI/IDE tooling (e.g. ZeroBrane Studio). Lua Mindscape
is a complementary *visualization* tool rather than an editor, and runs with
zero install in the browser.
```

> 注意：awesome-lua 更偏好「可安装、可用」的项目；如果 PR 被拒或建议等待，
> 先把 demo 链接放到 lua-users wiki 与 lua-l，等项目进入 MVP 再提一次。

### 3.3 lua-users wiki 项目页（wikitext）

页面建议：`LuaMindscape`，并在 `LuaProjects` / `LuaTools` 页面加一行链接。

```wiki
== Lua Mindscape ==

'''URL:''' https://github.com/ONGIKAN/lua-mindscape (demo: https://ongikan.github.io/lua-mindscape/)

'''Description:''' An interactive visual debugger that projects a Lua chunk's
evaluation trace onto its AST in real time. The currently evaluating node is
highlighted, evaluated sub-expressions show their computed values, call-stack
frames are color-coded by depth, and variables that reference the same table
share a color (table aliasing at a glance).

It also includes an inline Lua editor (edit the code and re-run it), a
bilingual (English/Chinese) UI, and installs as a PWA that works offline.

Currently a UX prototype (single-page web app, simplified JS interpreter).
The production core is planned in Rust (lossless parser + explicit state
machine interpreter) compiled to WebAssembly.

'''License:''' Apache-2.0

'''Status:''' prototype (v0.1.0)
```

`LuaProjects` 里的一行：

```wiki
* LuaMindscape - visualize Lua's evaluation trace on the AST ([https://github.com/ONGIKAN/lua-mindscape github])
```

### 3.4 lua-l 公告邮件（英文、纯文本）

发送前：先在 <https://www.lua.org/lua-l.html> 订阅，再用订阅地址发信；
纯文本、不要附件、简短。

```text
Subject: [ANN] Lua Mindscape - visualizing Lua's evaluation trace (prototype)

Hi all,

I'm building a small tool called Lua Mindscape: it visualizes what a Lua
chunk is actually doing, step by step, on top of its AST.

The idea: an AST view alone is static and not very illuminating. What is
interesting is the evaluation trace - which node is being evaluated right
now, which sub-expressions already have values, how the call stack nests,
and which variables alias the same table. Lua's small, regular syntax
makes this kind of visualization unusually pleasant.

Current status: a single-page web prototype (zero install, runs in the
browser) with four demo programs: a loop, a recursive function, a
table-aliasing example, and an N-Queens solver written with Lua 5.3 bitwise
operators (a real backtracking algorithm, not a toy AST). It has a playback
timeline (play/pause/step/scrub), click-to-jump from AST nodes to the moment
they execute, a call-stack panel with per-frame colors, and a responsive
layout for desktop/tablet/phone.
The prototype also lets you edit and run Lua right in the page (parse errors
shown inline), create/import .lua files (file picker or drag & drop), its UI
is bilingual (English/Chinese), and it installs as a PWA so the demo works
offline.

Demo: https://ongikan.github.io/lua-mindscape/
Source: https://github.com/ONGIKAN/lua-mindscape

The parser/interpreter in the prototype are simplified JavaScript, used
only to validate the interaction model. The plan for the real version is a
Rust core (lossless full-moon AST + an explicit state-machine interpreter
that emits trace events) compiled to WebAssembly, with differential testing
against real Lua via mlua to keep semantics honest.

I'd very much welcome feedback - especially on whether node-level evaluation
traces are useful for debugging/teaching Lua, and which language features
would be most valuable to cover first (closures, metatables, coroutines...).

Thanks!
<your name>
```

### 3.5 Reddit r/lua 帖子

**标题（二选一）**：

```text
I'm building a visual debugger for Lua that animates the evaluation trace on the AST
```

```text
Lua Mindscape: watch a Lua program "think" — evaluation trace visualized on the AST (prototype)
```

**正文（英文）**：

```markdown
Hi r/lua,

I've been working on **Lua Mindscape** — a browser tool that visualizes how a
Lua chunk evaluates, not just what its AST looks like.

What it shows:
- the currently evaluating node, and the path from the root to it;
- values computed by each sub-expression (badges on the nodes);
- call-stack frames, each with its own color, matching the node highlight;
- loops/recursion "hot spots" (nodes that ran many times);
- table identity colors, so aliasing (`local b = a`) is visible immediately;
- an inline editor: change the Lua source and re-run it in place, plus
  new/import of .lua files (picker or drag & drop);
- four demo programs, including an N-Queens solver using Lua 5.3 bitwise
  operators — real backtracking code, so you can watch real algorithm traces.

There's a playback timeline (play/pause/step/scrub) and clicking an AST node
jumps to the moment it executes.

It's bilingual (English/Chinese) and installs as a PWA, so you can add it to
your desktop or home screen and use it offline.

It's currently a prototype: single-page web app, simplified JS parser and
interpreter, just to validate the interaction idea. The production core is
planned in Rust (full-moon + an explicit state-machine interpreter emitting
trace events) compiled to WASM, with differential testing against real Lua.

Demo: https://ongikan.github.io/lua-mindscape/
Source: https://github.com/ONGIKAN/lua-mindscape

Would love feedback: is this useful for teaching/debugging Lua? What would you
want to see first — closures, metatables, coroutines, error handling?
```

---

## 四、执行顺序（经你确认后）

1. 本地准备：双语 README（`README.md` / `README.en.md`）、双语设计文档（`docs/DESIGN.md` / `DESIGN.en.md`）、LICENSE、`.gitignore`、PWA 客户端（manifest / sw.js / icons）、git 提交（已完成）
2. 你执行 `gh auth login`，并确认仓库名与许可
3. 我创建远端仓库 → push → 打开 GitHub Pages（demo）
4. 把草稿里的 `ONGIKAN` / `https://ongikan.github.io/lua-mindscape/` 替换为真实地址
5. 按顺序发布：lua-users wiki 项目页 → lua-l 邮件 → Reddit / Discord → awesome-lua PR
6. 把每次发布结果与链接回填到本文件
