/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
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

export const NAV_HOST_ID = "notionai-pp-navigator";
const RESCAN_MS = 250;
const RESCAN_MAX_MS = 1200;
const ACTIVE_RATIO = 0.4;
const SCROLL_OFFSET = 72;
const SETTLE_MS = 150;
const RAIL_MARGIN = 20;
const SIDE_PANELS = "[role='complementary'], aside";

export const settings = definePluginSettings({
    showAssistant: { type: "boolean", label: "目录显示 AI 回复 / Show AI replies", default: true },
    effect: {
        type: "select",
        label: "跳转定位效果 / Jump effect",
        default: "border",
        description: "选择后立即保存，点「预览」查看效果演示 / Saved on change; use Preview to see it",
        options: EFFECTS.map(effect => ({ value: effect.value, label: `${effect.zh} / ${effect.en}（${effect.hint}）` })),
    },
    preview: {
        type: "action",
        label: "预览当前效果 / Preview effect",
        button: "预览 / Preview",
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
}

function build() {
    if (!overlay) return;
    placeRail();
    const next = isAiRoute() ? visibleMessages(collectMessages()) : [];
    const nextSignature = next.map(m => `${m.id}\u0001${summarize(m.text)}`).join("\u0002");
    const sameElements = next.length === messages.length && next.every((m, i) => m.element === messages[i].element);
    messages = next;
    overlay.host.hidden = !next.length;
    if (nextSignature === signature) {
        if (!sameElements) updateActive();
        return;
    }
    signature = nextSignature;
    q(".head").textContent = t(`对话目录 · ${next.filter(m => m.role === "user").length} 问`, `Outline · ${next.filter(m => m.role === "user").length} prompts`);
    q(".lines").replaceChildren(...next.map(message => {
        const line = document.createElement("div");
        line.className = "line";
        line.dataset.id = message.id;
        line.dataset.role = message.role;
        return line;
    }));
    const labels = outlineLabels(next);
    q("ul").replaceChildren(...next.map((message, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "item";
        button.dataset.id = message.id;
        button.dataset.role = message.role;
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = message.role === "user" ? "❓" : "🤖";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = labels[index];
        button.title = summarize(message.text, 400);
        button.append(mark, label);
        button.addEventListener("click", () => jump(message.id));
        const item = document.createElement("li");
        item.append(button);
        return item;
    }));
    activeId = "";
    updateActive();
}

function setActive(id: string) {
    if (!overlay || id === activeId) return;
    activeId = id;
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
    title: "对话目录 / Chat navigator",
    description: "在 Notion AI 对话右侧显示 Notion 风格目录，悬停展开，点击跳到对应提问或回复。",
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
        cleanups = [
            onDomChange(onLayout),
            onDomChange(rescan),
            () => document.removeEventListener("transitionend", onLayout, { capture: true }),
            () => document.removeEventListener("animationend", onLayout, { capture: true }),
            () => {
                panelObserver?.disconnect();
                panelObserver = null;
                watchedPanels.clear();
            },
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
