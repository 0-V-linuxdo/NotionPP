/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { openChat, sameChat } from "@api/Chats";
import { onDomChange } from "@api/DomWatch";
import { createOverlay, type Overlay } from "@api/Overlay";
import { definePlugin } from "@api/PluginManager";
import { currentChatId, currentChatTitle } from "@api/Reply";
import { onRouteChange } from "@api/Router";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";
import { pageWindow, t, trustedHtml } from "@utils/page";
import { debounce } from "@utils/time";

import { collectMessages, summarize } from "../navigator/messages";
import { clearRecent, describe, readRecent, type RecentChat, saveRecent, touch } from "./store";

/*
 * Like Void++'s RecentTopics, after Arc's tab switcher: Ctrl+` shows the chats opened most
 * recently as cards (title, last question and reply). Keep Ctrl down and press ` again to move on
 * (Shift+` goes back), let go of Ctrl to open the chosen one; Esc cancels. A quick Ctrl+` on its
 * own flips back to the chat before this one.
 */

export const settings = definePluginSettings({
    maxRecent: {
        type: "select",
        label: { zh: "显示几个最近对话", en: "Recent chats shown" },
        default: "8",
        options: [
            { value: "5", label: "5" },
            { value: "8", label: "8" },
            { value: "12", label: "12" },
        ],
    },
    clear: {
        type: "action",
        label: { zh: "清空最近对话记录", en: "Clear recent chats" },
        description: { zh: "只删除本机记下的列表，不影响 Notion 里的对话", en: "Only removes the list kept in this browser; your Notion chats are untouched" },
        button: { zh: "清空", en: "Clear" },
        confirm: { zh: "清空最近对话记录？", en: "Clear the recent chats list?" },
        run: () => clearRecent(),
    },
});

const HOST_ID = "notionai-pp-recent-chats";

const CSS = `
:host {
  all: initial;
  --bg: rgba(255,255,255,.86); --card: #ffffff; --text: #37352f; --subtle: #787774; --border: rgba(15,15,15,.1);
  --shadow: 0 16px 48px rgba(15,15,15,.22); --accent: #2383e2;
  position: fixed; inset: 0; z-index: 2147483002; display: flex; align-items: center; justify-content: center;
  font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: rgba(15,15,15,.12);
}
:host([data-theme="dark"]) {
  --bg: rgba(37,37,37,.86); --card: #2f2f2f; --text: #ebebea; --subtle: #9b9a97; --border: rgba(255,255,255,.1);
  --shadow: 0 16px 48px rgba(0,0,0,.5);
  background: rgba(0,0,0,.25);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.panel {
  width: min(880px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow-y: auto; padding: 14px;
  border: 1px solid var(--border); border-radius: 16px; color: var(--text); background: var(--bg); box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4);
}
.head { display: flex; align-items: center; gap: 8px; padding: 0 4px 10px; color: var(--subtle); font-size: 12px; }
.keys { margin-left: auto; }
kbd { padding: 0 4px; border: 1px solid var(--border); border-radius: 4px; font: inherit; font-size: 11px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.card {
  display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
  color: inherit; background: var(--card); font: inherit; text-align: left; cursor: pointer;
}
.card.on { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent); }
.title { display: flex; align-items: baseline; gap: 6px; font-weight: 600; }
.title span { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.title small { flex: none; color: var(--subtle); font-weight: 400; font-size: 11px; }
.line { color: var(--subtle); font-size: 12.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.line b { color: var(--text); font-weight: 500; }
.empty { padding: 18px 8px; color: var(--subtle); text-align: center; }
`;

let overlay: Overlay | null = null;
let items: RecentChat[] = [];
let index = 0;
let lastTouched = "";
let cleanups: (() => void)[] = [];

const isOpen = () => !!overlay && !overlay.host.hidden;

export function isTrigger(event: KeyboardEvent) {
    return event.ctrlKey && !event.altKey && !event.metaKey && (event.code === "Backquote" || event.key === "`" || event.key === "~");
}

export function ago(at: number, now = Date.now()) {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return t("刚刚", "just now");
    if (minutes < 60) return t(`${minutes} 分钟前`, `${minutes} min ago`);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t(`${hours} 小时前`, `${hours} h ago`);
    const days = Math.floor(hours / 24);
    return t(`${days} 天前`, `${days} d ago`);
}

/** The list the switcher shows: the open chat first, then the others by when they were opened. */
export function switcherItems(list: RecentChat[], current: string, max: number): RecentChat[] {
    const here = list.find(item => sameChat(item.id, current));
    const rest = list.filter(item => item !== here);
    return (here ? [here, ...rest] : rest).slice(0, max);
}

function card(item: RecentChat, position: number, current: string) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = position === index ? "card on" : "card";
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(position === index));
    const title = document.createElement("div");
    title.className = "title";
    const name = document.createElement("span");
    name.textContent = item.title || t("未命名对话", "Untitled chat");
    const when = document.createElement("small");
    when.textContent = sameChat(item.id, current) ? t("当前", "Current") : ago(item.at);
    title.append(name, when);
    el.append(title);
    for (const [who, text] of [[t("你", "You"), item.question], ["AI", item.reply]] as const) {
        if (!text) continue;
        const line = document.createElement("div");
        line.className = "line";
        const tag = document.createElement("b");
        tag.textContent = `${who}：`;
        line.append(tag, text);
        el.append(line);
    }
    el.addEventListener("pointerenter", () => select(position));
    el.addEventListener("click", () => {
        index = position;
        commit();
    });
    return el;
}

