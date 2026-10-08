/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

/**
 * The layout follows Void++'s settings UI (two-pane dialog, plugin card grid, nested plugin
 * dialog). Type, colours, controls and row rhythm are measured from Notion's own Settings
 * dialog: 14px/500 row titles with 13px/18px secondary descriptions, the control in a right
 * column, 28px controls with 6px corners, a 30×18 blue switch and hairline section dividers.
 */
export const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block;
  --surface-base: #ffffff; --surface-l1: #ffffff; --surface-l2: #fbfbfa; --surface-hover: rgba(55,53,47,.06);
  --surface-field: rgba(242,241,238,.6);
  --border-l1: rgba(55,53,47,.09); --border-l2: rgba(55,53,47,.16);
  --fg-primary: #37352f; --fg-secondary: #787774; --fg-tertiary: #a5a29a; --fg-invert: #ffffff;
  --accent: #2383e2; --accent-hover: #0077d4; --switch-off: rgba(135,131,120,.3);
  --fg-danger: #eb5757; --fg-warning: #d9730d; --overlay: rgba(15,15,15,.6);
  --shadow: 0 0 0 1px rgba(15,15,15,.05), 0 24px 48px rgba(15,15,15,.2);
  color-scheme: light;
  font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fg-primary); }
:host([data-theme="dark"]) {
  --surface-base: #191919; --surface-l1: #202020; --surface-l2: #252525; --surface-hover: rgba(255,255,255,.055);
  --surface-field: rgba(255,255,255,.055);
  --border-l1: rgba(255,255,243,.082); --border-l2: rgba(255,255,235,.1);
  --fg-primary: #f0efed; --fg-secondary: #ada9a3; --fg-tertiary: #7d7a75; --fg-invert: #191919;
  --accent: #2783de; --accent-hover: #3b8fe2; --switch-off: rgba(202,204,206,.3);
  --fg-danger: #ff7369; --overlay: rgba(0,0,0,.6);
  --shadow: 0 0 0 1px #383836, 0 24px 48px rgba(25,25,25,.64);
  color-scheme: dark; }
* { box-sizing: border-box; }
svg { width: 1rem; height: 1rem; flex-shrink: 0; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--fg-primary) 55%, transparent); outline-offset: 1px; }

.layer { position: fixed; inset: 0; display: grid; place-items: center; padding: 1rem; }
.layer-root { background: var(--overlay); }
.layer-nested { background: transparent; }
.layer-confirm { background: color-mix(in srgb, var(--overlay) 60%, transparent); }

/* Buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: .375rem; height: 28px; padding: 0 10px;
  border-radius: 6px; border: 1px solid transparent; font-size: 14px; font-weight: 500; line-height: 1; cursor: pointer; white-space: nowrap;
  transition: background-color .12s, border-color .12s, color .12s; }
.btn:disabled { opacity: .5; cursor: default; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-secondary { background: transparent; border-color: var(--border-l2); }
.btn-secondary:hover:not(:disabled) { background: var(--surface-hover); }
.btn-tertiary { background: transparent; }
.btn-tertiary:hover:not(:disabled) { background: var(--surface-hover); }
.btn-danger { background: transparent; color: var(--fg-danger); border-color: color-mix(in srgb, var(--fg-danger) 50%, transparent); }
.btn-danger:hover { background: color-mix(in srgb, var(--fg-danger) 10%, transparent); }
.btn-square { width: 28px; padding: 0; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 1.75rem; height: 1.75rem; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--fg-tertiary); cursor: pointer; }
.icon-btn:hover { background: var(--surface-hover); color: var(--fg-primary); }
.icon-btn.active { color: var(--fg-primary); }
.icon-btn svg { width: .9375rem; height: .9375rem; }

/* Switch (Notion: 30×18 track, 14px thumb, blue when on) */
.switch { position: relative; flex-shrink: 0; width: 30px; height: 18px; margin: 0; padding: 0; border: 0; border-radius: 44px;
  background: var(--switch-off); cursor: pointer; transition: background-color .2s; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(15,15,15,.2); transition: transform .2s ease-out; }
.switch[aria-checked="true"] { background: var(--accent); }
.switch[aria-checked="true"]::after { transform: translateX(12px); }
.switch:disabled { cursor: default; opacity: .6; }

/* Inputs */
.input, .select { height: 32px; border-radius: 6px; border: 1px solid var(--border-l2); background: var(--surface-field);
  color: var(--fg-primary); font: inherit; font-size: 14px; padding: 0 10px; }
.input::placeholder { color: var(--fg-tertiary); }
.input:focus, .select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.select { appearance: none; padding-right: 2rem; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--fg-secondary) 50%), linear-gradient(135deg, var(--fg-secondary) 50%, transparent 50%);
  background-position: calc(100% - 1rem) 52%, calc(100% - .7rem) 52%; background-size: .3rem .3rem; background-repeat: no-repeat; }
