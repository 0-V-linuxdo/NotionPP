/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";

import { USER_STEP } from "../navigator/messages";

/*
 * Notion AI caps its chat column with an inline max-width (798px, the composer 56px less).
 * Like Void++'s widerChat, this raises both caps to a width of your choosing.
 */

const STYLE_ID = "notionai-pp-wider-chat";
const MARK = "data-npp-chat-column";
const COMPOSER = "[data-notion-chat-input-container]";
/** The composer sits this much narrower than the message column in Notion's own layout. */
const COMPOSER_INSET = 56;

export const settings = definePluginSettings({
    width: {
        type: "number",
        label: { zh: "对话最大宽度（像素）", en: "Maximum chat width (px)" },
        description: { zh: "Notion 默认 798", en: "Notion's default is 798" },
        default: 1100,
        min: 600,
        max: 2400,
    },
});

let stopDom: (() => void) | null = null;

/** The nearest ancestor of a message that carries Notion's inline column cap. */
export function columnOf(step: Element): HTMLElement | null {
    for (let node = step.parentElement; node && node !== document.body; node = node.parentElement) {
        const cap = node.style.maxWidth;
        if (cap && cap.endsWith("px")) return node;
    }
    return null;
}

function mark() {
    const step = document.querySelector(`[${USER_STEP}]`);
    const column = step ? columnOf(step) : null;
    if (column && !column.hasAttribute(MARK)) {
        for (const old of document.querySelectorAll(`[${MARK}]`)) old.removeAttribute(MARK);
        column.setAttribute(MARK, "");
    }
}

export function css(width: number) {
    return `[${MARK}] { max-width: ${width}px !important; }
${COMPOSER} { max-width: ${width - COMPOSER_INSET}px !important; }`;
}

function apply() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css(settings.store.width);
}

export default definePlugin({
    name: "widerChat",
    title: { zh: "对话宽度", en: "Wider chat" },
    description: {
        zh: "调节 Notion AI 对话区和输入框的最大宽度，适合大屏。",
        en: "Sets the maximum width of the Notion AI chat and composer, for large screens.",
    },
    icon: Icons.width,
    tags: ["appearance"],
    enabledByDefault: true,
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
