/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { createOverlay, type Overlay } from "@api/Overlay";
import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { safeJson } from "@utils/guards";
import { Icons } from "@utils/icons";
import { pageWindow, t } from "@utils/page";

/*
 * Like Void++'s inputHistory: ↑ in an empty composer, or with the caret at the very start,
 * walks back through prompts sent before, ↓ walks forward, and Esc puts the draft back.
 * While walking, a "3 / 20" counter sits on the composer; clicking it (or the settings button)
 * opens a list of all saved prompts to search, insert or delete. Kept in this browser only.
 */

export const STORE_KEY = "notionai-pp:input-history:v1";
const COMPOSER = "[data-notion-chat-input-container]";
const EDITOR = `${COMPOSER} [contenteditable='true']`;
const SEND = "[data-testid='agent-send-message-button']";
const POPUP = "[role='listbox'], [role='menu'], .notion-mention-menu";

export const settings = definePluginSettings({
    max: {
        type: "number",
        label: { zh: "最多保存条数", en: "Prompts to keep" },
        default: 100,
        min: 10,
        max: 500,
    },
    browse: {
        type: "action",
        label: { zh: "浏览输入历史", en: "Browse prompt history" },
        description: { zh: "搜索、点选填入输入框，或删除单条", en: "Search, insert into the composer, or delete single prompts" },
        button: { zh: "打开", en: "Open" },
        run: () => openBrowser(),
    },
    clear: {
        type: "action",
        label: { zh: "清空输入历史", en: "Clear prompt history" },
        button: { zh: "清空", en: "Clear" },
        run: () => save([]),
    },
});

