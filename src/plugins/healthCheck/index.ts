/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { createOverlay, type Overlay } from "@api/Overlay";
import { allPlugins, definePlugin, isEnabled } from "@api/PluginManager";
import { currentChatId, replyState, STOP_BUTTON } from "@api/Reply";
import { onRouteChange } from "@api/Router";
import { definePluginSettings } from "@api/Settings";
import { Icons, svgIcon } from "@utils/icons";
import { isAiRoute, t, tr } from "@utils/page";

import { CHAT_SHARE } from "../hideShare";
import { copyRole, USER_STEP } from "../navigator/messages";

/*
 * Like Void++'s BuildHealth: Notion ships new builds several times a day, and a renamed button
 * quietly breaks the plugins that look for it. Once per page load, in a chat that has messages,
 * this checks that the elements the plugins rely on can still be found. When some cannot, a small
 * note names the missing pieces and the plugins they affect. The same failures are not repeated.
 */

const STORE_KEY = "notionai-pp:health:v1";
const SETTLE_MS = 6000;
const ATTEMPTS = 3;

export interface Check {
    id: string;
    label: { zh: string; en: string };
    plugins: string[];
    found(): boolean;
    /** False when the check does not apply to the page as it is right now. */
    applies?(): boolean;
}

const hasMessages = () => !!document.querySelector(`[${USER_STEP}]`);

export const CHECKS: Check[] = [
    {
        id: "composer",
        label: { zh: "AI 输入框", en: "AI composer" },
        plugins: ["usageMeter", "inputHistory", "focusHighlight", "widerChat", "composerLook"],
        found: () => !!document.querySelector("[data-notion-chat-input-container]"),
    },
    {
        id: "send",
        label: { zh: "发送 / 停止按钮", en: "Send / stop button" },
        plugins: ["replyNotification", "tabStatus", "chatNavigator"],
        found: () => !!document.querySelector(`[data-testid='agent-send-message-button'], ${STOP_BUTTON}`),
    },
    {
        id: "messages",
        label: { zh: "对话里的提问", en: "Questions in the chat" },
        plugins: ["chatNavigator", "messageStars", "widerChat"],
        found: hasMessages,
    },
    {
        id: "copy",
        label: { zh: "回复下方的「复制」按钮", en: "Copy button under replies" },
        plugins: ["chatNavigator", "messageStars"],
        applies: () => hasMessages() && replyState() !== "streaming",
        found: () => [...document.querySelectorAll("button, [role='button']")].some(button => copyRole(button) === "assistant"),
    },
    {
        id: "share",
        label: { zh: "右上角的分享按钮", en: "Share button at the top right" },
        plugins: ["hideShare", "messageStars"],
        found: () => !!document.querySelector(CHAT_SHARE),
    },
    {
        id: "sidebar",
        label: { zh: "左侧侧栏", en: "Left sidebar" },
        plugins: ["sidebarTweaks"],
        found: () => !!document.querySelector("nav.notion-sidebar-container"),
    },
];

export const notionVersion = () => document.documentElement.dataset.notionVersion ?? "";

export function failedChecks(checks = CHECKS) {
    return checks.filter(check => (check.applies?.() ?? true) && !check.found()).map(check => check.id);
}

interface Stored {
    version: string;
    failed: string[];
    at: number;
}

export function readStored(): Stored | null {
    try {
        const value = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
        return value && Array.isArray(value.failed) ? value : null;
    } catch {
        return null;
    }
}

function writeStored(value: Stored) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(value));
    } catch {}
}

/** Enabled plugins that a failed check affects, by display title. */
export function affected(failed: string[]) {
    const names = new Set(CHECKS.filter(check => failed.includes(check.id)).flatMap(check => check.plugins));
    return allPlugins().filter(plugin => names.has(plugin.name) && isEnabled(plugin)).map(plugin => tr(plugin.title));
}

/** Whether a fresh result is worth a note: something an enabled plugin needs is missing, and it is news. */
export function shouldNotify(failed: string[], previous: Stored | null, enabledAffected: number) {
    if (!failed.length || !enabledAffected) return false;
    return !previous || [...previous.failed].sort().join() !== [...failed].sort().join();
}

/* ---------- note ---------- */

