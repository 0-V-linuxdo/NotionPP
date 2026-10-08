/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { on } from "@api/Events";
import { createOverlay, type Overlay } from "@api/Overlay";
import { currentChatId, currentChatTitle } from "@api/Reply";
import { onRouteChange } from "@api/Router";
import { scrollParentOf } from "@utils/dom";
import { Icons, svgIcon } from "@utils/icons";
import { pageWindow, t } from "@utils/page";
import { debounce } from "@utils/time";

import { CHAT_SHARE } from "../hideShare";
import { jumpTo } from "../navigator";
import { type ChatMessage, collectMessages, summarize } from "../navigator/messages";
import { allStarredChats, noteStar, readMeta, type StarMeta, starsOf, toggleStar } from "./store";

/*
 * Like Void++'s starred list: a star button in the chat's top-right controls. Hovering it (or
 * clicking, to keep it open) lists this chat's starred messages; click one to jump to it.
 */

export const LIST_MARK = "data-npp-star-list";
const HOST_ID = "notionai-pp-star-list";
const PANEL_TOGGLE = "[data-testid='agent-chat-side-panel-toggle']";
const STAR_COLOR = "#d9730d";
const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 180;
const SCROLL_OFFSET = 72;

const CSS = `
:host {
  all: initial;
  --bg: #ffffff; --text: #37352f; --subtle: #787774; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.06);
  --shadow: 0 10px 30px rgba(15,15,15,.16);
  position: fixed; top: 0; left: 0; z-index: 2147483000; display: block;
  font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:host([data-theme="dark"]) {
  --bg: #252525; --text: #ebebea; --subtle: #9b9a97; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.08);
  --shadow: 0 10px 30px rgba(0,0,0,.45);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.panel {
  width: min(300px, calc(100vw - 16px)); max-height: min(420px, calc(100vh - 64px)); overflow-y: auto; padding: 6px;
  border: 1px solid var(--border); border-radius: 12px; color: var(--text); background: var(--bg); box-shadow: var(--shadow);
  overscroll-behavior: contain;
}
.head { display: flex; align-items: center; gap: 6px; padding: 4px 8px 6px; color: var(--subtle); font-size: 12px; line-height: 1.4; letter-spacing: -.2px; }
.head svg { width: 14px; height: 14px; color: ${STAR_COLOR}; fill: currentColor; flex: none; }
.count { margin-left: auto; font-variant-numeric: tabular-nums; }
ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 1px; }
.row { display: flex; align-items: center; gap: 2px; border-radius: 6px; }
.row:hover, .row:focus-within { background: var(--hover); }
button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.jump { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; padding: 6px 4px 6px 8px; font-size: 13px; text-align: left; }
.role { flex: none; min-width: 22px; color: var(--subtle); font-size: 11px; }
.snip { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row.missing .snip { color: var(--subtle); font-style: italic; }
.unstar { display: flex; flex: none; align-items: center; justify-content: center; width: 24px; height: 24px; margin-right: 2px; border-radius: 5px; color: ${STAR_COLOR}; }
.unstar:hover { background: var(--hover); }
.unstar svg { width: 14px; height: 14px; fill: currentColor; }
.switch-view { flex: none; margin-left: 4px; padding: 1px 6px; border-radius: 5px; color: var(--subtle); font-size: 12px; }
.switch-view:hover { background: var(--hover); color: var(--text); }
.chat { padding: 8px 8px 2px; color: var(--subtle); font-size: 11.5px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.chat.current::after { content: " ·"; }
.empty { padding: 6px 8px 8px; color: var(--subtle); font-size: 13px; }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 1px; }
`;

let overlay: Overlay | null = null;
let button: HTMLElement | null = null;
let pinned = false;
/** Which stars the panel lists: this chat's, or every chat's. */
let view: "chat" | "all" = "chat";
/** A star to reach once its chat is open and the message has loaded. */
let pending: { chatId: string; id: string; until: number } | null = null;
let pendingTimer = 0;
let hovering = false;
let hoverTimer = 0;
let cleanups: (() => void)[] = [];

export interface StarEntry {
    id: string;
    role: "user" | "assistant";
    /** The message's text, or the snippet saved when it was starred; null when neither is known. */
    text: string | null;
    /** On screen now, so a click jumps straight there. */
    loaded: boolean;
}

