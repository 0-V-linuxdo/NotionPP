/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";
import { debounce } from "@utils/time";

import { USER_STEP } from "../navigator/messages";

/*
 * Like Void++'s userQuotes: lines of your own questions that start with ">" get a bar on the left,
 * like a quote. Notion keeps the question as one plain text node that it owns, so it is left untouched:
 * Notion's own text is hidden and a copy laid out with real quote blocks is shown in its place,
 * rebuilt whenever the text changes and dropped while the question is being edited.
 */

const STYLE_ID = "notionai-pp-user-quotes";
const LEAF = `[${USER_STEP}] [data-content-editable-leaf]`;

export const settings = definePluginSettings({
    dim: {
        type: "boolean",
        label: { zh: "引用文字变淡", en: "Dim quoted text" },
        default: true,
    },
    italic: {
        type: "boolean",
        label: { zh: "引用文字用斜体", en: "Italic quoted text" },
        default: false,
    },
    marks: {
        type: "boolean",
        label: { zh: "引用两侧加引号", en: "Quotation marks around quotes" },
        description: { zh: "在每段引用的开头和结尾加上 “ ”", en: "Put “ ” at the start and end of each quote" },
        default: false,
    },
});

export interface QuoteLine {
    /** Offset of the ">" in the text. */
    start: number;
    /** Offset just after "> " (the marker and one space). */
    body: number;
    /** Offset of the line end. */
    end: number;
    line: number;
}

export function quoteLines(text: string): QuoteLine[] {
    const result: QuoteLine[] = [];
    let offset = 0;
    text.split("\n").forEach((line, index) => {
        const match = /^([ \t]*)>[ \t]?/.exec(line);
        if (match) result.push({ start: offset + match[1].length, body: offset + match[0].length, end: offset + line.length, line: index });
        offset += line.length + 1;
    });
    return result;
}

const MIRROR = "data-npp-quote-mirror";
const HIDDEN = "data-npp-quote-hidden";

function css() {
    return `[${HIDDEN}] { display: none !important; }
[${MIRROR}] > div:empty::after { content: "\\200b"; }
[${MIRROR}] .q { border-inline-start: 3px solid var(--c-texTer, rgba(127,127,127,.55)); padding-inline-start: 10px; margin-block: 2px; }
[${MIRROR}] .q > div:empty::after { content: "\\200b"; }
${settings.store.dim ? `[${MIRROR}] .q { color: var(--c-texSec, rgba(127,127,127,.95)); }` : ""}
${settings.store.italic ? `[${MIRROR}] .q { font-style: italic; }` : ""}
${settings.store.marks ? `[${MIRROR}] .q > div:first-child::before { content: "“"; } [${MIRROR}] .q > div:last-child::after { content: "”"; }` : ""}`;
}

/** The mirror's content: plain lines as rows, each run of quote lines as one indented block. */
export function buildMirror(text: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const quotes = new Map(quoteLines(text).map(line => [line.line, line]));
    const row = (content: string) => Object.assign(document.createElement("div"), { textContent: content });
    let block: HTMLElement | null = null;
    text.split("\n").forEach((line, index) => {
        const quote = quotes.get(index);
        if (quote) {
            if (!block) {
                block = document.createElement("div");
                block.className = "q";
                fragment.append(block);
            }
            block.append(row(text.slice(quote.body, quote.end)));
        } else {
            block = null;
            fragment.append(row(line));
        }
    });
    return fragment;
}

function unmirror(leaf: Element) {
    leaf.removeAttribute(HIDDEN);
    const next = leaf.nextElementSibling;
    if (next?.hasAttribute(MIRROR)) next.remove();
}

function mirror(leaf: HTMLElement) {
    const text = leaf.textContent ?? "";
    const editing = leaf.getAttribute("contenteditable") === "true";
    if (editing || !quoteLines(text).length) return unmirror(leaf);
    let copy = leaf.nextElementSibling as HTMLElement | null;
    if (!copy?.hasAttribute(MIRROR)) {
        copy = document.createElement("div");
        copy.setAttribute(MIRROR, "");
        leaf.after(copy);
    }
    if (copy.dataset.src === text) return void leaf.setAttribute(HIDDEN, "");
    copy.className = leaf.className;
    copy.setAttribute("style", leaf.getAttribute("style") ?? "");
    copy.style.cursor = "text";
    copy.dataset.src = text;
    copy.replaceChildren(buildMirror(text));
    leaf.setAttribute(HIDDEN, "");
}

export function render() {
    for (const leaf of document.querySelectorAll<HTMLElement>(LEAF)) mirror(leaf);
    // mirrors whose question is gone
    for (const copy of document.querySelectorAll(`[${MIRROR}]`)) {
        const leaf = copy.previousElementSibling;
        if (!leaf?.matches(LEAF)) copy.remove();
    }
}

const schedule = debounce(render, 120, 400);
let stopDom: (() => void) | null = null;
/** Text edited in place and edit mode switching change no child lists, so DomWatch misses them. */
let textWatch: MutationObserver | null = null;

function applyStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css();
}

export default definePlugin({
    name: "userQuotes",
    title: { zh: "引用行样式", en: "Quote lines" },
    description: {
        zh: "提问里以 > 开头的行显示成引用：左侧一条竖线，> 符号隐藏，文字稍淡，和自己的话区分开。",
        en: "Lines of your questions that start with > show as quotes: a bar on the left, the > hidden and the text dimmed.",
    },
    icon: Icons.quote,
    tags: ["chat", "appearance"],
    enabledByDefault: true,
    updatedAt: "2026-10-08",
    settings,
    start() {
        applyStyle();
        render();
        stopDom = onDomChange(mutations => {
            // our own mirrors changing must not trigger another pass
            if (mutations.every(m => (m.target as Element).closest?.(`[${MIRROR}]`))) return;
            schedule();
        });
        textWatch = new MutationObserver(mutations => {
            if (mutations.some(m => (m.target instanceof Element ? m.target : m.target.parentElement)?.closest(`[${USER_STEP}]`))) schedule();
        });
        textWatch.observe(document.documentElement, { characterData: true, subtree: true, attributes: true, attributeFilter: ["contenteditable"] });
    },
    stop() {
        stopDom?.();
        stopDom = null;
        textWatch?.disconnect();
        textWatch = null;
        schedule.cancel();
        for (const leaf of document.querySelectorAll(`[${HIDDEN}]`)) unmirror(leaf);
        for (const copy of document.querySelectorAll(`[${MIRROR}]`)) copy.remove();
        document.getElementById(STYLE_ID)?.remove();
    },
    onSettingsChange() {
        applyStyle();
    },
});