function paint() {
    if (!overlay) return;
    const current = currentChatId();
    const panel = overlay.root.querySelector<HTMLElement>(".panel")!;
    const head = document.createElement("div");
    head.className = "head";
    head.append(t("最近的对话", "Recent chats"));
    const keys = document.createElement("span");
    keys.className = "keys";
    keys.innerHTML = trustedHtml(t("按住 <kbd>Ctrl</kbd> 连按 <kbd>`</kbd> 切换，松开打开，<kbd>Esc</kbd> 取消", "Hold <kbd>Ctrl</kbd>, press <kbd>`</kbd> to move, release to open, <kbd>Esc</kbd> to cancel"));
    head.append(keys);
    if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("还没有记下最近打开的对话。打开几个 Notion AI 对话后再试。", "No recent chats yet. Open a few Notion AI chats and try again.");
        panel.replaceChildren(head, empty);
        return;
    }
    const grid = document.createElement("div");
    grid.className = "grid";
    grid.setAttribute("role", "listbox");
    grid.append(...items.map((item, position) => card(item, position, current)));
    panel.replaceChildren(head, grid);
    grid.children[index]?.scrollIntoView?.({ block: "nearest" });
}

function select(position: number) {
    if (position === index) return;
    index = position;
    paint();
}

function show() {
    record();
    const current = currentChatId();
    items = switcherItems(readRecent(), current, Number(settings.store.maxRecent) || 8);
    // Like Arc: start on the chat before this one, so a quick Ctrl+` flips back.
    index = items.length > 1 && sameChat(items[0].id, current) ? 1 : 0;
    if (!overlay) {
        overlay = createOverlay(HOST_ID, CSS, `<div class="panel" role="dialog" aria-label="Recent chats"></div>`);
        overlay.host.addEventListener("mousedown", event => event.target === overlay?.host && hide());
    }
    overlay.host.hidden = false;
    paint();
}

function hide() {
    if (overlay) overlay.host.hidden = true;
}

function move(by: number) {
    if (!items.length) return;
    index = (index + by + items.length) % items.length;
    paint();
}

function commit() {
    const chosen = items[index];
    hide();
    if (chosen && !sameChat(chosen.id, currentChatId())) openChat(chosen.id);
}

function onKeyDown(event: KeyboardEvent) {
    if (isTrigger(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (isOpen()) move(event.shiftKey ? -1 : 1);
        else show();
        return;
    }
    if (!isOpen()) return;
    const step = { ArrowRight: 1, ArrowDown: 1, Tab: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (event.key === "Escape") hide();
    else if (event.key === "Enter") commit();
    else if (step) move(event.key === "Tab" && event.shiftKey ? -1 : step);
    else return;
    event.preventDefault();
    event.stopPropagation();
}

function onKeyUp(event: KeyboardEvent) {
    if (event.key === "Control" && isOpen()) {
        event.stopPropagation();
        commit();
    }
}

/** Notes the open chat: moved to the front when newly opened, its title and last exchange kept fresh. */
function record() {
    const id = currentChatId();
    if (!id) return;
    let list = readRecent();
    const before = list;
    if (!sameChat(id, lastTouched) || !list.some(item => sameChat(item.id, id))) {
        list = touch(list, id);
        lastTouched = id;
    }
    const messages = collectMessages();
    const question = [...messages].reverse().find(message => message.role === "user");
    const reply = [...messages].reverse().find(message => message.role === "assistant");
    list = describe(list, id, {
        title: currentChatTitle(),
        question: question ? summarize(question.text, 90) : "",
        reply: reply ? summarize(reply.text, 120) : "",
    });
    if (list !== before) saveRecent(list);
}

export default definePlugin({
    name: "recentChats",
    title: { zh: "最近对话切换", en: "Recent chats switcher" },
    description: {
        zh: "按 Ctrl+` 弹出最近打开的对话（标题和最后一问一答），按住 Ctrl 连按 ` 选择，松开打开，像 Arc 的标签页切换器。",
        en: "Ctrl+` shows the chats you opened most recently (title, last question and reply); hold Ctrl and press ` to pick, release to open, like Arc's tab switcher.",
    },
    icon: Icons.switcher,
    tags: ["chat"],
    enabledByDefault: true,
    updatedAt: "2026-10-24",
    settings,
    start() {
        const later = debounce(record, 800, 3000);
        const onBlur = () => hide();
        // Capture on the window, so Notion's own shortcuts never see a Ctrl+` meant for us.
        pageWindow.addEventListener("keydown", onKeyDown, true);
        pageWindow.addEventListener("keyup", onKeyUp, true);
        pageWindow.addEventListener("blur", onBlur);
        cleanups = [
            onRouteChange(() => {
                hide();
                later();
            }),
            onDomChange(mutations => {
                if (mutations.every(m => [...m.addedNodes, ...m.removedNodes].every(node => node instanceof Element && node.id === HOST_ID))) return;
                if (currentChatId()) later();
            }),
            () => later.cancel(),
            () => pageWindow.removeEventListener("keydown", onKeyDown, true),
            () => pageWindow.removeEventListener("keyup", onKeyUp, true),
            () => pageWindow.removeEventListener("blur", onBlur),
        ];
        record();
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        overlay?.destroy();
        overlay = null;
        items = [];
        lastTouched = "";
    },
});