/** This chat's stars in conversation order; stars on messages not rendered right now go last, with their saved snippet. */
export function starEntries(ids: Set<string>, messages: ChatMessage[], saved: Record<string, StarMeta> = {}): StarEntry[] {
    const shown = messages.filter(m => ids.has(m.id)).map(m => ({ id: m.id, role: m.role, text: m.text, loaded: true }));
    const seen = new Set(shown.map(entry => entry.id));
    const rest = [...ids].filter(id => !seen.has(id)).map(id => ({
        id,
        role: saved[id]?.role ?? (id.endsWith(":assistant") ? "assistant" as const : "user" as const),
        text: saved[id]?.text ?? null,
        loaded: false,
    }));
    return [...shown, ...rest];
}

/** The chat header's button row: Start new chat and Share in a group, then Pin chat, the panel toggle and More. */
export function controlRow(root: ParentNode = document): HTMLElement | null {
    // Share sits in the first group (with Start new chat) and is in the DOM even when hidden;
    // the side-panel toggle is missing when the chat has no details panel.
    // Share is wrapped in one or two popup-origin divs; the group holds the outermost.
    let wrapper = root.querySelector(CHAT_SHARE)?.closest("[data-popup-origin]");
    while (wrapper?.parentElement?.hasAttribute("data-popup-origin")) wrapper = wrapper.parentElement;
    const group = wrapper?.parentElement;
    if (group?.parentElement) return group.parentElement;
    return root.querySelector(PANEL_TOGGLE)?.parentElement?.parentElement ?? null;
}

/**
 * Left of the whole cluster: the first group holds Start new chat (and Share), so the star goes
 * in front of its first button wrapper, otherwise at the start of the row.
 */
export function placeButton(row: HTMLElement, wrapper: HTMLElement) {
    const first = row.firstElementChild as HTMLElement | null;
    // A plain group around several button wrappers, not a button wrapper itself.
    const group = first && first !== wrapper && !first.hasAttribute("data-popup-origin") && !!first.querySelector("[data-popup-origin]") && !first.querySelector(PANEL_TOGGLE) ? first : null;
    const parent = group ?? row;
    const before = [...parent.children].find(child => child !== wrapper && child.hasAttribute("data-popup-origin")) ?? null;
    if (wrapper.parentElement !== parent || wrapper.nextElementSibling !== before) parent.insertBefore(wrapper, before);
}

function headerIcon(native: SVGElement | null): SVGSVGElement {
    const svg = svgIcon(Icons.star);
    // Notion's header icons are 20px shapes with about a 1.25px outline; 1.5 in the 24-unit star matches.
    svg.setAttribute("stroke-width", "1.5");
    const classes = native?.getAttribute("class")?.split(/\s+/).filter(name => /^x[0-9a-z]+$/.test(name));
    if (classes?.length) svg.setAttribute("class", classes.join(" "));
    const ink = (native as SVGElement & { style: CSSStyleDeclaration } | null)?.style.fill || "currentColor";
    svg.style.cssText = `width:20px;height:20px;display:block;flex-shrink:0;fill:none;stroke:${ink}`;
    svg.dataset.ink = ink;
    return svg;
}

function paintButton() {
    if (!button) return;
    const count = starsOf(currentChatId()).size;
    const svg = button.querySelector("svg");
    if (svg) {
        svg.style.stroke = count ? STAR_COLOR : svg.dataset.ink ?? "currentColor";
        svg.style.fill = count ? STAR_COLOR : "none";
    }
    const label = count ? t(`已加星标的消息（${count}）`, `Starred messages (${count})`) : t("已加星标的消息", "Starred messages");
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(isOpen()));
    button.title = label;
}

function makeButton(row: HTMLElement): HTMLElement | null {
    const sample = row.querySelector<HTMLElement>("[aria-label='Pin chat'], [role='button'][aria-label]");
    const sampleWrapper = sample?.parentElement;
    if (!sample || !sampleWrapper) return null;
    const wrapper = sampleWrapper.cloneNode(false) as HTMLElement;
    wrapper.removeAttribute("data-popup-origin");
    wrapper.setAttribute(LIST_MARK, "");
    const btn = sample.cloneNode(false) as HTMLElement;
    for (const name of ["id", "aria-pressed", "aria-expanded", "aria-haspopup", "data-testid"]) btn.removeAttribute(name);
    btn.setAttribute("aria-haspopup", "dialog");
    btn.append(headerIcon(sample.querySelector("svg")));
    btn.addEventListener("pointerenter", () => hoverSoon(true));
    btn.addEventListener("pointerleave", () => hoverSoon(false));
    btn.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        pinned = !isOpen() || !pinned;
        hovering = pinned;
        render();
    });
    btn.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        btn.click();
    });
    wrapper.append(btn);
    button = btn;
    return wrapper;
}

const isOpen = () => pinned || hovering;

