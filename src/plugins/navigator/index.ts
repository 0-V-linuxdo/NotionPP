/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { on } from "@api/Events";
import { currentChatId, replyState, watchReplies } from "@api/Reply";
import { createOverlay, type Overlay } from "@api/Overlay";
import { definePlugin } from "@api/PluginManager";
import { onRouteChange } from "@api/Router";
import { definePluginSettings } from "@api/Settings";
import { scrollParentOf, viewport, visibleBox } from "@utils/dom";
import { isAiRoute, t } from "@utils/page";
import { debounce, frameThrottle } from "@utils/time";

import { EFFECTS, type Effect, playEffect, previewEffect } from "./effects";
import { type ChatMessage, collectMessages, outlineLabels, summarize } from "./messages";
import { NAV_CSS, NAV_HTML } from "./styles";
import { Icons } from "@utils/icons";

import { starsActive, starsOf } from "../messageStars/store";

export const NAV_HOST_ID = "notionai-pp-navigator";
const RESCAN_MS = 250;
const RESCAN_MAX_MS = 1200;
const ACTIVE_RATIO = 0.4;
const SCROLL_OFFSET = 72;
const SETTLE_MS = 150;
const RAIL_MARGIN = 20;
const SIDE_PANELS = "[role='complementary'], aside";
const COMPOSER = "[data-notion-chat-input-container]";
const SPAN_GAP = 12;
const MIN_SPAN = 120;

export const settings = definePluginSettings({
    showAssistant: { type: "boolean", label: { zh: "目录显示 AI 回复", en: "Show AI replies" }, default: true },
    keyboard: {
        type: "boolean",
        label: { zh: "键盘快捷键", en: "Keyboard shortcuts" },
        description: {
            zh: "焦点不在输入框时：↑/↓ 上一条或下一条消息，Home/End 第一条或最后一条，⌘/Ctrl+↑/↓ 对话顶部或底部，Esc 收起目录",
            en: "When not typing: ↑/↓ previous or next message, Home/End first or last, ⌘/Ctrl+↑/↓ top or bottom of the chat, Esc closes the outline",
        },
        default: true,
    },
    effect: {
        type: "select",
        label: { zh: "跳转定位效果", en: "Jump effect" },
        default: "border",
        description: { zh: "跳转到消息后用什么方式标出它", en: "How a message is marked after jumping to it" },
        options: EFFECTS.map(effect => ({ value: effect.value, label: { zh: effect.zh, en: effect.en } })),
    },
    preview: {
        type: "action",
        label: { zh: "预览效果", en: "Preview effect" },
        button: { zh: "预览", en: "Preview" },
        run: () => previewEffect(settings.store.effect as Effect),
    },
});

let overlay: Overlay | null = null;
let messages: ChatMessage[] = [];
let signature = "";
let activeId = "";
let cleanups: (() => void)[] = [];
let panelObserver: ResizeObserver | null = null;
const watchedPanels = new Set<Element>();

const q = <T extends Element = HTMLElement>(selector: string) => overlay!.root.querySelector(selector) as T;

function visibleMessages(all: ChatMessage[]) {
    return settings.store.showAssistant ? all : all.filter(message => message.role === "user");
}

/** Keeps the rail clear of Notion's right-hand panels (agent details, comments, page peek). */
export function placeRail() {
    if (!overlay) return;
    const { width } = viewport();
    let right = RAIL_MARGIN;
    for (const panel of [...watchedPanels]) if (!panel.isConnected) {
        panelObserver?.unobserve(panel);
        watchedPanels.delete(panel);
    }
    for (const panel of document.querySelectorAll(SIDE_PANELS)) {
        if (overlay.host.contains(panel)) continue;
        // Panels open and close with a width animation that adds no DOM nodes; follow their size.
        if (panelObserver && !watchedPanels.has(panel)) {
            watchedPanels.add(panel);
            panelObserver.observe(panel);
        }
        const box = visibleBox(panel);
        if (!box || box.left < width / 2 || box.right < width - 80 || box.height < 120) continue;
        right = Math.max(right, Math.round(width - box.left + RAIL_MARGIN));
    }
    overlay.host.style.setProperty("--nav-right", `${right}px`);
    const span = railSpan();
    if (span) {
        overlay.host.style.setProperty("--nav-top", `${span.top}px`);
        overlay.host.style.setProperty("--nav-height", `${span.height}px`);
    }
}

