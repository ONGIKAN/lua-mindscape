# Lua Mindscape · Lua thought visualizer (UX prototype v0)

> Make Lua evaluation *visible*: an execution cursor walks the AST, the path it has
> traversed lights up, computed values appear on nodes, and recursive frames are
> layered by depth — like watching a program think.

**For awesome-lua / community listings:**

> - **[Lua Mindscape](https://github.com/ONGIKAN/lua-mindscape)** - An interactive visual debugger that projects Lua's evaluation trace onto the AST in real time, making recursion, scope frames and table aliases visible (single-page web prototype; Rust + WebAssembly core planned).

> 中文: [README.md](README.md). Design notes: [docs/DESIGN.en.md](docs/DESIGN.en.md) ([中文](docs/DESIGN.md)).

**Live demo:** <https://ongikan.github.io/lua-mindscape/> · **GitHub:** <https://github.com/ONGIKAN/lua-mindscape>

---

## What is this

A **single-page, zero-dependency front-end prototype** that validates one product idea:

> A Lua runtime that shows the AST live, and makes evaluation *legible* — so you can watch a program think.

It is a plain static site: open `index.html` directly (`file://` works, no build, no network).
It also supports **editing code and running it**, **creating and importing (incl. drag & drop) `.lua` files**,
a **bilingual UI (English / Chinese)**, and **installing as a desktop / mobile client (PWA, works offline)**.
The tree uses a **dead-zone camera**: it stays still while the current node is inside the viewport,
and pans minimally only when it is about to leave.

![Overview](docs/images/hero-en.png)

## Core design: the AST is only the skeleton; the trace is what feels like thinking

Drawing a static AST is easy (many IDEs do it). This prototype overlays three things:

1. **Structure** — the AST (built respecting operator precedence);
2. **Trace** — an explicit event stream from the interpreter
   `ent / cls / val / set / call / ret / iter / print / end / error`,
   replayed on a timeline; every event maps to one AST node;
3. **State** — current node, call frames, variable bindings, evaluated nodes, repetition hotspots (`×n`).

Visual mapping:

| Visual | Meaning |
| --- | --- |
| Box + ring + halo | The node currently being evaluated / executed |
| Solid indigo edge | The "thought path" from root to the current node |
| `= value` after a node | The expression's computed result |
| Highlighted source line | Source lines of the current node / caller frames |
| Colored stack-frame cards | One color per frame; the node halo uses the current frame's color |
| `×n` | How many times this node has been re-executed (loops / recursion) |
| Colored dot next to a table | Variables referencing the same table share a colored dot (aliasing at a glance) |

| Recursion: 4 frames, n = 3/2/1 | Table aliasing: `a` and `b` share `t1` |
| --- | --- |
| ![Recursion](docs/images/recursion.png) | ![Aliasing](docs/images/alias.png) |

## Supported language subset

This prototype is not full Lua 5.4, but it covers enough to run real algorithm code
(the built-in ④ N-Queens sample is a working bitwise backtracking solver):

- **Statements**: `local`, assignment (multiple targets), `if / elseif / else`, `while`, `do … end`,
  numeric `for`, `return`, function definitions (`function` / `local function`), call statements, semicolons;
- **Expressions**: arithmetic `+ - * / // % ^`, comparisons, `and / or / not`, string concat `..`,
  unary `-` `#` `~`, bitwise `& | ~ << >>` (Lua 5.3+ semantics), parentheses, table constructors,
  field access, and **indexing `t[k]`**;
- **Standard library**: `print`, `tonumber`, `tostring`, `type`, `assert`, `error`, `math.*`, `string.*`,
  `table.insert` / `table.concat`, plus the global `arg` (`arg[1] = '6'` in the prototype, so N-Queens solves 6×6);
- Parse errors report **line / column + nearby source**, shown inline in the code pane.

Not supported yet (the Rust interpreter will extend this): `repeat/until`, generic `for … in`,
metatables / `:` method sugar, `goto`, `coroutine`, varargs `...`, multiple return values, `require`.

## Quick start

```bash
# Option 1: just open the file
#   double-click index.html (file:// works)

# Option 2: local static server (recommended; needed for PWA install / offline)
python -m http.server 8080
# open http://127.0.0.1:8080
```

### Install as a client app (PWA, recommended on tablet / phone)

After opening over http(s):

- **Desktop Chrome / Edge**: install icon in the address bar, or the `⤓` button in the app;
- **Android Chrome**: menu → "Install app" / "Add to Home screen";
- **iOS Safari**: Share → "Add to Home Screen".

Once installed it works offline (Service Worker caches the app shell), with its own window.
The production desktop / mobile builds will ship as **Tauri 2** native apps (see architecture).

### Controls

| Action | Effect |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Previous / next event |
| `R` | Restart |
| Click an AST node | Jump to the moment when execution reaches that node |
| Timeline slider | Scrub to any moment (inspects that state directly) |
| Drag / zoom buttons on the tree | Pan, zoom; `⤢` resumes "follow the current node" |
| Click the code pane / `✎` | Enter edit mode and edit Lua directly |
| Toolbar `+ New` / `Import` | New program / import a `.lua` file; you can also drag a file onto the code pane (runs automatically) |
| `Ctrl`/`⌘` + `Enter` | Run the edited code; parse errors are shown inline |
| `Esc` | Cancel editing and restore the running code |
| `EN / 中` | Switch UI language |

Four built-in samples: loop sum, recursion, table aliasing, and **N-Queens (bitwise backtracking)**.
Expected output: **30 / 6 / 12 / 4**. The N-Queens sample is real algorithm code — recursion + bitwise
operators + indexing + the standard library — and shows off recursive frames, repetition hotspots and
bitwise expression trees at the same time.

![N-Queens: bitwise backtracking](docs/images/queens.png)

The camera does **fit-the-tree first, then follows a dead zone**: on load / run it scales and centers
the whole tree inside the tree panel; during playback the view does not move at all while the current
node is inside the viewport, and snaps once only when the node would leave it. Clicking a node,
zooming or `⤢` re-centers on purpose.

### URL parameters (for screenshots and UI automation)

| Parameter | Meaning |
| --- | --- |
| `program=loop\|fact\|alias\|queens` | Pick a sample program |
| `still=1&step=N` | Render statically at event N (no auto-play; for screenshots) |
| `speed=N` | Milliseconds per event (default 180) |
| `scale=0.72` | Initial zoom |
| `debug=1` | Write camera/layout state into `document.title` |
| `lang=zh\|en` | UI language (remembers last choice in localStorage) |

Edited code is saved to localStorage (`lua-mindscape:src`) and restored on reload;
`?program=` overrides it. `↺ sample` restores the built-in code.

## Repository layout

```
lua-brain-proto/
├── index.html              single-page app (three panes + inline code editor)
├── style.css               light, square, minimal theme + responsive (≤980px stacked)
├── app.js                  Lua-subset parser + explicit-state interpreter + trace playback + editor + i18n
├── manifest.webmanifest    PWA manifest (installable client)
├── sw.js                   Service Worker (app-shell cache, offline)
├── icons/                  PWA / desktop icons
├── tools/
│   ├── inspect-trace.js    Node CLI: print the event stream and per-step state
│   └── qa.mjs              headless Edge + CDP: screenshots / assertions (zero dependencies)
├── docs/
│   ├── DESIGN.md           design notes (Chinese)
│   ├── DESIGN.en.md        design notes (English)
│   ├── images/             screenshots
│   └── community-submission.md  community submission drafts (awesome-lua / lua-users / lua-l / Reddit)
├── README.md               Chinese README
└── README.en.md            this file
```

## Prototype validation (QA)

Verified in a real browser with `tools/qa.mjs` (headless Edge + Chrome DevTools Protocol):

- Semantics of the four samples: loop → `30`, fact → `6`, alias → `12`, queens → `4`
  (77 / 85 / 39 / 14,952 trace events);
- Recursion: 4 frames alive at once, `n` = 3 / 2 / 1, halo colors match frame colors;
- Aliasing: `a` and `b` show the same `t1` color dot; after `b.x = 10`, `a.x` is 10;
- N-Queens (real bitwise backtracking with `arg` / `tonumber` / `assert` / indexing / `& | ~ << >>`)
  parses and runs correctly; 3 recursive frames visible with their `cols / diag1 / diag2 / avail / bit`
  values; output `4`;
- Layouts work at 1600×1000 / 1920×1080 desktop, 820×1180 tablet, 390×844 phone;
- No exceptions, no console errors; scrubbing, stepping, node-jump and sample switching all pass;
- Code editing: custom code `local x = 5 / print(x * 2)` runs (19 trace events), parse errors are inline;
  pasting the whole N-Queens program also runs;
- Bilingual: with `?lang=en` the title / brand / hints / stack texts all switch; the `EN / 中` toggle persists;
- PWA: manifest + Service Worker register successfully; installable and offline-capable.

| Tablet | Phone |
| --- | --- |
| ![Tablet](docs/images/tablet.png) | ![Phone](docs/images/phone.png) |

| Editing code and running it | English UI |
| --- | --- |
| ![Editor](docs/images/editor.png) | ![English](docs/images/hero-en.png) |

### Regenerate screenshots

```bash
node tools/qa.mjs --program loop --step 45 --width 1920 --height 1080 --out docs/images/hero.png
node tools/qa.mjs --program queens --step 320 --width 1600 --height 1000 --out docs/images/queens.png
node tools/qa.mjs --program fact --step 60 --out docs/images/recursion.png
node tools/qa.mjs --program alias --step 25 --out docs/images/alias.png
node tools/qa.mjs --program loop --step 45 --width 390 --height 844 --out docs/images/phone.png
```

(Requires Microsoft Edge; `tools/qa.mjs` is dependency-free — Node's built-in WebSocket + fetch.)

## Production architecture (design decisions)

The prototype's parser / interpreter are a **throwaway JavaScript simplification**, built only to
validate interaction and visuals. The production core is planned in Rust + Lua:

```
┌──────────── Frontend (TypeScript / Web-first) ────────────┐
│  Playback player: rAF consumes the event stream            │
│  TreeView / CodeView / StackView / TableView               │
│  Timeline scrubbing · breakpoints · stepping · snapshots   │
└───────────────▲────────────────────────────────────────────┘
                │  TraceEvent[] (TS types generated by ts-rs)
┌───────────────┴──────── Rust core → WebAssembly ──────────┐
│  Linter/Parser: full-moon (lossless AST with source spans) │
│  Interpreter: explicit-state machine emitting TraceEvents  │
│  Differ: differential tests against real Lua via mlua      │
└────────────────────────────────────────────────────────────┘
```

Key decisions and rationale:

1. **No line-hook instrumentation of a real Lua VM.** Lua's debug hooks are line-granular;
   they cannot produce AST-node-level enter / exit / value events — and node-level events are
   exactly what makes the "thinking" effect work.
2. **Write our own explicit-state interpreter (subset first)**; it can emit events around every
   node evaluation. The risk is semantic compatibility — mitigated by **mlua + differential
   testing** (random programs, compare results with real Lua).
3. **full-moon parsing**: lossless AST + spans directly satisfy node ↔ source-range highlighting,
   supports Lua 5.4, and saves maintaining a parser.
4. **Compile the Rust core to WASM** for web / tablet / phone browsers; ship desktop and mobile
   with **Tauri 2** using the same frontend (the cheapest cross-platform path).
5. **Render with SVG/DOM** (node counts are modest; CSS animation and accessibility are easy);
   fall back to Canvas/WebGL for huge programs; update only changed nodes — O(changed), not full re-render.

## Roadmap

- **P0 concept validation** (done, this repo): interaction model + visual language + responsive
  layout + code editing + bilingual UI + installable PWA client.
- **P1 semantic correctness**: Rust interpreter for a common subset (locals, assignments,
  arithmetic/comparison/logic, if/while/numeric for, functions & recursion, tables/field access,
  string concatenation, print), differential tests, WASM + TS types, run arbitrary user code.
- **P2 debugging experience**: timeline rewind (checkpoints), breakpoints, step in/over/out,
  stack UI, tables/closures visualization, error hints; 60fps.
- **P3 cross-platform**: Tauri 2 desktop + mobile builds, phone full-screen tree gestures, offline.
- **P4 content & ecosystem**: share links / iframe embeds, tutorial mode (pre-recorded scripts),
  VSCode extension (trace visualization inside the editor).

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Full Lua semantics is hard (coroutine / goto / metatables / varargs) | Start with a subset + differential tests + staged expansion |
| Event stream can explode (long loops / deep recursion) | Event caps + sampling + snapshots + render only the visible region |
| Wide trees overflow the screen | Collapse statements by default, expand expressions on demand, zoom / follow |
| "Looks like a brain" could be just a gimmick | Validate on teaching tasks: can users explain a bug (infinite loop / closure / aliasing) faster? |

## License

MIT License — free for personal and commercial use, modification and distribution; just keep the copyright notice. See [LICENSE](LICENSE).

> Prefer Apache-2.0 for an explicit patent grant, or MPL-2.0 / GPL-3.0 if you want modifications to stay open.