function hoverSoon(open: boolean) {
    clearTimeout(hoverTimer);
    if (!open && pinned) return;
    hoverTimer = window.setTimeout(() => {
        hovering = open;
        render();
    }, open ? HOVER_OPEN_MS : HOVER_CLOSE_MS);
}

function close() {
    pinned = false;
    hovering = false;
    clearTimeout(hoverTimer);
    render();
}

function scrollToMessage(id: string): boolean {
    if (jumpTo(id)) return true;
    const target = collectMessages().find(m => m.id === id)?.element;
    if (!target) return false;
    const scroller = scrollParentOf(target);
    const isRoot = scroller === document.scrollingElement || scroller === document.documentElement;
    const top = target.getBoundingClientRect().top - (isRoot ? 0 : scroller.getBoundingClientRect().top) + scroller.scrollTop - SCROLL_OFFSET;
    scroller.scrollTo({ top, behavior: "smooth" });
    return true;
}

/** How long to keep trying to reach a star whose message has not loaded yet. */
export const SEEK_MS = 8000;
const SEEK_STEP_MS = 400;

/**
 * Like Void++'s seek: keep trying until the message is there. Notion loads a long chat's older
 * messages as you scroll up, so each miss scrolls to the top to pull in the next batch.
 */
function seek(chatId: string, id: string) {
    clearTimeout(pendingTimer);
    pending = { chatId, id, until: Date.now() + SEEK_MS };
    const step = () => {
        if (!pending) return;
        if (currentChatId() === pending.chatId && scrollToMessage(pending.id)) {
            pending = null;
            return;
        }
        if (Date.now() > pending.until) {
            pending = null;
            return;
        }
        if (currentChatId() === pending.chatId) {
            const first = collectMessages()[0]?.element;
            if (first) scrollParentOf(first).scrollTo({ top: 0 });
        }
        pendingTimer = window.setTimeout(step, SEEK_STEP_MS);
    };
    step();
}

/** Opens another chat the way Notion's own links do, without reloading the page. */
export function chatUrl(chatId: string, href = location.href): string {
    const url = new URL(href);
    url.searchParams.set("t", chatId);
    return url.toString();
}

function openChat(chatId: string, id: string) {
    if (currentChatId() !== chatId) {
        const url = chatUrl(chatId);
        pageWindow.history.pushState(pageWindow.history.state, "", url);
        pageWindow.dispatchEvent(new PopStateEvent("popstate", { state: pageWindow.history.state }));
        // Notion's router did not pick the change up: load the chat the plain way.
        window.setTimeout(() => {
            if (currentChatId() === chatId && !collectMessages().length && !document.querySelector("[data-agent-chat-user-step-id]")) pageWindow.location.assign(url);
        }, 2500);
    }
    seek(chatId, id);
}

function ensureOverlay(): Overlay {
    if (overlay) return overlay;
    overlay = createOverlay(HOST_ID, CSS, `<div class="panel" role="dialog"></div>`);
    overlay.host.hidden = true;
    overlay.host.addEventListener("pointerenter", () => hoverSoon(true));
    overlay.host.addEventListener("pointerleave", () => hoverSoon(false));
    return overlay;
}

function starRow(role: "user" | "assistant", text: string | null, loaded: boolean, onJump: () => void, onUnstar: () => void) {
    const row = document.createElement("li");
    row.className = loaded ? "row" : "row missing";
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "jump";
    const roleTag = document.createElement("span");
    roleTag.className = "role";
    roleTag.textContent = role === "user" ? t("你", "You") : "AI";
    const snip = document.createElement("span");
    snip.className = "snip";
    snip.textContent = text === null ? t("（未加载，点击后自动查找）", "(not loaded; click to find it)") : summarize(text, 80);
    if (text) jump.title = summarize(text, 400);
    jump.append(roleTag, snip);
    jump.addEventListener("click", onJump);
    const unstar = document.createElement("button");
    unstar.type = "button";
    unstar.className = "unstar";
    unstar.title = t("取消星标", "Unstar");
    unstar.setAttribute("aria-label", unstar.title);
    unstar.append(svgIcon(Icons.star));
    unstar.addEventListener("click", onUnstar);
    row.append(jump, unstar);
    return row;
}

function viewSwitch() {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch-view";
    toggle.textContent = view === "chat" ? t("全部对话", "All chats") : t("本对话", "This chat");
    toggle.addEventListener("click", event => {
        event.stopPropagation();
        view = view === "chat" ? "all" : "chat";
        render();
    });
    return toggle;
}

