/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { createOverlay, type Overlay } from "@api/Overlay";
import { Icons, svgIcon } from "@utils/icons";
import { t } from "@utils/page";

/*
 * Like Void++'s Notifications: Notion-style toasts stacked in the bottom-right corner, for any
 * plugin to tell the user something without their opening the settings. A toast with a key is
 * updated in place when shown again, so one event never stacks two cards.
 */

export type ToastKind = "info" | "success" | "error";

export interface ToastOptions {
    /** Same key, same card: showing it again updates that card instead of adding one. */
    key?: string;
    title: string;
    body?: string;
    kind?: ToastKind;
    /** Milliseconds before it closes; 0 keeps it until dismissed. */
    duration?: number;
    /** Runs when the card is clicked; the card closes after. */
    onClick?: () => void;
}

export interface ToastHandle {
    update(options: Partial<ToastOptions>): void;
    close(): void;
}

export const DEFAULT_TOAST_MS = 6000;
export const MAX_TOASTS = 4;
const HOST_ID = "notionai-pp-toasts";

const CSS = `
:host {
  all: initial;
  --bg: #ffffff; --text: #37352f; --subtle: #787774; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.06);
  --shadow: 0 10px 30px rgba(15,15,15,.16);
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483001; display: block;
  font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:host([data-theme="dark"]) {
  --bg: #252525; --text: #ebebea; --subtle: #9b9a97; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.08);
  --shadow: 0 10px 30px rgba(0,0,0,.45);
}
* { box-sizing: border-box; }
.stack { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.toast {
  display: flex; align-items: flex-start; gap: 10px; width: min(340px, calc(100vw - 40px)); padding: 10px 8px 10px 12px;
  border: 1px solid var(--border); border-radius: 10px; color: var(--text); background: var(--bg); box-shadow: var(--shadow);
  animation: in .16s ease-out;
}
.toast.clickable { cursor: pointer; }
.toast.clickable:hover { background: color-mix(in srgb, var(--bg) 92%, var(--text)); }
.mark { display: flex; flex: none; margin-top: 1px; color: #2383e2; }
.toast.success .mark { color: #2383e2; }
.toast.error .mark { color: #e03e3e; }
.mark svg { width: 18px; height: 18px; }
.text { flex: 1; min-width: 0; }
.title { font-weight: 600; font-size: 14px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.body { margin-top: 2px; color: var(--subtle); font-size: 13px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.close { display: flex; flex: none; align-items: center; justify-content: center; width: 22px; height: 22px; border: 0; border-radius: 5px; color: var(--subtle); background: transparent; cursor: pointer; }
.close:hover { background: var(--hover); color: var(--text); }
.close svg { width: 14px; height: 14px; }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 1px; }
@keyframes in { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
`;

interface Entry {
    key: string;
    options: ToastOptions;
    card: HTMLElement;
    timer: number;
    remaining: number;
    since: number;
}

let overlay: Overlay | null = null;
const entries: Entry[] = [];
let counter = 0;

function stack(): HTMLElement {
    overlay ??= createOverlay(HOST_ID, CSS, `<div class="stack" role="region" aria-live="polite"></div>`);
    return overlay.root.querySelector<HTMLElement>(".stack")!;
}

const MARKS: Record<ToastKind, string> = { info: Icons.info, success: Icons.checkCircle, error: Icons.alert };

function paint(entry: Entry) {
    const { title, body, kind = "info", onClick } = entry.options;
    entry.card.className = `toast ${kind}${onClick ? " clickable" : ""}`;
    entry.card.setAttribute("role", kind === "error" ? "alert" : "status");
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.append(svgIcon(MARKS[kind]));
    const text = document.createElement("div");
    text.className = "text";
    const head = document.createElement("div");
    head.className = "title";
    head.textContent = title;
    head.title = title;
    text.append(head);
    if (body) {
        const line = document.createElement("div");
        line.className = "body";
        line.textContent = body;
        text.append(line);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.title = t("关闭", "Dismiss");
    close.setAttribute("aria-label", close.title);
    close.append(svgIcon(Icons.x));
    close.addEventListener("click", event => {
        event.stopPropagation();
        remove(entry);
    });
    entry.card.replaceChildren(mark, text, close);
}

function arm(entry: Entry, ms: number) {
    clearTimeout(entry.timer);
    entry.timer = 0;
    entry.remaining = ms;
    entry.since = Date.now();
    if (ms > 0) entry.timer = window.setTimeout(() => remove(entry), ms);
}

function remove(entry: Entry) {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    clearTimeout(entry.timer);
    entry.card.remove();
    if (!entries.length) {
        overlay?.destroy();
        overlay = null;
    }
}

const handle = (entry: Entry): ToastHandle => ({
    update: options => {
        if (!entries.includes(entry)) return;
        entry.options = { ...entry.options, ...options };
        paint(entry);
        if ("duration" in options) arm(entry, options.duration ?? DEFAULT_TOAST_MS);
    },
    close: () => remove(entry),
});

export function showToast(options: ToastOptions): ToastHandle {
    const duration = options.duration ?? DEFAULT_TOAST_MS;
    const existing = options.key ? entries.find(entry => entry.key === options.key) : undefined;
    if (existing) {
        existing.options = options;
        paint(existing);
        arm(existing, duration);
        return handle(existing);
    }
    const card = document.createElement("div");
    const entry: Entry = { key: options.key ?? `toast-${++counter}`, options, card, timer: 0, remaining: duration, since: Date.now() };
    card.addEventListener("click", () => {
        const run = entry.options.onClick;
        if (!run) return;
        remove(entry);
        run();
    });
    // Hovering holds the timer, so a toast being read does not vanish under the pointer.
    card.addEventListener("pointerenter", () => {
        if (!entry.timer) return;
        clearTimeout(entry.timer);
        entry.timer = 0;
        entry.remaining = Math.max(1000, entry.remaining - (Date.now() - entry.since));
    });
    card.addEventListener("pointerleave", () => entry.remaining > 0 && entries.includes(entry) && arm(entry, entry.remaining));
    paint(entry);
    entries.push(entry);
    stack().append(card);
    while (entries.length > MAX_TOASTS) remove(entries[0]);
    arm(entry, duration);
    return handle(entry);
}

export function dismissToast(key: string) {
    const entry = entries.find(item => item.key === key);
    if (entry) remove(entry);
}

export const toastKeys = () => entries.map(entry => entry.key);

export function dismissAllToasts() {
    for (const entry of [...entries]) remove(entry);
}
