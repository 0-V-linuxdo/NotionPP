/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { definePlugin } from "@api/PluginManager";
import { currentChatId } from "@api/Reply";
import { onRouteChange } from "@api/Router";
import { Icons } from "@utils/icons";

/*
 * Notion AI opens a panel on the right of a chat (Skills, details). This closes it each time
 * a chat is opened, so the conversation gets the full width. Opening it again by hand is
 * respected until you move to another chat.
 */

export const PANEL_TOGGLE = "[data-testid='agent-chat-side-panel-toggle']";
const OPEN_LABEL = /minimi[sz]e|collapse|close|hide|收起|隐藏|关闭|最小化/i;
const STEP = "[data-agent-chat-user-step-id]";

/** Whether the panel the toggle controls is open now. */
export function panelOpen(toggle: Element): boolean {
    const expanded = toggle.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") return expanded === "true";
    const pressed = toggle.getAttribute("aria-pressed");
    if (pressed === "true" || pressed === "false") return pressed === "true";
    return OPEN_LABEL.test(`${toggle.getAttribute("aria-label") ?? ""} ${toggle.getAttribute("title") ?? ""}`);
}

/** Chats whose panel we already closed once; after that the panel is the reader's to open. */
let handled = new Set<string>();
let cleanups: (() => void)[] = [];

function check() {
    const chat = currentChatId() || location.pathname;
    if (handled.has(chat)) return;
    const toggle = document.querySelector<HTMLElement>(PANEL_TOGGLE);
    // Wait for the chat itself, so the click lands on this chat's panel and not a loading one.
    if (!toggle || !document.querySelector(STEP)) return;
    handled.add(chat);
    if (panelOpen(toggle)) toggle.click();
}

export default definePlugin({
    name: "autoHidePanel",
    title: { zh: "自动隐藏右侧栏", en: "Auto-hide the side panel" },
    description: {
        zh: "打开 Notion AI 对话时，自动收起右侧的面板（Skills、详情），让对话占满宽度。在这个对话里手动再打开，不会被再次收起。",
        en: "Closes the panel on the right of a Notion AI chat (Skills, details) when the chat opens, so the conversation gets the full width. Reopen it by hand and it stays open in that chat.",
    },
    icon: Icons.panelRight,
    tags: ["chat", "appearance"],
    enabledByDefault: true,
    updatedAt: "2026-10-10",
    start() {
        handled = new Set();
        cleanups = [onDomChange(check), onRouteChange(check)];
        check();
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
    },
});