/**
 * The strip the rail is centered in, as Void++ does: from the top of the chat's scroll pane to
 * the top of the composer, so the rail sits mid-conversation rather than near the bottom.
 */
export function railSpan() {
    const first = messages.find(m => m.element.isConnected)?.element;
    if (!first) return null;
    const { height } = viewport();
    const pane = scrollParentOf(first);
    const isRoot = pane === document.scrollingElement || pane === document.documentElement;
    const paneBox = isRoot ? { top: 0, bottom: height } : pane.getBoundingClientRect();
    const composer = document.querySelector(COMPOSER)?.getBoundingClientRect();
    const top = Math.max(0, paneBox.top) + SPAN_GAP;
    const bottom = Math.min(paneBox.bottom, composer && composer.height ? composer.top : height) - SPAN_GAP;
    return bottom - top >= MIN_SPAN ? { top: Math.round(top), height: Math.round(bottom - top) } : { top: Math.round(top), height: MIN_SPAN };
}

/**
 * Like Void++'s dashed tick: while Notion AI writes, its reply is marked as in progress. Before
 * the reply has any text, a placeholder stands in for it after the last prompt.
 */
export function streamingState(list: ChatMessage[], streaming = replyState() === "streaming") {
    if (!streaming || !settings.store.showAssistant) return { id: "", pending: false };
    const last = list[list.length - 1];
    if (last?.role === "assistant") return { id: last.id, pending: false };
    return { id: "", pending: true };
}

function pendingLine() {
    const line = document.createElement("div");
    line.className = "line streaming pending";
    line.dataset.role = "assistant";
    return line;
}

const liveTag = () => {
    const tag = document.createElement("span");
    tag.className = "live";
    tag.textContent = t("生成中", "Writing");
    return tag;
};

function pendingItem() {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "item pending";
    row.dataset.role = "assistant";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "🤖";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = t("正在回复…", "Writing a reply…");
    row.append(mark, label, liveTag());
    item.append(row);
    return item;
}

const TYPING = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']";

function isTyping(node: EventTarget | Element | null) {
    return node instanceof Element && !!node.closest(TYPING);
}

/** Notion menus, dialogs and our own panels keep their arrow keys. */
function keysBelongElsewhere(event: KeyboardEvent) {
    const active = document.activeElement;
    if (isTyping(event.target) || isTyping(active)) return true;
    if (active instanceof HTMLElement && active.id.startsWith("notionai-pp-") && active !== overlay?.host) return true;
    return !!document.querySelector("[role='dialog'][aria-modal='true'], [role='menu'], [role='listbox']");
}

/** Like Void++'s navigator keys: step through messages, jump to the ends, or close the outline. */
function onKeyDown(event: KeyboardEvent) {
    if (!settings.store.keyboard || !overlay || overlay.host.hidden || !messages.length || !isAiRoute()) return;
    if (event.defaultPrevented || event.altKey || event.shiftKey) return;
    if (event.key === "Escape") {
        if (!overlay.host.matches(":focus-within")) return;
        (overlay.root.activeElement as HTMLElement | null)?.blur();
        event.preventDefault();
        return;
    }
    const arrow = event.key === "ArrowUp" || event.key === "ArrowDown";
    const edge = event.key === "Home" || event.key === "End";
    if (!arrow && !edge) return;
    if (keysBelongElsewhere(event)) return;
    const up = event.key === "ArrowUp" || event.key === "Home";
    if (arrow && (event.metaKey || event.ctrlKey)) scrollToEdge(up);
    else if (event.metaKey || event.ctrlKey) return;
    else if (edge) jump(up ? messages[0].id : messages[messages.length - 1].id);
    else {
        const index = Math.max(0, messages.findIndex(m => m.id === activeId));
        const next = messages[Math.min(messages.length - 1, Math.max(0, index + (up ? -1 : 1)))];
        jump(next.id);
    }
    event.preventDefault();
    event.stopPropagation();
}

