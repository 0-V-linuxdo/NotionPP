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
 * like a quote. Notion keeps the question as one plain text node, so nothing in it is rewritten:
 * the "> " marker is made invisible and the quoted text dimmed with CSS highlights, and the bars
 * are drawn on a separate layer inside the bubble.
 */

const STYLE_ID = "notionai-pp-user-quotes";
const HOST = "data-npp-quote-host";
const LAYER = "data-npp-quote-layer";
const MARKER_HL = "npp-quote-marker";
const TEXT_HL = "npp-quote-text";
const LEAF = `[${USER_STEP}] [data-content-editable-leaf]:not([contenteditable='true'])`;

export const settings = definePluginSettings({
    dim: {
        type: "boolean",
        label: { zh: "引用文字变淡", en: "Dim quoted text" },
        default: true,
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

/** Runs of quote lines on consecutive lines, each drawn as one bar. */
export function quoteBlocks(lines: QuoteLine[]): QuoteLine[][] {
    const blocks: QuoteLine[][] = [];
    for (const line of lines) {
        const last = blocks.at(-1);
        if (last && last.at(-1)!.line === line.line - 1) last.push(line);
        else blocks.push([line]);
    }
    return blocks;
}

/** A range over character offsets of an element's text, across however many text nodes it has. */
export function rangeAt(root: Element, start: number, end: number): Range | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (!started && start <= seen + length) {
            range.setStart(node, start - seen);
            started = true;
        }
        if (started && end <= seen + length) {
            range.setEnd(node, end - seen);
            return range;
        }
        seen += length;
    }
    return null;
}

const highlights = () => (globalThis as any).CSS?.highlights as Map<string, unknown> | undefined;
const Highlight = () => (globalThis as any).Highlight as (new (...ranges: Range[]) => unknown) | undefined;

function css() {
    return `[${HOST}] { position: relative; }
[${LAYER}] { position: absolute; inset: 0; pointer-events: none; }
[${LAYER}] > div { position: absolute; width: 3px; border-radius: 2px; background: var(--c-texTer, rgba(127,127,127,.6)); opacity: .7; }
::highlight(${MARKER_HL}) { color: transparent; }
${settings.store.dim ? `::highlight(${TEXT_HL}) { color: var(--c-texSec, rgba(127,127,127,.9)); }` : ""}`;
}

function drawLeaf(leaf: HTMLElement, markers: Range[], texts: Range[]) {
    const host = leaf.parentElement;
    if (!host) return;
    let layer = host.querySelector<HTMLElement>(`:scope > [${LAYER}]`);
    const lines = quoteLines(leaf.textContent ?? "");
    if (!lines.length) {
        layer?.remove();
        host.removeAttribute(HOST);
        return;
    }
    host.setAttribute(HOST, "");
    if (!layer) {
        layer = document.createElement("div");
        layer.setAttribute(LAYER, "");
        layer.setAttribute("aria-hidden", "true");
        host.append(layer);
    }
    const origin = host.getBoundingClientRect();
    const bars: HTMLElement[] = [];
    for (const block of quoteBlocks(lines)) {
        const marker = rangeAt(leaf, block[0].start, block[0].start + 1);
        const whole = rangeAt(leaf, block[0].start, block.at(-1)!.end);
        if (!marker || !whole) continue;
        const rects = [...whole.getClientRects()].filter(rect => rect.height > 0);
        if (!rects.length) continue;
        const top = Math.min(...rects.map(rect => rect.top));
        const bottom = Math.max(...rects.map(rect => rect.bottom));
        const bar = document.createElement("div");
        // in the bubble's side padding, so wrapped lines of a long quote don't run under it
        bar.style.left = `${marker.getBoundingClientRect().left - origin.left - 8}px`;
        bar.style.top = `${top - origin.top + 2}px`;
        bar.style.height = `${Math.max(0, bottom - top - 4)}px`;
        bars.push(bar);
        for (const line of block) {
            const markerRange = rangeAt(leaf, line.start, line.body);
            const textRange = rangeAt(leaf, line.body, line.end);
            if (markerRange) markers.push(markerRange);
            if (textRange && line.end > line.body) texts.push(textRange);
        }
    }
    layer.replaceChildren(...bars);
}

export function render() {
    const markers: Range[] = [];
    const texts: Range[] = [];
    const live = new Set<Element>();
    for (const leaf of document.querySelectorAll<HTMLElement>(LEAF)) {
        drawLeaf(leaf, markers, texts);
        if (leaf.parentElement) live.add(leaf.parentElement);
    }
    for (const host of document.querySelectorAll(`[${HOST}]`)) {
        if (!live.has(host)) clear(host);
    }
    const registry = highlights();
    const HL = Highlight();
    if (registry && HL) {
        registry.set(MARKER_HL, new HL(...markers));
        registry.set(TEXT_HL, new HL(...texts));
    }
}

function clear(host: Element) {
    host.removeAttribute(HOST);
    host.querySelector(`:scope > [${LAYER}]`)?.remove();
}

const schedule = debounce(render, 150, 500);
let stopDom: (() => void) | null = null;
/** Text edited in place (an edited question) changes no child lists, so DomWatch misses it. */
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
    settings,
    start() {
        applyStyle();
        render();
        stopDom = onDomChange(mutations => {
            // our own bar layers changing must not trigger another pass
            if (mutations.every(m => (m.target as Element).hasAttribute?.(LAYER))) return;
            schedule();
        });
        textWatch = new MutationObserver(mutations => {
            if (mutations.some(m => m.target.parentElement?.closest(`[${USER_STEP}]`))) schedule();
        });
        textWatch.observe(document.documentElement, { characterData: true, subtree: true });
        window.addEventListener("resize", schedule);
    },
    stop() {
        stopDom?.();
        stopDom = null;
        textWatch?.disconnect();
        textWatch = null;
        schedule.cancel();
        window.removeEventListener("resize", schedule);
        for (const host of document.querySelectorAll(`[${HOST}]`)) clear(host);
        highlights()?.delete(MARKER_HL);
        highlights()?.delete(TEXT_HL);
        document.getElementById(STYLE_ID)?.remove();
    },
    onSettingsChange() {
        applyStyle();
    },
});
