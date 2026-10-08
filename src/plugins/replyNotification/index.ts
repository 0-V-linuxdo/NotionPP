/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { on, type ReplyEvent } from "@api/Events";
import { definePlugin } from "@api/PluginManager";
import { watchReplies } from "@api/Reply";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";
import { pageWindow, t } from "@utils/page";

import { collectMessages, summarize } from "../navigator/messages";

export const settings = definePluginSettings({
    sound: {
        type: "boolean",
        label: { zh: "播放提示音", en: "Play a sound" },
        default: true,
    },
    volume: {
        type: "number",
        label: { zh: "提示音音量", en: "Sound volume" },
        default: 60,
        min: 0,
        max: 100,
    },
    desktop: {
        type: "boolean",
        label: { zh: "系统通知", en: "System notification" },
        description: { zh: "弹出浏览器通知，点击回到这个标签页", en: "Show a browser notification; click it to return to this tab" },
        default: false,
    },
    onlyHidden: {
        type: "boolean",
        label: { zh: "仅在标签页不在前台时提醒", en: "Only when the tab is in the background" },
        default: true,
    },
    test: {
        type: "action",
        label: { zh: "试听 / 授权通知", en: "Test / allow notifications" },
        description: { zh: "播放一次提醒；开启了系统通知时会先请求浏览器授权", en: "Plays the alert once, asking the browser for notification permission first if needed" },
        button: { zh: "试一下", en: "Test" },
        run: () => void test(),
    },
});

let audio: AudioContext | null = null;
let cleanups: (() => void)[] = [];

/** Two short rising notes, made with Web Audio so nothing has to be downloaded. */
export function chime(volume = settings.store.volume) {
    const gain = Math.max(0, Math.min(100, volume)) / 100;
    if (!gain) return;
    try {
        audio ??= new AudioContext();
        if (audio.state === "suspended") void audio.resume();
        const now = audio.currentTime;
        [660, 880].forEach((frequency, index) => {
            const start = now + index * 0.14;
            const osc = audio!.createOscillator();
            const env = audio!.createGain();
            osc.type = "sine";
            osc.frequency.value = frequency;
            env.gain.setValueAtTime(0, start);
            env.gain.linearRampToValueAtTime(0.25 * gain, start + 0.015);
            env.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
            osc.connect(env).connect(audio!.destination);
            osc.start(start);
            osc.stop(start + 0.34);
        });
    } catch {}
}

const chatTitle = () => document.title.replace(/\s*\|\s*Notion\s*$/, "").trim() || "Notion AI";

function lastReply(): string {
    const messages = collectMessages();
    const reply = [...messages].reverse().find(message => message.role === "assistant");
    return reply ? summarize(reply.text, 120) : "";
}

function desktop(error: boolean) {
    if (typeof Notification !== "function" || Notification.permission !== "granted") return;
    try {
        const note = new Notification(error ? t(`回复出错 · ${chatTitle()}`, `Reply failed · ${chatTitle()}`) : chatTitle(), {
            body: error ? t("Notion AI 没能完成这次回复", "Notion AI could not finish this reply") : lastReply() || t("Notion AI 已回复完成", "Notion AI has finished replying"),
            tag: "notionai-pp-reply",
            silent: settings.store.sound,
        });
        note.onclick = () => {
            pageWindow.focus();
            note.close();
        };
    } catch {}
}

function notify({ error }: ReplyEvent & { error: boolean }) {
    if (settings.store.onlyHidden && document.visibilityState === "visible" && document.hasFocus()) return;
    if (settings.store.sound) chime();
    if (settings.store.desktop) desktop(error);
}

async function test() {
    if (settings.store.desktop && typeof Notification === "function" && Notification.permission === "default") {
        await Notification.requestPermission();
    }
    if (settings.store.sound) chime();
    if (settings.store.desktop) desktop(false);
}

export default definePlugin({
    name: "replyNotification",
    title: { zh: "回复完成提醒", en: "Reply notification" },
    description: {
        zh: "Notion AI 回复完成时播放提示音，也可以弹出系统通知。默认只在标签页不在前台时提醒。",
        en: "Plays a sound, and optionally shows a system notification, when Notion AI finishes a reply. By default only while the tab is in the background.",
    },
    icon: Icons.bell,
    tags: ["chat"],
    enabledByDefault: true,
    settings,
    start() {
        cleanups = [watchReplies(), on("replyEnd", notify)];
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        void audio?.close();
        audio = null;
    },
    onSettingsChange(key) {
        if (key === "desktop" && settings.store.desktop && typeof Notification === "function" && Notification.permission === "default") {
            void Notification.requestPermission();
        }
    },
});
