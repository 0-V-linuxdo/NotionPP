/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { on, type ReplyEvent } from "@api/Events";
import { definePlugin } from "@api/PluginManager";
import { watchReplies } from "@api/Reply";
import { definePluginSettings, setValue } from "@api/Settings";
import { Icons } from "@utils/icons";
import { pageWindow, t } from "@utils/page";

import { collectMessages, summarize } from "../navigator/messages";

export const settings = definePluginSettings({
    sound: {
        type: "boolean",
        label: { zh: "播放提示音", en: "Play a sound" },
        default: true,
    },
    source: {
        type: "select",
        label: { zh: "提示音", en: "Sound" },
        default: "chime",
        options: [
            { value: "chime", label: { zh: "内置提示音", en: "Built-in chime" } },
            { value: "file", label: { zh: "本地音频文件", en: "Local audio file" } },
        ],
    },
    pick: {
        type: "action",
        label: { zh: "选择音频文件", en: "Choose an audio file" },
        description: { zh: "mp3、wav、ogg 等，最大 2 MB，只保存在本浏览器", en: "mp3, wav, ogg and so on, up to 2 MB, kept in this browser only" },
        button: { zh: "选择…", en: "Choose…" },
        run: () => pickSound(),
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

export const SOUND_KEY = "notionai-pp:reply-sound:v1";
export const MAX_SOUND_BYTES = 2 * 1024 * 1024;

let audio: AudioContext | null = null;
let decoded: { data: string; buffer: AudioBuffer } | null = null;

function storedSound(): { name: string; data: string } | null {
    try {
        const value = JSON.parse(pageWindow.localStorage.getItem(SOUND_KEY) ?? "null");
        return value && typeof value.data === "string" ? value : null;
    } catch {
        return null;
    }
}

function context() {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    return audio;
}

/** Plays the chosen file through Web Audio (no media request, so the page's CSP has no say); false if it can't. */
async function playFile(volume: number): Promise<boolean> {
    const sound = storedSound();
    if (!sound) return false;
    try {
        const ctx = context();
        if (decoded?.data !== sound.data) {
            const bytes = Uint8Array.from(atob(sound.data), char => char.charCodeAt(0));
            decoded = { data: sound.data, buffer: await ctx.decodeAudioData(bytes.buffer) };
        }
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = decoded.buffer;
        gain.gain.value = Math.max(0, Math.min(100, volume)) / 100;
        source.connect(gain).connect(ctx.destination);
        source.start();
        return true;
    } catch {
        return false;
    }
}

function play() {
    const volume = settings.store.volume;
    if (settings.store.source !== "file") return chime(volume);
    void playFile(volume).then(ok => ok || chime(volume));
}

function pickSound() {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*" });
    input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > MAX_SOUND_BYTES) {
            pageWindow.alert(t("音频文件不能超过 2 MB。", "The audio file must be 2 MB or smaller."));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const data = String(reader.result ?? "").replace(/^data:[^,]*,/, "");
            try {
                pageWindow.localStorage.setItem(SOUND_KEY, JSON.stringify({ name: file.name, data }));
            } catch {
                pageWindow.alert(t("保存失败：浏览器存储空间不足。", "Could not save: browser storage is full."));
                return;
            }
            setValue("replyNotification", "source", "file");
            void playFile(settings.store.volume).then(ok => {
                if (!ok) pageWindow.alert(t("这个文件无法播放，已改回内置提示音。", "This file can't be played; switched back to the built-in chime."));
                if (!ok) setValue("replyNotification", "source", "chime");
            });
        };
        reader.readAsDataURL(file);
    });
    input.click();
}
let cleanups: (() => void)[] = [];

/** Two short rising notes, made with Web Audio so nothing has to be downloaded. */
export function chime(volume = settings.store.volume) {
    const gain = Math.max(0, Math.min(100, volume)) / 100;
    if (!gain) return;
    try {
        context();
        const now = audio!.currentTime;
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
    if (settings.store.sound) play();
    if (settings.store.desktop) desktop(error);
}

async function test() {
    if (settings.store.desktop && typeof Notification === "function" && Notification.permission === "default") {
        await Notification.requestPermission();
    }
    if (settings.store.sound) play();
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
        decoded = null;
    },
    onSettingsChange(key) {
        if (key === "desktop" && settings.store.desktop && typeof Notification === "function" && Notification.permission === "default") {
            void Notification.requestPermission();
        }
    },
});
