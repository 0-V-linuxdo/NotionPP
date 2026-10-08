/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export const NAV_CSS = `
:host {
  all: initial;
  --bg: #f7f7f5; --text: #37352f; --subtle: #6b6b6b; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.06);
  --active: rgba(15,15,15,.1); --line: rgba(15,15,15,.28); --line-active: #37352f; --shadow: 0 10px 30px rgba(15,15,15,.18);
  position: fixed; top: var(--nav-top, 4rem); height: var(--nav-height, calc(100vh - 12rem)); right: var(--nav-right, 20px);
  width: 0; z-index: 2147483000; display: block; pointer-events: none;
  font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:host([data-theme="dark"]) {
  --bg: #252525; --text: #ebebea; --subtle: #b4b4b0; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.08);
  --active: rgba(255,255,255,.13); --line: rgba(255,255,255,.35); --line-active: #e6e6e4; --shadow: 0 10px 30px rgba(0,0,0,.45);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
/* Like Void++: the rail is centered in the space between the chat header and the composer. */
.rail {
  position: absolute; top: 50%; right: 0; max-height: 100%; overflow: hidden; padding: 4px 0; transform: translateY(-50%);
  cursor: pointer; transition: opacity .2s ease; pointer-events: auto;
}
.lines { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; transition: transform .2s ease; }
.line { width: 16px; height: 2px; border-radius: 2px; background: var(--line); transition: width .2s, background .2s; }
.line[data-role="assistant"] { width: 10px; opacity: .7; }
.line.starred { background: #d9730d; opacity: 1; }
.line.active { width: 26px; background: var(--line-active); opacity: 1; box-shadow: 0 0 3px var(--line-active); }
.line.starred.active { background: #d9730d; box-shadow: 0 0 3px #d9730d; }
/* Like Void++'s dashed tick: the reply Notion AI is still writing. */
.line.streaming { background: repeating-linear-gradient(90deg, var(--line-active) 0 3px, transparent 3px 5px); opacity: 1; animation: npp-live 1.2s ease-in-out infinite; }
.line.streaming.active { box-shadow: none; }
@keyframes npp-live { 50% { opacity: .45; } }
.menu {
  position: absolute; top: 50%; right: -8px; width: 300px; max-height: 100%; overflow-y: auto; padding: 6px; pointer-events: auto;
  border: 1px solid var(--border); border-radius: 12px; color: var(--text); background: var(--bg); box-shadow: var(--shadow);
  opacity: 0; visibility: hidden; pointer-events: none; transform: translate(10px, -50%); transition: opacity .2s, visibility .2s, transform .2s;
  overscroll-behavior: contain;
}
:host(:hover) .menu, :host(:focus-within) .menu { opacity: 1; visibility: visible; pointer-events: auto; transform: translate(0, -50%); }
:host(:hover) .rail, :host(:focus-within) .rail { opacity: 0; }
.head { padding: 4px 10px 6px; color: var(--subtle); font-size: 12px; line-height: 1.4; letter-spacing: -.2px; font-variant-numeric: tabular-nums; }
ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 1px; }
button.item {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px;
  color: var(--subtle); background: transparent; font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
button.item:hover { color: var(--text); background: var(--hover); }
button.item.active { color: var(--text); background: var(--active); font-weight: 600; }
button.item[data-role="assistant"] { padding-left: 22px; font-size: 12.5px; }
div.item.pending { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 22px; color: var(--subtle); font-size: 12.5px; font-style: italic; }
.live { flex: 0 0 auto; padding: 0 5px; border: 1px dashed var(--line); border-radius: 4px; color: var(--subtle); font-size: 10.5px; font-style: normal; line-height: 16px; }
.label { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mark { flex: 0 0 auto; width: 14px; text-align: center; opacity: .75; }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .menu, .rail, .lines, .line { transition: none; } .line.streaming { animation: none; } }
@media (max-width: 640px) { :host { right: 8px; } .menu { width: min(300px, calc(100vw - 24px)); } }
`;

export const NAV_HTML = `
<nav class="root" aria-label="Chat outline">
  <div class="rail" aria-hidden="true"><div class="lines"></div></div>
  <div class="menu"><div class="head"></div><ul></ul></div>
</nav>`;
