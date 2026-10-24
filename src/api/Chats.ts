/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { currentChatId } from "@api/Reply";
import { pageWindow } from "@utils/page";

/*
 * Chat ids show up in two spellings: the `t` query parameter (32 hex digits) and the dashed
 * UUID Notion's API uses. Compare them by their hex digits only.
 */
export const chatKey = (id: string) => id.replace(/-/g, "").toLowerCase();

export const sameChat = (a: string, b: string) => !!a && !!b && chatKey(a) === chatKey(b);

/** The URL that opens a chat: the current page with its `t` parameter swapped. */
export function chatUrl(chatId: string, href = location.href): string {
    const url = new URL(href);
    url.searchParams.set("t", chatId);
    return url.toString();
}

const hasMessages = () => !!document.querySelector("[data-agent-chat-user-step-id]");

/** Opens another chat the way Notion's own links do, without reloading the page; falls back to a plain load. */
export function openChat(chatId: string) {
    if (!chatId || sameChat(currentChatId(), chatId)) return;
    const url = chatUrl(chatId);
    pageWindow.history.pushState(pageWindow.history.state, "", url);
    pageWindow.dispatchEvent(new PopStateEvent("popstate", { state: pageWindow.history.state }));
    // Notion's router did not pick the change up: load the chat the plain way.
    window.setTimeout(() => {
        if (sameChat(currentChatId(), chatId) && !hasMessages()) pageWindow.location.assign(url);
    }, 2500);
}
