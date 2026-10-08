/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { on } from "@api/Events";
import { definePlugin } from "@api/PluginManager";
import { watchReplies } from "@api/Reply";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";

/*
 * Like Void++'s chatStateFavicons: the tab icon shows a spinning arc while Notion AI writes,
 * a blue dot once the reply is done and a red dot if it failed. Done and failed stay until
 * the tab is looked at again.
 */

export type TabState = "idle" | "streaming" | "done" | "error";

const SIZE = 32;
const SPIN_MS = 120;
const COLORS = { done: "#2383e2", error: "#e03e3e", streaming: "#2383e2" } as const;

export const settings = definePluginSettings({
    showDone: {
        type: "boolean",
        label: { zh: "回复完成后显示蓝点", en: "Blue dot when a reply is done" },
        description: { zh: "回到这个标签页后自动消失", en: "Clears when you come back to the tab" },
        default: true,
    },
});

let state: TabState = "idle";
let original: { link: HTMLLinkElement; href: string } | null = null;
let base: HTMLImageElement | null = null;
let ours = "";
let angle = 0;
let timer = 0;
let cleanups: (() => void)[] = [];

const iconLink = () => document.querySelector<HTMLLinkElement>("link[rel~='icon']");

function remember() {
    const link = iconLink();
    if (!link || link.href === ours) return;
    // Notion swapped the icon itself (or this is the first look): that is the new original.
    original = { link, href: link.href };
    base = null;
}

function loadBase(): Promise<HTMLImageElement | null> {
    if (base?.complete) return Promise.resolve(base);
    if (!original) return Promise.resolve(null);
    const image = new Image();
    image.src = original.href;
    base = image;
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
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[kind];
    ctx.fill();
}

async function paint() {
    remember();
    const link = original?.link;
    if (!link) return;
    if (state === "idle") {
        if (original && link.href !== original.href) link.href = original.href;
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
        link.href = ours;
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

function seen() {
    if (document.visibilityState === "visible" && (state === "done" || state === "error")) setState("idle");
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
    settings,
    start() {
        remember();
        const onVisible = () => seen();
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);
        cleanups = [
            watchReplies(),
            on("replyStart", () => setState("streaming")),
            on("replyEnd", ({ error }) => {
                const away = document.visibilityState !== "visible" || !document.hasFocus();
                setState(error ? (away ? "error" : "idle") : away && settings.store.showDone ? "done" : "idle");
            }),
            // Notion may rewrite the icon link (route changes, theme); put our badge back on.
            onDomChange(() => {
                const link = iconLink();
                if (state !== "idle" && link && link.href !== ours) void paint();
            }),
            () => document.removeEventListener("visibilitychange", onVisible),
            () => window.removeEventListener("focus", onVisible),
        ];
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        setState("idle");
        original = null;
        base = null;
    },
});
