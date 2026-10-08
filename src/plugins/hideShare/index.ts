/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";

/*
 * Like Void++'s noShareLink: hides the Share button in the top-right of Notion AI chats, and
 * optionally the Share button on ordinary pages. Plain CSS keyed on Notion's own test ids and
 * class, so it holds across in-app navigation and leaves the rest of the top bar alone.
 */

const STYLE_ID = "notionai-pp-hide-share";
export const CHAT_SHARE = "[data-testid='share-chat-button']";
export const PAGE_SHARE = ".notion-topbar-share-menu";

export const settings = definePluginSettings({
    pages: {
        type: "boolean",
        label: { zh: "同时隐藏页面的分享按钮", en: "Also hide Share on pages" },
        description: { zh: "普通 Notion 页面右上角的「分享」按钮", en: "The Share button at the top right of ordinary Notion pages" },
        default: false,
    },
});

export function css(pages: boolean) {
    const selectors = [CHAT_SHARE, ...(pages ? [PAGE_SHARE] : [])];
    return `${selectors.join(", ")} { display: none !important; }`;
}

function apply() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css(settings.store.pages);
}

export default definePlugin({
    name: "hideShare",
    title: { zh: "隐藏分享按钮", en: "Hide Share button" },
    description: {
        zh: "隐藏 Notion AI 对话右上角的分享按钮，避免误点把对话分享出去。也可以顺带隐藏普通页面的分享按钮。",
        en: "Hides the Share button at the top right of Notion AI chats so a chat is not shared by accident. Can also hide Share on ordinary pages.",
    },
    icon: Icons.shareOff,
    tags: ["appearance"],
    enabledByDefault: true,
    settings,
    start() {
        apply();
    },
    stop() {
        document.getElementById(STYLE_ID)?.remove();
    },
    onSettingsChange() {
        apply();
    },
});