function fillPanel(panel: HTMLElement) {
    const chatId = currentChatId();
    const messages = collectMessages();
    const saved = readMeta()[chatId]?.items ?? {};
    const entries = starEntries(starsOf(chatId), messages, saved);
    // Stars set before snippets were saved pick theirs up the first time their message is seen.
    const title = currentChatTitle();
    for (const entry of entries) if (entry.loaded && entry.text) noteStar(chatId, entry.id, { role: entry.role, text: entry.text, title });
    const head = document.createElement("div");
    head.className = "head";
    const count = document.createElement("span");
    count.className = "count";
    head.append(svgIcon(Icons.star), document.createTextNode(view === "chat" ? t("已加星标", "Starred") : t("全部星标", "All stars")), count, viewSwitch());
    const list = document.createElement("ul");
    if (view === "chat") {
        count.textContent = String(entries.length);
        for (const entry of entries) {
            list.append(starRow(entry.role, entry.text, entry.loaded, () => {
                seek(chatId, entry.id);
                close();
            }, () => toggleStar(chatId, entry.id)));
        }
    } else {
        const chats = allStarredChats();
        count.textContent = String(chats.reduce((sum, chat) => sum + chat.stars.length, 0));
        for (const chat of chats) {
            const group = document.createElement("li");
            group.className = chat.chatId === chatId ? "chat current" : "chat";
            group.textContent = chat.title || t("未命名对话", "Untitled chat");
            list.append(group);
            for (const star of chat.stars) {
                const here = chat.chatId === chatId ? entries.find(entry => entry.id === star.id) : undefined;
                const role = here?.role ?? star.meta?.role ?? (star.id.endsWith(":assistant") ? "assistant" : "user");
                list.append(starRow(role, here?.text ?? star.meta?.text ?? null, !!here?.loaded, () => {
                    openChat(chat.chatId, star.id);
                    close();
                }, () => toggleStar(chat.chatId, star.id)));
            }
        }
    }
    if (list.children.length) panel.replaceChildren(head, list);
    else {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = view === "chat"
            ? t("这个对话还没有加星标的消息。悬停消息，点工具栏里的星标即可加入。", "No starred messages in this chat yet. Hover a message and click the star in its toolbar.")
            : t("还没有任何星标。", "No stars yet.");
        panel.replaceChildren(head, empty);
    }
}

function render() {
    paintButton();
    const open = isOpen() && !!button?.isConnected;
    if (!open) {
        if (overlay) overlay.host.hidden = true;
        return;
    }
    const { host, root } = ensureOverlay();
    fillPanel(root.querySelector(".panel")!);
    host.hidden = false;
    const anchor = button!.getBoundingClientRect();
    const panel = root.querySelector<HTMLElement>(".panel")!;
    const width = panel.offsetWidth || 300;
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(anchor.bottom + 6)}px`;
}

/** Puts the star button back after Notion re-renders the header, and drops it off chat pages. */
export function sync() {
    const row = currentChatId() ? controlRow() : null;
    let wrapper = document.querySelector<HTMLElement>(`[${LIST_MARK}]`);
    if (!row) {
        wrapper?.remove();
        button = null;
        if (isOpen()) close();
        return;
    }
    if (wrapper && !row.contains(wrapper)) {
        wrapper.remove();
        wrapper = null;
    }
    wrapper ??= makeButton(row);
    if (!wrapper) return;
    placeButton(row, wrapper);
    paintButton();
}

export function startList() {
    const resync = debounce(sync, 150, 600);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && isOpen() && close();
    const onDown = (event: PointerEvent) => {
        if (!isOpen()) return;
        const path = event.composedPath();
        if ((button && path.includes(button)) || (overlay && path.includes(overlay.host))) return;
        close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    cleanups = [
        onDomChange(mutations => {
            if (mutations.every(m => [...m.addedNodes, ...m.removedNodes].every(node => node instanceof Element && (node.hasAttribute(LIST_MARK) || node.id === HOST_ID)))) return;
            resync();
        }),
        on("starsChanged", () => (isOpen() ? render() : paintButton())),
        onRouteChange(() => {
            close();
            resync();
        }),
        () => resync.cancel(),
        () => document.removeEventListener("keydown", onKey, true),
        () => document.removeEventListener("pointerdown", onDown, true),
    ];
    sync();
}

export function stopList() {
    for (const cleanup of cleanups.splice(0)) cleanup();
    clearTimeout(pendingTimer);
    pending = null;
    view = "chat";
    clearTimeout(hoverTimer);
    pinned = false;
    hovering = false;
    document.querySelector(`[${LIST_MARK}]`)?.remove();
    button = null;
    overlay?.destroy();
    overlay = null;
}