export function load(): string[] {
    try {
        const list = safeJson(pageWindow.localStorage.getItem(STORE_KEY) ?? "");
        return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

export function save(list: string[]) {
    try {
        pageWindow.localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {}
}

/** Newest last; a repeat moves to the end instead of being stored twice. */
export function remember(list: string[], text: string, max: number): string[] {
    const value = text.trim();
    if (!value) return list;
    return [...list.filter(item => item !== value), value].slice(-max);
}

const textOf = (editor: HTMLElement) => (editor.innerText ?? "").replace(/\n$/, "");

function caretAt(editor: HTMLElement, edge: "start" | "end"): boolean {
    const selection = document.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    const caret = selection.getRangeAt(0);
    if (edge === "start") range.setEnd(caret.startContainer, caret.startOffset);
    else range.setStart(caret.endContainer, caret.endOffset);
    return range.toString().length === 0;
}

/** Replaces the composer's text through the editing pipeline, so Notion's editor sees a normal edit. */
export function fill(editor: HTMLElement, text: string) {
    editor.focus();
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (text) document.execCommand("insertText", false, text);
    else document.execCommand("delete");
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(end);
}

let browsing = -1;
let draft = "";
let browsingEditor: HTMLElement | null = null;

function reset() {
    browsing = -1;
    draft = "";
    browsingEditor = null;
    hideCounter();
}

function record(editor: HTMLElement | null) {
    if (!editor) return;
    save(remember(load(), textOf(editor), settings.store.max));
    reset();
}

/** Ours alone: Notion's own arrow-key handling would move the caret or open other UI. */
function consume(event: KeyboardEvent) {
    event.preventDefault();
    event.stopImmediatePropagation();
}

const popupOpen = () => [...document.querySelectorAll<HTMLElement>(POPUP)].some(node => node.getClientRects().length > 0);

function onKeyDown(event: KeyboardEvent) {
    const editor = (event.target as Element | null)?.closest?.<HTMLElement>(EDITOR);
    if (!editor || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter" && !event.shiftKey) {
        if (!popupOpen()) record(editor);
        return;
    }
    if (event.shiftKey || popupOpen()) return;
    if (browsingEditor && browsingEditor !== editor) reset();
    const list = load();
    if (event.key === "ArrowUp") {
        const empty = !textOf(editor).trim();
        if (!list.length || (!empty && !caretAt(editor, "start"))) return;
        if (browsing === -1) {
            draft = textOf(editor);
            browsing = list.length;
            browsingEditor = editor;
        }
        consume(event);
        if (browsing === 0) return;
        browsing--;
        fill(editor, list[browsing]);
        showCounter(editor, browsing, list.length);
    } else if (event.key === "ArrowDown" && browsing !== -1) {
        if (!caretAt(editor, "end")) return;
        consume(event);
        browsing++;
        if (browsing >= list.length) {
            fill(editor, draft);
            reset();
        } else {
            fill(editor, list[browsing]);
            showCounter(editor, browsing, list.length);
        }
    } else if (event.key === "Escape" && browsing !== -1) {
        consume(event);
        fill(editor, draft);
        reset();
    }
}

/** The counter belongs to the focused composer; leaving it (another tab, a click elsewhere) hides it. */
function onFocusOut(event: FocusEvent) {
    if ((event.target as Element | null)?.closest?.(EDITOR)) hideCounter();
}

function onClick(event: MouseEvent) {
    const send = (event.target as Element | null)?.closest?.(SEND);
    if (!send || send.getAttribute("aria-disabled") === "true") return;
    record(send.closest(COMPOSER)?.querySelector<HTMLElement>("[contenteditable='true']") ?? null);
}

/* ---------- counter ---------- */

const COUNTER_CSS = `
:host { all: initial; }
button { position: fixed; z-index: 2147482000; transform: translate(-100%, -50%); padding: 2px 8px; border-radius: 999px;
  border: 1px solid rgba(55,53,47,.16); background: #fff; color: rgba(55,53,47,.75); cursor: pointer;
  font: 500 11.5px/18px ui-sans-serif, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums;
  box-shadow: 0 2px 8px rgba(15,15,15,.08); }
button:hover { color: #37352f; border-color: rgba(55,53,47,.3); }
:host([data-theme="dark"]) button { background: #2f2f2f; color: rgba(255,255,255,.7); border-color: rgba(255,255,255,.14); }
:host([data-theme="dark"]) button:hover { color: #fff; }
`;

let counter: Overlay | null = null;

/** Display position of entry `index` (oldest is 1). */
export const counterText = (index: number, total: number) => `${index + 1} / ${total}`;

function showCounter(editor: HTMLElement, index: number, total: number) {
    const box = editor.closest(COMPOSER)?.getBoundingClientRect();
    if (!box) return;
    if (!counter) {
        counter = createOverlay("notionai-pp-history-counter", COUNTER_CSS, `<button type="button"></button>`);
        const button = counter.root.querySelector("button")!;
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => openBrowser());
    }
    const button = counter.root.querySelector<HTMLButtonElement>("button")!;
    button.textContent = counterText(index, total);
    button.title = t("点击浏览全部输入历史", "Click to browse all prompts");
    button.style.left = `${box.right - 14}px`;
    button.style.top = `${box.top}px`;
}

function hideCounter() {
    counter?.destroy();
    counter = null;
}

/* ---------- browser ---------- */

const BROWSER_CSS = `
:host { all: initial; --bg: #fff; --fg: #37352f; --fg2: rgba(55,53,47,.65); --line: rgba(55,53,47,.09); --hover: rgba(55,53,47,.06); --accent: #2383e2; }
:host([data-theme="dark"]) { --bg: #252525; --fg: rgba(255,255,255,.88); --fg2: rgba(255,255,255,.5); --line: rgba(255,255,255,.09); --hover: rgba(255,255,255,.06); }
.backdrop { position: fixed; inset: 0; z-index: 2147482500; background: rgba(15,15,15,.45); display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; }
.panel { width: min(640px, calc(100vw - 32px)); max-height: 70vh; display: flex; flex-direction: column; border-radius: 12px; background: var(--bg); color: var(--fg);
  box-shadow: 0 16px 48px rgba(0,0,0,.3); font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
.head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
input { flex: 1; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 15px; }
.count { color: var(--fg2); font-size: 12px; white-space: nowrap; }
.list { overflow: auto; padding: 6px; }
.item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.item:hover, .item.active { background: var(--hover); }
.text { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.del { flex: none; border: 0; background: none; color: var(--fg2); cursor: pointer; padding: 2px 6px; border-radius: 6px; font: inherit; font-size: 12px; visibility: hidden; }
.item:hover .del, .item.active .del { visibility: visible; }
.del:hover { color: #eb5757; background: var(--hover); }
.empty { padding: 24px; text-align: center; color: var(--fg2); }
.foot { padding: 8px 14px; border-top: 1px solid var(--line); color: var(--fg2); font-size: 12px; }
`;

let browser: Overlay | null = null;

/** Newest first, filtered by every space-separated word of the query. */
export function searchHistory(list: string[], query: string): { text: string; index: number }[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return list.map((text, index) => ({ text, index }))
        .filter(({ text }) => words.every(word => text.toLowerCase().includes(word)))
        .reverse();
}

function closeBrowser() {
    browser?.destroy();
    browser = null;
}

export function openBrowser() {
    closeBrowser();
    browser = createOverlay("notionai-pp-history-browser", BROWSER_CSS, `
      <div class="backdrop"><div class="panel" role="dialog" aria-modal="true">
        <div class="head"><input type="search" spellcheck="false"><span class="count"></span></div>
        <div class="list" role="listbox"></div>
        <div class="foot"></div>
      </div></div>`);
    const { root } = browser;
    const input = root.querySelector("input")!;
    const list = root.querySelector<HTMLElement>(".list")!;
    const count = root.querySelector<HTMLElement>(".count")!;
    input.placeholder = t("搜索输入历史…", "Search prompts…");
    root.querySelector(".foot")!.textContent = t("↑↓ 选择 · Enter 填入输入框 · Delete 删除 · Esc 关闭", "↑↓ select · Enter insert · Delete remove · Esc close");
    let active = 0;
    let shown: { text: string; index: number }[] = [];
    const insert = (text: string) => {
        closeBrowser();
        const editor = document.querySelector<HTMLElement>(EDITOR);
        if (editor) fill(editor, text);
        reset();
    };
    const remove = (index: number) => {
        const all = load();
        all.splice(index, 1);
        save(all);
        render();
    };
    const render = () => {
        const all = load();
        shown = searchHistory(all, input.value);
        active = Math.min(active, Math.max(0, shown.length - 1));
        count.textContent = input.value ? `${shown.length} / ${all.length}` : t(`共 ${all.length} 条`, `${all.length} prompts`);
        list.replaceChildren(...shown.map((entry, position) => {
            const item = document.createElement("div");
            item.className = position === active ? "item active" : "item";
            item.setAttribute("role", "option");
            const text = Object.assign(document.createElement("div"), { className: "text", textContent: entry.text, title: entry.text });
            const del = Object.assign(document.createElement("button"), { className: "del", type: "button", textContent: t("删除", "Delete") });
            del.addEventListener("click", event => {
                event.stopPropagation();
                remove(entry.index);
            });
            item.addEventListener("click", () => insert(entry.text));
            item.append(text, del);
            return item;
        }));
        if (!shown.length) list.append(Object.assign(document.createElement("div"), { className: "empty", textContent: all.length ? t("没有匹配的提问", "No matching prompts") : t("还没有输入历史", "No prompts yet") }));
        list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => {
        active = 0;
        render();
    });
    root.querySelector(".backdrop")!.addEventListener("mousedown", event => {
        if (event.target === event.currentTarget) closeBrowser();
    });
    root.addEventListener("keydown", event => {
        const key = (event as KeyboardEvent).key;
        if (key === "Escape") closeBrowser();
        else if (key === "ArrowDown" || key === "ArrowUp") {
            active = Math.max(0, Math.min(shown.length - 1, active + (key === "ArrowDown" ? 1 : -1)));
            render();
        } else if (key === "Enter" && shown[active]) insert(shown[active].text);
        else if (key === "Delete" && shown[active] && input.selectionStart === input.value.length) remove(shown[active].index);
        else return;
        event.preventDefault();
        event.stopPropagation();
    });
    render();
    input.focus();
}

export default definePlugin({
    name: "inputHistory",
    title: { zh: "输入历史", en: "Prompt history" },
    description: {
        zh: "在 AI 输入框里按 ↑ / ↓ 调出以前发过的提问，像终端一样；Esc 恢复刚才的草稿。只保存在本浏览器。",
        en: "Press ↑ / ↓ in the AI composer to recall prompts you sent before, like a shell; Esc restores your draft. Kept in this browser only.",
    },
    icon: Icons.history,
    tags: ["composer"],
    enabledByDefault: true,
    settings,
    start() {
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("click", onClick, true);
        document.addEventListener("focusout", onFocusOut, true);
    },
    stop() {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("focusout", onFocusOut, true);
        reset();
        closeBrowser();
    },
});
