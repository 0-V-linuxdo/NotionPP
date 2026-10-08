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
 * Like Void++'s composerOpacity: makes the AI composer's background see-through and frosted.
 * The box is the first element inside the composer container that paints Notion's
 * secondary background; color-mix keeps it right in both themes without reading colours.
 */

const STYLE_ID = "notionai-pp-composer-look";
const MARK = "data-npp-composer-box";
export const COMPOSER = "[data-notion-chat-input-container]";

export const settings = definePluginSettings({
    opacity: {
        type: "number",
        label: { zh: "背景不透明度（%）", en: "Background opacity (%)" },
        description: { zh: "100 为 Notion 原样", en: "100 is Notion's own look" },
        default: 70,
        min: 0,
        max: 100,
    },
    blur: {
        type: "number",
        label: { zh: "背景模糊（像素）", en: "Background blur (px)" },
        description: { zh: "只有输入框后面有内容时才看得出来", en: "Only visible where something sits behind the composer" },
        default: 8,
        min: 0,
        max: 30,
    },
});

/** The rounded box that paints the composer's background. */
export function composerBox(container: Element): HTMLElement | null {
    for (const node of [container, ...container.querySelectorAll("div")]) {
        if (node instanceof HTMLElement && /--c-bacSec/.test(node.style.backgroundColor)) return node;
    }
    return null;
}

function mark() {
    for (const container of document.querySelectorAll(COMPOSER)) {
        const box = composerBox(container);
        if (box && !box.hasAttribute(MARK)) box.setAttribute(MARK, "");
    }
}

export function css(opacity: number, blur: number) {
    const pct = Math.max(0, Math.min(100, Math.round(opacity)));
    const px = Math.max(0, Math.min(30, Math.round(blur)));
    const rules = [`background-color: color-mix(in srgb, var(--c-bacSec) ${pct}%, transparent) !important;`];
    if (px) rules.push(`backdrop-filter: blur(${px}px) saturate(1.2);`, `-webkit-backdrop-filter: blur(${px}px) saturate(1.2);`);
    return `[${MARK}] { ${rules.join(" ")} }`;
}

let stopDom: (() => void) | null = null;

function apply() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css(settings.store.opacity, settings.store.blur);
}

export default definePlugin({
    name: "composerLook",
    title: { zh: "输入框透明度", en: "Composer opacity" },
    description: {
        zh: "调节 AI 输入框背景的不透明度和模糊程度，让输入框更轻、和背景融为一体。",
        en: "Sets the opacity and blur of the AI composer's background, for a lighter composer that blends into the page.",
    },
    icon: Icons.droplet,
    tags: ["composer", "appearance"],
    enabledByDefault: false,
    settings,
    start() {
        apply();
        mark();
        stopDom = onDomChange(mark);
    },
    stop() {
        stopDom?.();
        stopDom = null;
        document.getElementById(STYLE_ID)?.remove();
        for (const node of document.querySelectorAll(`[${MARK}]`)) node.removeAttribute(MARK);
    },
    onSettingsChange() {
        apply();
    },
});