function scrollToEdge(top: boolean) {
    const first = messages.find(m => m.element.isConnected)?.element;
    if (!first) return;
    const scroller = scrollParentOf(first);
    scroller.scrollTo({ top: top ? 0 : scroller.scrollHeight, behavior: "smooth" });
}

function build() {
    if (!overlay) return;
    const next = isAiRoute() ? visibleMessages(collectMessages()) : [];
    const stars = starsActive() ? starsOf(currentChatId()) : new Set<string>();
    const live = streamingState(next);
    const nextSignature = next.map(m => `${m.id}\u0001${summarize(m.text)}\u0001${stars.has(m.id) ? 1 : 0}`).join("\u0002") + `\u0003${live.id}\u0003${live.pending ? 1 : 0}`;
    const sameElements = next.length === messages.length && next.every((m, i) => m.element === messages[i].element);
    messages = next;
    overlay.host.hidden = !next.length && !live.pending;
    placeRail();
    if (nextSignature === signature) {
        if (!sameElements) updateActive();
        return;
    }
    signature = nextSignature;
    q(".lines").replaceChildren(...next.map(message => {
        const line = document.createElement("div");
        line.className = "line";
        line.dataset.id = message.id;
        line.dataset.role = message.role;
        line.classList.toggle("starred", stars.has(message.id));
        line.classList.toggle("streaming", message.id === live.id);
        return line;
    }), ...(live.pending ? [pendingLine()] : []));
    const labels = outlineLabels(next);
    q("ul").replaceChildren(...next.map((message, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "item";
        button.dataset.id = message.id;
        button.dataset.role = message.role;
        button.classList.toggle("starred", stars.has(message.id));
        button.classList.toggle("streaming", message.id === live.id);
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = stars.has(message.id) ? "⭐" : message.role === "user" ? "❓" : "🤖";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = summarize(message.text);
        // Only when the whole prompt doesn't fit: show where it differs from an earlier one.
        if (labels[index] !== label.textContent) label.dataset.compact = labels[index];
        button.title = summarize(message.text, 400);
        button.append(mark, label);
        if (message.id === live.id) button.append(liveTag());
        button.addEventListener("click", () => jump(message.id));
        const item = document.createElement("li");
        item.append(button);
        return item;
    }), ...(live.pending ? [pendingItem()] : []));
    compactOverflowing();
    activeId = "";
    updateActive();
}

/** Labels cut off by the menu's width switch to their compact form, so the differing tail stays visible. */
function compactOverflowing() {
    if (!overlay) return;
    for (const label of overlay.root.querySelectorAll<HTMLElement>(".label[data-compact]")) {
        if (label.scrollWidth > label.clientWidth + 1) label.textContent = label.dataset.compact!;
    }
}

/** Like Void++'s menu meta: where you are in the outline, "3 / 12". */
function updateHead() {
    if (!overlay) return;
    const index = Math.max(0, messages.findIndex(m => m.id === activeId));
    q(".head").textContent = `${Math.min(index + 1, Math.max(messages.length, 1))} / ${messages.length}`;
}

function setActive(id: string) {
    if (!overlay || id === activeId) return;
    activeId = id;
    updateHead();
    for (const node of overlay.root.querySelectorAll<HTMLElement>("[data-id]")) node.classList.toggle("active", node.dataset.id === id);
    const lines = q(".lines");
    const rail = q(".rail");
    const line = lines.querySelector<HTMLElement>(".line.active");
    if (!line) return;
    const overflow = lines.scrollHeight - rail.clientHeight;
    const offset = overflow > 0 ? Math.min(overflow, Math.max(0, line.offsetTop - rail.clientHeight / 2)) : 0;
    lines.style.transform = `translateY(${-offset}px)`;
    const item = overlay.root.querySelector<HTMLElement>(`button.item.active`);
    item?.scrollIntoView({ block: "nearest" });
}

