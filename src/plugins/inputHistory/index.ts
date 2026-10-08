/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { safeJson } from "@utils/guards";
import { Icons } from "@utils/icons";
import { pageWindow } from "@utils/page";

/*
 * Like Void++'s inputHistory: ↑ in an empty composer, or with the caret at the very start,
 * walks back through prompts sent before, ↓ walks forward, and Esc puts the draft back.
 * Prompts are kept in this browser only.
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

function save(list: string[]) {
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
    } else if (event.key === "ArrowDown" && browsing !== -1) {
        if (!caretAt(editor, "end")) return;
        consume(event);
        browsing++;
        if (browsing >= list.length) {
            fill(editor, draft);
            reset();
        } else fill(editor, list[browsing]);
    } else if (event.key === "Escape" && browsing !== -1) {
        consume(event);
        fill(editor, draft);
        reset();
    }
}

function onClick(event: MouseEvent) {
    const send = (event.target as Element | null)?.closest?.(SEND);
    if (!send || send.getAttribute("aria-disabled") === "true") return;
    record(send.closest(COMPOSER)?.querySelector<HTMLElement>("[contenteditable='true']") ?? null);
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
    },
    stop() {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("click", onClick, true);
        reset();
    },
});