const CSS = `
:host { all: initial; }
.note { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; width: 340px; box-sizing: border-box;
  padding: 14px 16px; border-radius: 12px; font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  background: #fff; color: #37352f; box-shadow: 0 8px 28px rgba(15,15,15,.18), 0 0 0 1px rgba(15,15,15,.08); }
:host([data-theme="dark"]) .note { background: #2a2a2a; color: #e6e6e5; box-shadow: 0 8px 28px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.1); }
.head { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; }
.head svg { width: 16px; height: 16px; flex: none; }
.head.bad svg { color: #d9730d; }
.head.ok svg { color: #448361; }
.close { margin-left: auto; border: 0; background: none; color: inherit; opacity: .55; cursor: pointer; padding: 2px; display: flex; }
.close:hover { opacity: 1; }
.close svg { width: 14px; height: 14px; }
ul { margin: 4px 0 6px; padding-left: 18px; }
p { margin: 4px 0 0; opacity: .75; font-size: 12px; }
`;

let note: Overlay | null = null;

function closeNote() {
    note?.destroy();
    note = null;
}

function showNote(failed: string[], version: string, notice = "") {
    closeNote();
    note = createOverlay("notionai-pp-health", CSS, "");
    const box = document.createElement("div");
    box.className = "note";
    box.setAttribute("role", "status");
    const head = document.createElement("div");
    head.className = `head ${notice ? "" : failed.length ? "bad" : "ok"}`;
    head.append(svgIcon(notice ? Icons.info : failed.length ? Icons.alert : Icons.check), notice || (failed.length
        ? t("NotionAI++ 自检：有元素找不到了", "NotionAI++ self-check: something is missing")
        : t("NotionAI++ 自检：一切正常", "NotionAI++ self-check: all good")));
    const close = document.createElement("button");
    close.className = "close";
    close.title = t("关闭", "Close");
    close.append(svgIcon(Icons.x));
    close.addEventListener("click", closeNote);
    head.append(close);
    box.append(head);
    if (notice) {
        // the heading says it all
    } else if (failed.length) {
        const list = document.createElement("ul");
        for (const check of CHECKS.filter(check => failed.includes(check.id))) {
            const item = document.createElement("li");
            item.textContent = tr(check.label);
            list.append(item);
        }
        box.append(list);
        const hit = affected(failed);
        if (hit.length) box.append(Object.assign(document.createElement("p"), { textContent: `${t("可能受影响：", "May be affected: ")}${hit.join(t("、", ", "))}` }));
    } else {
        box.append(Object.assign(document.createElement("p"), { textContent: t(`已检查 ${CHECKS.length} 项关键元素。`, `Checked ${CHECKS.length} key elements.`) }));
    }
    if (version) box.append(Object.assign(document.createElement("p"), { textContent: `Notion ${version}` }));
    note.root.append(box);
}

/* ---------- running ---------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let stopRoute: (() => void) | null = null;
let doneThisLoad = false;

const inChat = () => isAiRoute() && !!currentChatId();

function schedule(attempt = 1) {
    if (timer || doneThisLoad || !inChat()) return;
    timer = setTimeout(() => {
        timer = null;
        if (!inChat()) return;
        const failed = failedChecks();
        if (failed.length && attempt < ATTEMPTS) return schedule(attempt + 1);
        doneThisLoad = true;
        const previous = readStored();
        const version = notionVersion();
        if (shouldNotify(failed, previous, affected(failed).length)) showNote(failed, version);
        writeStored({ version, failed, at: Date.now() });
    }, SETTLE_MS);
}

export function runNow() {
    if (!inChat()) {
        return showNote([], "", t("请在一个有消息的 AI 对话里运行自检", "Open a Notion AI chat with messages, then run the check"));
    }
    const failed = failedChecks();
    const version = notionVersion();
    writeStored({ version, failed, at: Date.now() });
    showNote(failed, version);
}

export const settings = definePluginSettings({
    runNow: {
        type: "action",
        label: { zh: "立即自检", en: "Check now" },
        description: { zh: "在当前对话里检查一遍，并显示结果", en: "Check the current chat and show the result" },
        button: { zh: "检查", en: "Check" },
        run: () => runNow(),
    },
});

export default definePlugin({
    name: "healthCheck",
    title: { zh: "改版自检", en: "Notion update check" },
    description: {
        zh: "Notion 更新后，自动检查各插件依赖的按钮和元素还在不在；找不到时右下角提示是哪些插件可能失效。",
        en: "After Notion updates, checks that the buttons and elements the plugins rely on are still there, and notes which plugins may be affected when they are not.",
    },
    icon: Icons.activity,
    enabledByDefault: true,
    settings,
    start() {
        schedule();
        stopRoute = onRouteChange(() => schedule());
    },
    stop() {
        stopRoute?.();
        stopRoute = null;
        if (timer) clearTimeout(timer);
        timer = null;
        closeNote();
    },
});