.select option { background: var(--surface-l1); color: var(--fg-primary); }

/* Main dialog: nav + content */
.dialog { position: relative; display: flex; width: min(56rem, calc(100vw - 2rem)); height: min(40rem, calc(100vh - 2rem));
  border-radius: 12px; border: 0; background: var(--surface-l1); box-shadow: var(--shadow); overflow: hidden; }
.nav { position: relative; flex: 0 0 13rem; display: flex; flex-direction: column; gap: .125rem; padding: 1rem .75rem;
  background: var(--surface-l2); border-right: 1px solid var(--border-l1); }
.nav-group { padding: .25rem .5rem .375rem; font-size: .75rem; font-weight: 500; color: var(--fg-tertiary); }
.nav-item { display: flex; align-items: center; gap: .5rem; height: 28px; padding: 0 6px; border: 0; border-radius: 6px;
  background: transparent; color: var(--fg-secondary); font-size: 14px; font-weight: 500; text-align: left; cursor: pointer; }
.nav-item:hover { background: var(--surface-hover); color: var(--fg-primary); }
.nav-item[aria-current="page"] { background: var(--surface-hover); color: var(--fg-primary); font-weight: 500; }
.version { position: absolute; left: 0; right: 0; bottom: 0; padding: .75rem; font-size: .625rem; line-height: 1rem;
  color: var(--fg-secondary); opacity: .45; user-select: text; }
.version a { color: inherit; text-decoration: none; } .version a:hover { text-decoration: underline; }
.content { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; padding-top: 1.25rem; }
.content-head { display: flex; align-items: center; gap: .375rem; padding: 0 3.5rem 0 1.25rem; margin-bottom: 1rem; }
.content-head h2 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
.hint { display: inline-flex; color: var(--fg-tertiary); cursor: help; }
.hint svg { width: .875rem; height: .875rem; }
.close { position: absolute; top: 1rem; right: 1rem; z-index: 2; color: var(--fg-secondary); }
.tab-root { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 1rem; padding: 0 1.25rem; }

/* Plugins tab */
.tabs { display: flex; flex-wrap: wrap; gap: .125rem; border-bottom: 1px solid var(--border-l1); }
.tab { position: relative; height: 2rem; padding: 0 .75rem; border: 0; border-radius: .5rem .5rem 0 0; background: transparent;
  color: var(--fg-secondary); font-size: .8125rem; font-weight: 500; cursor: pointer; }
.tab:hover { color: var(--fg-primary); }
.tab.active { color: var(--fg-primary); }
.tab.active::after { content: ""; position: absolute; inset-inline: .5rem; bottom: -1px; height: 2px; border-radius: 1px; background: var(--fg-primary); }
.search-bar { display: flex; align-items: center; gap: .75rem; }
.search-bar .input { flex: 1; min-width: 0; }
.search-bar .select { width: 7.5rem; }
.list { flex: 1; min-height: 0; overflow-y: auto; margin-inline: -1.25rem; padding: .25rem 1.25rem 2rem; display: flex; flex-direction: column; gap: 1rem;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 .75rem, #000 calc(100% - 1.5rem), transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 .75rem, #000 calc(100% - 1.5rem), transparent); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
.separator { height: 1px; flex-shrink: 0; background: var(--border-l1); }
.empty { padding: 2rem 0; text-align: center; color: var(--fg-secondary); }
@media (max-width: 40rem) { .grid { grid-template-columns: minmax(0, 1fr); } .nav { display: none; } }

/* Plugin card (Void++ BaseCard) */
.card { contain: content; display: flex; flex-direction: column; min-width: 0; min-height: 7.5rem; border-radius: .5rem;
  border: 1px solid var(--border-l1); background: var(--surface-l1); overflow: hidden; }
.card.required { opacity: .4; }
.card.crashed { opacity: .5; border-color: color-mix(in srgb, var(--fg-danger) 45%, transparent); }
.card-body { flex: 1; display: flex; flex-direction: column; gap: .25rem; padding: .625rem .75rem; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.card-name { display: flex; align-items: center; gap: .375rem; flex: 1; min-width: 0; overflow: hidden; }
.card-icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 1.5rem; height: 1.5rem;
  border-radius: .5rem; color: var(--fg-primary); background: color-mix(in srgb, var(--fg-primary) 10%, transparent); }
.card-icon svg { width: .875rem; height: .875rem; }
.card-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .875rem; font-weight: 500; }
.badge { display: inline-flex; color: var(--fg-tertiary); } .badge svg { width: .8125rem; height: .8125rem; }
.badge.danger { color: var(--fg-danger); }
.card-controls { display: flex; align-items: center; gap: .25rem; flex-shrink: 0; }
.card-controls .switch { margin-left: .25rem; }
.card-desc { margin-top: .25rem; font-size: .8125rem; line-height: 1.5; color: var(--fg-secondary); display: -webkit-box;
  -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-footer { display: flex; align-items: center; gap: .375rem; padding: .375rem .75rem; border-top: 1px solid var(--border-l1);
  font-size: .7rem; color: var(--fg-tertiary); min-width: 0; }
.card-footer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Nested dialogs (Void++ VoidPPDialogShell, Notion metrics) */
.sheet { position: relative; display: flex; flex-direction: column; gap: 20px; width: min(36rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem); padding: 28px 32px 24px; border-radius: 12px; border: 0;
  background: var(--surface-l1); box-shadow: var(--shadow); overflow: hidden; }
.sheet-sm { width: min(28rem, calc(100vw - 2rem)); gap: 16px; padding: 24px; }
.sheet-head { padding-right: 2rem; }
.sheet-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 28px; }
.sheet-desc { margin: 4px 0 0; font-size: 14px; line-height: 20px; color: var(--fg-secondary); }
.sheet-body { display: flex; flex-direction: column; gap: 28px; min-height: 0; overflow-y: auto; margin: 0 -32px -24px; padding: 0 32px 24px; }
.sheet > .close { top: 18px; right: 18px; }
.field { display: flex; flex-direction: column; gap: .25rem; min-height: 0; }
.field-label { font-size: 14px; font-weight: 500; }
.field-text { margin: 0; font-size: 14px; color: var(--fg-secondary); }
.footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; }

