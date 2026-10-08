/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

export const USAGE_CSS = `
:host {
  all: initial;
  --ring: #ada9a3; --orb-hover: rgba(255,255,255,.055); --warn: #d8a32f; --danger: #e56458;
  position: fixed; top: 16px; left: auto; right: 16px; z-index: 2147483646;
  display: block; width: max-content; max-width: calc(100vw - 16px);
  font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none;
}
:host([data-theme="light"]) { --ring: #7d7a75; --orb-hover: rgba(55,53,47,.06); }
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
button { font: inherit; }
[hidden] { display: none !important; }
.shell { position: relative; display: flex; flex-direction: column; align-items: flex-end; }
:host([data-side="left"]) .shell { align-items: flex-start; }
:host([data-docked]) .shell { align-items: center; }
.orb {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 5px;
  border: 0; border-radius: 6px; color: var(--ring); background: transparent; cursor: pointer; user-select: none;
  transition: background .1s ease;
}
.orb:hover, .orb:focus-visible { background: var(--orb-hover); }
.pct { font-size: 11.5px; line-height: 1; font-variant-numeric: tabular-nums; color: inherit; margin-inline: -1px 2px; }
.pct:last-child { margin-inline-end: 0; }
.ring { display: block; width: 18px; height: 18px; color: inherit; overflow: visible; }
.ring-track { fill: none; stroke: currentColor; stroke-opacity: .28; stroke-width: 2; }
.ring-fill { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; transition: stroke-dashoffset .3s ease; }
.ring[data-empty] .ring-fill { visibility: hidden; }
.ring[data-tone="warning"] { color: var(--warn); }
.ring[data-tone="danger"] { color: var(--danger); }
.tip {
  position: absolute; left: 50%; top: calc(100% + 6px); z-index: 3; width: max-content; min-width: 176px; max-width: 280px;
  display: flex; flex-direction: column; gap: 8px; padding: 8px 10px;
  border-radius: 6px; color: #f0efed; background: #2c2c2b;
  box-shadow: 0 4px 12px -2px rgba(0,0,0,.16), inset 0 0 0 1px rgba(255,255,255,.05);
  font: 400 12px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; white-space: nowrap; pointer-events: none;
  opacity: 0; visibility: hidden; transform: translateX(-50%); transition: opacity 50ms ease-out, visibility 50ms;
}
:host([data-tip-up]) .tip { top: auto; bottom: calc(100% + 6px); }
:host(:not([data-docked])) .tip { left: auto; right: 0; transform: none; }
:host(:not([data-docked])[data-side="left"]) .tip { left: 0; right: auto; }
.blk { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.lbl { font-size: 11px; color: #ada9a3; }
.val { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.sub { color: #ada9a3; font-variant-numeric: tabular-nums; }
.meters { display: grid; grid-template-columns: 1fr 1fr; column-gap: 20px; }
.today { padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,.09); }
.plan, .tip-note { padding-top: 8px; border-top: 1px solid rgba(255,255,255,.09); }
.tip-note { white-space: normal; color: #ada9a3; }
.tip-note[data-kind="error"] { color: #ff9b94; }
.orb:hover + .tip, .orb:focus-visible + .tip { opacity: 1; visibility: visible; }
@media (prefers-reduced-motion: reduce) { .tip, .ring-fill { transition: none; } }
`;

export const RING_RADIUS = 7;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING = `<svg class="ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="ring-track" cx="9" cy="9" r="${RING_RADIUS}"/><circle class="ring-fill" cx="9" cy="9" r="${RING_RADIUS}" transform="rotate(-90 9 9)" stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}"/></svg>`;

export const USAGE_HTML = `
<div class="shell">
  <button class="orb" type="button">${RING.replace("ring", "ring r-rolling")}<span class="pct pct-rolling" hidden></span>${RING.replace("ring", "ring r-monthly")}<span class="pct pct-monthly" hidden></span></button>
  <span class="tip" role="tooltip">
    <div class="blk today" hidden><div class="lbl tip-l-today"></div><div class="val tip-v-today"></div></div>
    <div class="meters">
      <div class="blk"><div class="lbl tip-l-rolling"></div><div class="val tip-v-rolling"></div><div class="sub tip-w-rolling"></div></div>
      <div class="blk"><div class="lbl tip-l-monthly"></div><div class="val tip-v-monthly"></div><div class="sub tip-w-monthly"></div></div>
    </div>
    <div class="blk plan" hidden><div class="lbl tip-l-plan"></div><div class="val tip-v-plan"></div><div class="sub tip-w-plan"></div></div>
    <div class="tip-note" hidden></div>
  </span>
</div>`;