function updateActive() {
    if (!messages.length) return;
    const threshold = window.innerHeight * ACTIVE_RATIO;
    let current = messages[0].id;
    for (const message of messages) {
        if (!message.element.isConnected) continue;
        if (message.element.getBoundingClientRect().top < threshold) current = message.id;
        else break;
    }
    setActive(current);
}

/** For the starred list: jump with the navigator's scroll and effect while it is running. */
export function jumpTo(id: string): boolean {
    if (!overlay || !messages.some(m => m.id === id && m.element.isConnected)) return false;
    jump(id);
    return true;
}

function jump(id: string) {
    const message = messages.find(m => m.id === id);
    if (!message?.element.isConnected) return;
    const target = message.element;
    const scroller = scrollParentOf(target);
    const isRoot = scroller === document.scrollingElement || scroller === document.documentElement;
    const top = target.getBoundingClientRect().top - (isRoot ? 0 : scroller.getBoundingClientRect().top) + scroller.scrollTop - SCROLL_OFFSET;
    setActive(id);
    let timer = 0;
    const settle = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
            (isRoot ? window : scroller).removeEventListener("scroll", settle);
            playEffect(target, settings.store.effect as Effect);
        }, SETTLE_MS);
    };
    (isRoot ? window : scroller).addEventListener("scroll", settle, { passive: true });
    scroller.scrollTo({ top, behavior: "smooth" });
    settle();
}

export default definePlugin({
    name: "chatNavigator",
    title: { zh: "对话目录", en: "Chat navigator" },
    description: {
        zh: "在 Notion AI 对话右侧显示 Notion 风格目录，悬停展开，点击跳到对应提问或回复。",
        en: "Shows a Notion-style outline beside Notion AI chats. Hover to expand it and click to jump to a prompt or reply.",
    },
    icon: Icons.list,
    tags: ["chat"],
    enabledByDefault: true,
    settings,
    start() {
        overlay = createOverlay(NAV_HOST_ID, NAV_CSS, NAV_HTML);
        overlay.host.hidden = true;
        const rescan = debounce(build, RESCAN_MS, RESCAN_MAX_MS);
        const onScroll = frameThrottle(updateActive);
        window.addEventListener("scroll", onScroll, { capture: true, passive: true });
        const onResize = frameThrottle(() => {
            placeRail();
            updateActive();
        });
        window.addEventListener("resize", onResize, { passive: true });
        // Side panels open and close well before the debounced rescan; place the rail on the next frame.
        const onLayout = frameThrottle(placeRail);
        if (typeof ResizeObserver === "function") {
            panelObserver = new ResizeObserver(onLayout);
            panelObserver.observe(document.documentElement);
        }
        document.addEventListener("transitionend", onLayout, { capture: true, passive: true });
        document.addEventListener("animationend", onLayout, { capture: true, passive: true });
        document.addEventListener("keydown", onKeyDown, true);
        cleanups = [
            watchReplies(),
            on("replyStart", () => build()),
            on("replyEnd", () => build()),
            () => document.removeEventListener("keydown", onKeyDown, true),
            onDomChange(onLayout),
            onDomChange(rescan),
            () => document.removeEventListener("transitionend", onLayout, { capture: true }),
            () => document.removeEventListener("animationend", onLayout, { capture: true }),
            () => {
                panelObserver?.disconnect();
                panelObserver = null;
                watchedPanels.clear();
            },
            on("starsChanged", () => {
                signature = "";
                build();
            }),
            onRouteChange(() => {
                signature = "";
                rescan();
            }),
            () => rescan.cancel(),
            () => window.removeEventListener("scroll", onScroll, { capture: true }),
            () => window.removeEventListener("resize", onResize),
        ];
        build();
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        overlay?.destroy();
        overlay = null;
        messages = [];
        signature = "";
        activeId = "";
    },
    onSettingsChange() {
        signature = "";
        build();
    },
});