/* Sections and rows (Notion Settings: section title over a hairline, 24px between rows) */
.section { display: flex; flex-direction: column; }
.section-title { margin: 0 0 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-l1);
  font-size: 16px; line-height: 24px; font-weight: 500; color: var(--fg-primary); }
.settings-list { display: flex; flex-direction: column; gap: 24px; }
.settings-list[data-off] { opacity: .55; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 28px; }
.row-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.row-control { flex: 0 1 auto; min-width: 0; max-width: 50%; display: flex; justify-content: flex-end; }
.stack { display: flex; flex-direction: column; gap: .5rem; }
.s-title { font-size: 14px; font-weight: 500; line-height: 20px; color: var(--fg-primary); }
.s-desc { font-size: 13px; line-height: 18px; color: var(--fg-secondary); }
.color { display: flex; align-items: center; gap: 8px; }
.color input { width: 28px; height: 28px; padding: 2px; border: 1px solid var(--border-l2); border-radius: 6px; background: transparent; cursor: pointer; }
.color input::-webkit-color-swatch-wrapper { padding: 0; } .color input::-webkit-color-swatch { border: 0; border-radius: 4px; }
.color input::-moz-color-swatch { border: 0; border-radius: 4px; }
.color-value { font-size: 14px; color: var(--fg-secondary); font-variant-numeric: tabular-nums; }
.number { width: 5rem; text-align: right; }

/* Dropdown (Notion: borderless value + chevron, options in a popup menu) */
.dropdown { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 28px; padding: 0 6px 0 8px; border: 0;
  border-radius: 6px; background: transparent; color: var(--fg-primary); font-size: 14px; font-weight: 500; cursor: pointer; }
.dropdown:hover, .dropdown[aria-expanded="true"] { background: var(--surface-hover); }
.dropdown-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dropdown svg { width: 14px; height: 14px; color: var(--fg-tertiary); }
.layer-menu { display: block; padding: 0; background: transparent; }
.menu { position: fixed; display: flex; flex-direction: column; gap: 1px; max-width: min(20rem, calc(100vw - 16px));
  max-height: min(20rem, calc(100vh - 16px)); overflow-y: auto; padding: 4px; border-radius: 10px; background: var(--surface-l1);
  box-shadow: var(--shadow); }
.menu-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; padding: 4px 8px;
  border: 0; border-radius: 6px; background: transparent; color: var(--fg-primary); font-size: 14px; line-height: 20px; text-align: left; cursor: pointer; }
.menu-item:hover, .menu-item:focus-visible { background: var(--surface-hover); outline: none; }
.menu-label { white-space: normal; }
.menu-item svg { width: 14px; height: 14px; color: var(--fg-primary); }
.row .input { height: 28px; }
.dialog:focus, .sheet:focus { outline: none; }
.prefs { gap: 0; padding-top: .25rem; }

/* About tab */
.about { display: flex; flex-direction: column; gap: .75rem; overflow-y: auto; padding-bottom: 1.5rem; }
.about p { margin: 0; color: var(--fg-secondary); font-size: .875rem; line-height: 1.6; }
.about a { color: var(--fg-primary); }
`;
