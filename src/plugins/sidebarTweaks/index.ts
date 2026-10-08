/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";

/*
 * Like Void++'s betterSidebar: a click on an empty part of the left sidebar collapses it, a click
 * on the empty part of the peeking sidebar pins it open again, and the sidebar can start out
 * collapsed. Both go through Notion's own buttons, so Notion keeps its usual animation and memory.
 * The section header buttons (Agents / Chats) are already hover-only in Notion, so nothing to do there.
 */

export const SIDEBAR = "nav.notion-sidebar-container";
const CLOSE = "[role='button'][aria-label='Close sidebar'], [role='button']:has(> svg.sidebarLeft)";
const LOCK = "[role='button'][aria-label='Lock sidebar open'], [role='button']:has(> svg.menu)";
const INTERACTIVE = "a, button, input, textarea, select, label, [contenteditable=''], [contenteditable='true'], "
    + "[role='button'], [role='link'], [role='menuitem'], [role='treeitem'], [role='option'], [role='tab'], [role='checkbox'], [role='switch'], [draggable='true']";
const ACTIVE_CURSORS = new Set(["pointer", "text", "col-resize", "ew-resize", "row-resize", "grab", "grabbing", "move"]);
/** Clicks this close to a row still count as aimed at it. */
const SLOP = 6;

export const settings = definePluginSettings({
    clickToToggle: {
        type: "boolean",
        label: { zh: "点击侧栏空白处收起/固定", en: "Click empty sidebar space to toggle" },
        description: { zh: "点侧栏里没有按钮的地方收起侧栏；收起后悬停弹出的侧栏，点空白处可重新固定", en: "Click a blank part of the sidebar to collapse it; click a blank part of the hover sidebar to pin it open again" },
        default: true,
    },
    defaultCollapsed: {
        type: "boolean",
        label: { zh: "打开页面时收起侧栏", en: "Start with the sidebar collapsed" },
        default: false,
    },
});

/** True when the element, or anything between it and the sidebar, is something you can click or type in. */
export function isActive(el: Element | null, sidebar: Element) {
    for (let node = el; node && node !== sidebar.parentElement; node = node.parentElement) {
        if (node.matches(INTERACTIVE)) return true;
        if (node !== sidebar && ACTIVE_CURSORS.has(getComputedStyle(node).cursor)) return true;
    }
    return false;
}

export function sidebarButton(sidebar: Element) {
    return sidebar.querySelector<HTMLElement>(CLOSE) ?? document.querySelector<HTMLElement>(LOCK);
}

function onScrollbar(el: Element, x: number) {
    for (let node: Element | null = el; node; node = node.parentElement) {
        if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight && node.offsetWidth > node.clientWidth) {
            const rect = node.getBoundingClientRect();
            if (x > rect.left + node.clientLeft + node.clientWidth) return true;
        }
    }
    return false;
}

export function shouldToggle(event: MouseEvent, sidebar: Element) {
    if (event.button !== 0 || event.detail > 1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !sidebar.contains(target) || isActive(target, sidebar)) return false;
    if (String(window.getSelection?.() ?? "").trim()) return false;
    if (onScrollbar(target, event.clientX)) return false;
    for (const dy of [-SLOP, SLOP]) {
        const near = document.elementFromPoint?.(event.clientX, event.clientY + dy);
        if (near && sidebar.contains(near) && isActive(near, sidebar)) return false;
    }
    return true;
}

function onClick(event: MouseEvent) {
    if (!settings.store.clickToToggle) return;
    const target = event.target instanceof Element ? event.target : null;
    const sidebar = target?.closest(SIDEBAR);
    if (!sidebar || !shouldToggle(event, sidebar)) return;
    const button = sidebarButton(sidebar);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    button.click();
}

let stopWait: (() => void) | null = null;
let collapsedOnce = false;

function collapseOnLoad() {
    if (collapsedOnce || !settings.store.defaultCollapsed) return;
    const attempt = () => {
        const sidebar = document.querySelector(SIDEBAR);
        const close = sidebar?.querySelector<HTMLElement>(CLOSE);
        if (!sidebar) return false;
        collapsedOnce = true;
        if (close && sidebar.getBoundingClientRect().width > 0) close.click();
        return true;
    };
    if (attempt()) return;
    const stop = onDomChange(() => {
        if (attempt()) done();
    });
    const timer = setTimeout(() => done(), 20_000);
    const done = () => {
        stop();
        clearTimeout(timer);
        stopWait = null;
    };
    stopWait = done;
}

export default definePlugin({
    name: "sidebarTweaks",
    title: { zh: "侧栏增强", en: "Sidebar tweaks" },
    description: {
        zh: "点击侧栏空白处收起侧栏、点悬停侧栏的空白处重新固定；可设置打开页面时侧栏默认收起。",
        en: "Click a blank part of the sidebar to collapse it, or of the hover sidebar to pin it again. Can start with the sidebar collapsed.",
    },
    icon: Icons.sidebar,
    tags: ["appearance"],
    enabledByDefault: true,
    settings,
    start() {
        document.addEventListener("click", onClick, true);
        collapseOnLoad();
    },
    stop() {
        document.removeEventListener("click", onClick, true);
        stopWait?.();
    },
});
