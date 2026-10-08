/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { definePlugin } from "@api/PluginManager";
import { onRouteChange } from "@api/Router";
import { definePluginSettings } from "@api/Settings";

import { tr } from "./lang";
import { closeManager, openManager } from "./manager";
import { escapeCssContent, loadGreetings, loadIndex, pickIndex, saveIndex } from "./store";
import { clearMarks, isHomePath, syncMark, TARGET_SELECTOR } from "./target";
import { Icons } from "@utils/icons";

declare const GM_registerMenuCommand: ((name: string, fn: () => void) => unknown) | undefined;

/*
 * Replaces the greeting on the Notion AI home page (/ai) with the user's own
 * lines. The text is painted with CSS (::after on the marked greeting) so React
 * keeps owning the real node; the face and its accessory are left alone.
 * Rotation: on each entry to the home page, on a timer while it is open, or on
 * click. Double right-click on the greeting opens the manager.
 */

export const STYLE_ID = "notionai-pp-greeting-style";
const RIGHT_DOUBLE_MS = 400;

export const settings = definePluginSettings({
    manage: {
        type: "action",
        label: { zh: "问候语列表", en: "Greetings" },
        description: { zh: "添加、修改或删除问候语", en: "Add, edit or delete greetings" },
        button: { zh: "管理…", en: "Manage…" },
        run: () => openGreetingManager(),
    },
    mode: {
        type: "select",
        label: { zh: "轮播方式", en: "Rotation" },
        description: { zh: "定时切换在离开首页时会暂停", en: "The timer pauses while you are away from home" },
        default: "refresh",
        options: [
            { value: "refresh", label: { zh: "刷新或进入首页时", en: "On refresh or visit" } },
            { value: "interval", label: { zh: "按时间间隔", en: "On a timer" } },
            { value: "manual", label: { zh: "点击问候语时", en: "On click" } },
        ],
    },
    order: {
        type: "select",
        label: { zh: "轮播顺序", en: "Order" },
        default: "sequential",
        options: [
            { value: "sequential", label: { zh: "顺序循环", en: "Sequential" } },
            { value: "random", label: { zh: "随机", en: "Random" } },
        ],
    },
    intervalSec: {
        type: "number",
        label: { zh: "切换间隔（秒）", en: "Interval in seconds" },
        description: { zh: "仅在按时间间隔切换时生效", en: "Only used when switching on a timer" },
        default: 10,
        min: 1,
        max: 3600,
    },
});

let stopDom: (() => void) | null = null;
let stopRoute: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let wasHome = false;
let lastRightClick = 0;
let menuRegistered = false;
let running = false;

function upsertStyle(css: string) {
    let style = document.getElementById(STYLE_ID);
    if (style?.textContent === css) return;
    if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css;
}

export function buildCss(text: string, clickable: boolean) {
    const sel = TARGET_SELECTOR;
    return `
${sel} { font-size: 0 !important; line-height: 0 !important; text-align: center !important; }
${sel} > * { display: none !important; }
${sel}::after { content: "${escapeCssContent(text)}"; display: block !important; visibility: visible !important;
  font-size: 1.5rem !important; line-height: 1.35 !important; font-weight: 600 !important; color: currentColor !important;
  white-space: pre-wrap !important; text-align: center !important; width: 100% !important; margin: 0 auto !important; padding: 0 !important; }
${clickable ? `${sel} { cursor: pointer !important; user-select: none !important; }` : ""}
@media (max-width: 768px) { ${sel}::after { font-size: 1.25rem !important; line-height: 1.3 !important; } }
`;
}

/** Paints the current greeting, moving to the next one first when `advance` is set. */
export function apply(advance = false) {
    const greetings = loadGreetings();
    const current = loadIndex();
    const index = pickIndex(greetings.length, settings.store.order, current, advance);
    if (index !== current) saveIndex(index);
    const clickable = settings.store.mode === "manual" && greetings.length > 1;
    upsertStyle(buildCss(greetings[index] ?? greetings[0], clickable));
    syncTitle();
}

function syncTitle() {
    const target = document.querySelector<HTMLElement>(TARGET_SELECTOR);
    if (!target) return;
    const want = settings.store.mode === "manual" && loadGreetings().length > 1 ? tr("clickHint") : null;
    if (want) target.title = want;
    else target.removeAttribute("title");
}

function syncTimer() {
    const want = running && settings.store.mode === "interval" && isHomePath() && loadGreetings().length > 1;
    if (!want) {
        if (timer) clearInterval(timer);
        timer = null;
        return;
    }
    if (timer) return;
    timer = setInterval(() => apply(true), settings.store.intervalSec * 1000);
}

function restartTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    syncTimer();
}

/** Route or DOM changed: mark the greeting, and count an entry to the home page as a "refresh". */
function check() {
    const home = isHomePath();
    const marked = syncMark();
    if (home && !wasHome) apply(settings.store.mode === "refresh");
    else if (marked) syncTitle();
    wasHome = home;
    syncTimer();
}

const targetOf = (event: Event) => (event.target as Element | null)?.closest?.(TARGET_SELECTOR) ?? null;

function onClick(event: MouseEvent) {
    if (event.button !== 0 || !targetOf(event)) return;
    if (settings.store.mode !== "manual" || loadGreetings().length <= 1) return;
    if (String(window.getSelection?.() ?? "").trim()) return;
    apply(true);
}

function onContextMenu(event: MouseEvent) {
    if (!targetOf(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - lastRightClick <= RIGHT_DOUBLE_MS) {
        lastRightClick = 0;
        openGreetingManager();
    } else {
        lastRightClick = now;
    }
}

export function openGreetingManager() {
    openManager({
        get: () => ({ mode: settings.store.mode, order: settings.store.order, intervalSec: settings.store.intervalSec }),
        set: (key, value) => void ((settings.store as Record<string, unknown>)[key] = value),
    }, loadIndex);
}

export default definePlugin({
    name: "GreetingCustomizer",
    title: { zh: "自定义问候语", en: "Custom greetings" },
    description: {
        zh: "把 Notion AI 首页的问候语换成你自己的文案：多条管理，顺序或随机轮播，刷新、定时或点击切换。在首页双击右键问候语可打开管理面板。",
        en: "Replaces the Notion AI home greeting with your own lines, shown in order or at random, switched on refresh, on a timer or by click. Double right-click the greeting to manage them.",
    },
    icon: Icons.smile,
    tags: ["home", "appearance"],
    enabledByDefault: true,
    settings,

    start() {
        running = true;
        wasHome = false;
        lastRightClick = 0;
        document.addEventListener("click", onClick, true);
        document.addEventListener("contextmenu", onContextMenu, true);
        stopDom = onDomChange(check);
        stopRoute = onRouteChange(check);
        if (!menuRegistered && typeof GM_registerMenuCommand === "function") {
            menuRegistered = true;
            try {
                GM_registerMenuCommand(tr("menu"), () => openGreetingManager());
            } catch {}
        }
        check();
    },

    stop() {
        running = false;
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("contextmenu", onContextMenu, true);
        stopDom?.();
        stopRoute?.();
        stopDom = stopRoute = null;
        syncTimer();
        clearMarks();
        document.getElementById(STYLE_ID)?.remove();
        closeManager();
    },

    onSettingsChange(key) {
        if (key === "index") return apply(false);
        apply(false);
        restartTimer();
    },
});
