/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { chatKey, openChat, sameChat } from "@api/Chats";
import { type EventMap, on } from "@api/Events";
import { definePlugin } from "@api/PluginManager";
import { currentChatId } from "@api/Reply";
import { onRouteChange } from "@api/Router";
import { definePluginSettings } from "@api/Settings";
import { watchStreams } from "@api/Streams";
import { dismissToast, showToast, toastKeys } from "@api/Toast";
import { Icons } from "@utils/icons";
import { t } from "@utils/page";

/*
 * Like Void++'s CompleteToast: when a chat you have left finishes its reply, a toast in the
 * bottom-right corner says so; click it to open that chat. Only replies that were really written
 * while you were away count: one card per chat, updated rather than stacked, and nothing for a
 * reply you stopped or one that was cut off.
 */

export const settings = definePluginSettings({
    keepUntilDismissed: {
        type: "boolean",
        label: { zh: "一直显示到手动关闭", en: "Keep until dismissed" },
        description: { zh: "不自动消失；点 × 或打开那个对话后才关闭", en: "Do not close on a timer; dismiss with × or by opening that chat" },
        default: false,
    },
    duration: {
        type: "number",
        label: { zh: "显示秒数", en: "Seconds shown" },
        description: { zh: "开启「一直显示」时不生效", en: "Ignored when Keep until dismissed is on" },
        default: 8,
        min: 3,
        max: 60,
    },
    errors: {
        type: "boolean",
        label: { zh: "回复出错时也提示", en: "Also when a reply fails" },
        default: true,
    },
});

const PREFIX = "chat-done:";
export const toastKey = (chatId: string) => `${PREFIX}${chatKey(chatId)}`;

/** Whether a finished stream deserves a toast: written while the user was on another chat. */
export function shouldToast(event: EventMap["streamEnd"], errors: boolean) {
    if (!event.elsewhere || event.stopped || !event.chatId) return false;
    if (event.status === "done") return true;
    return event.status === "error" && errors;
}

function announce(event: EventMap["streamEnd"]) {
    if (!shouldToast(event, settings.store.errors)) return;
    // The user may have come back while the stream was closing.
    if (sameChat(currentChatId(), event.chatId)) return;
    const failed = event.status === "error";
    const title = event.title || t("Notion AI 对话", "Notion AI chat");
    showToast({
        key: toastKey(event.chatId),
        kind: failed ? "error" : "success",
        title,
        body: failed ? t("回复出错，点击打开对话查看", "The reply failed. Click to open the chat") : t("回复已完成，点击打开对话", "Reply finished. Click to open the chat"),
        duration: settings.store.keepUntilDismissed ? 0 : settings.store.duration * 1000,
        onClick: () => openChat(event.chatId),
    });
}

/** Opening the chat a toast is about is as good as clicking it. */
function dismissOpened() {
    const current = currentChatId();
    if (current) dismissToast(toastKey(current));
}

let cleanups: (() => void)[] = [];

export default definePlugin({
    name: "chatDoneToast",
    title: { zh: "其他对话完成提示", en: "Other chat finished toast" },
    description: {
        zh: "切到别的对话后，原来那个对话写完回复时，右下角弹出提示，点击直接打开它。",
        en: "When a chat you left finishes its reply, a toast in the bottom-right corner says so; click it to open that chat.",
    },
    icon: Icons.checkCircle,
    tags: ["chat"],
    enabledByDefault: true,
    updatedAt: "2026-10-24",
    settings,
    start() {
        cleanups = [watchStreams(), on("streamEnd", announce), onRouteChange(dismissOpened)];
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const key of toastKeys()) if (key.startsWith(PREFIX)) dismissToast(key);
    },
});
