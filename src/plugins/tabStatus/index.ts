/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { on } from "@api/Events";
import { definePlugin } from "@api/PluginManager";
import { watchReplies } from "@api/Reply";
import { onRouteChange } from "@api/Router";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";

/*
 * Like Void++'s chatStateFavicons: the tab icon shows a spinning arc while Notion AI writes,
 * a blue dot once the reply is done and a red dot if it failed. Done and failed stay until
 * the tab is looked at again.
 */

export type TabState = "idle" | "streaming" | "done" | "error" | "draft";

const SIZE = 32;
const SPIN_MS = 120;
const COLORS = { done: "#2383e2", error: "#e03e3e", streaming: "#2383e2", draft: "#9b9a97" } as const;
const EDITOR = "[data-notion-chat-input-container] [contenteditable='true']";

export const settings = definePluginSettings({
    showDone: {
        type: "boolean",
        label: { zh: "回复完成后显示蓝点", en: "Blue dot when a reply is done" },
        description: { zh: "回到这个标签页后自动消失", en: "Clears when you come back to the tab" },
        default: true,
    },
    showDraft: {
        type: "boolean",
        label: { zh: "有没发出的草稿时显示灰圈", en: "Grey ring for an unsent draft" },
        description: { zh: "离开标签页时，如果输入框里还有没发出的文字，图标上显示一个灰色圆圈提醒你", en: "When you leave the tab with text still in the composer, the icon shows a grey ring" },
        default: false,
    },
});

let state: TabState = "idle";
/** Notion's own icon links and their hrefs, put back when the badge goes. */
let originals = new Map<HTMLLinkElement, string>();
let base: { href: string; image: HTMLImageElement } | null = null;
let ours = "";
let angle = 0;
let timer = 0;
let cleanups: (() => void)[] = [];

const iconLinks = () => [...document.querySelectorAll<HTMLLinkElement>("link[rel~='icon']")];

/**
 * Notes every icon link that is not showing our badge. Notion can carry several (sizes, light
 * and dark) and the browser picks any of them, so the badge has to go on all of them.
 */
function remember() {
    for (const link of iconLinks()) {
        if (link.href === ours) continue;
        // Notion swapped the icon itself (or this is the first look): that is the new original.
        originals.set(link, link.href);
    }
    for (const link of originals.keys()) if (!link.isConnected) originals.delete(link);
}

function loadBase(): Promise<HTMLImageElement | null> {
    const href = originals.values().next().value;
    if (!href) return Promise.resolve(null);
    if (base?.href === href && base.image.complete) return Promise.resolve(base.image);
    const image = new Image();
    image.src = href;
    base = { href, image };
    return new Promise(resolve => {
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
    });
}

export function drawBadge(ctx: CanvasRenderingContext2D, kind: TabState, turn = 0) {
    if (kind === "idle") return;
    const r = 7;
    const cx = SIZE - r - 1;
    const cy = SIZE - r - 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    if (kind === "streaming") {
        ctx.beginPath();
        ctx.arc(cx, cy, r - 1.5, turn, turn + Math.PI * 1.4);
        ctx.strokeStyle = COLORS.streaming;
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.stroke();
        return;
    }
    if (kind === "draft") {
        ctx.beginPath();
        ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.draft;
        ctx.lineWidth = 3;
        ctx.stroke();
        return;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[kind];
    ctx.fill();
}

async function paint() {
    remember();
    if (!originals.size) return;
    if (state === "idle") {
        for (const [link, href] of originals) if (link.href !== href) link.href = href;
        return;
    }
    const image = await loadBase();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (image) ctx.drawImage(image, 0, 0, SIZE, SIZE);
    drawBadge(ctx, state, angle);
    try {
        ours = canvas.toDataURL("image/png");
        for (const link of originals.keys()) link.href = ours;
    } catch {}
}

function setState(next: TabState) {
    state = next;
    clearInterval(timer);
    if (next === "streaming") {
        timer = setInterval(() => {
            angle = (angle + Math.PI / 4) % (Math.PI * 2);
            void paint();
        }, SPIN_MS) as unknown as number;
    }
    void paint();
}

const hasDraft = () => [...document.querySelectorAll<HTMLElement>(EDITOR)].some(editor => !!editor.innerText?.trim());

function seen() {
    if (document.visibilityState === "visible") {
        if (state === "done" || state === "error" || state === "draft") setState("idle");
    } else if (state === "idle" && settings.store.showDraft && hasDraft()) {
        setState("draft");
    }
}

export default definePlugin({
    name: "tabStatus",
    title: { zh: "标签页图标状态", en: "Tab icon status" },
    description: {
        zh: "在标签页图标上显示 Notion AI 的状态：生成中转圈，完成显示蓝点，出错显示红点，回到标签页后消失。",
        en: "Shows Notion AI's state on the tab icon: a spinner while writing, a blue dot when done and a red dot on errors, cleared when you return to the tab.",
    },
    icon: Icons.browser,
    tags: ["chat"],
    enabledByDefault: true,
    updatedAt: "2026-10-08",
    settings,
    start() {
        remember();
        const onVisible = () => seen();
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);
        cleanups = [
            watchReplies(),
            on("replyStart", () => setState("streaming")),
            on("replyEnd", ({ error, stopped, left }) => {
                // Stopping a reply, or leaving its chat, is no news to show on the tab.
                if (stopped || left) return setState("idle");
                const away = document.visibilityState !== "visible" || !document.hasFocus();
                setState(error ? (away ? "error" : "idle") : away && settings.store.showDone ? "done" : "idle");
            }),
            // A dot belongs to the chat it was earned in; opening another one clears it.
            onRouteChange(() => {
                if (state === "done" || state === "error" || state === "draft") setState("idle");
            }),
            // Notion may rewrite or add icon links (route changes, theme); put our badge back on.
            onDomChange(() => {
                if (state !== "idle" && iconLinks().some(link => link.href !== ours)) void paint();
            }),
            () => document.removeEventListener("visibilitychange", onVisible),
            () => window.removeEventListener("focus", onVisible),
        ];
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        setState("idle");
        originals = new Map();
        base = null;
    },
});
