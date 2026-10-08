/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { currentTheme } from "@api/Theme";
import { reducedMotion } from "@utils/dom";
import { t } from "@utils/page";

export type Effect = "none" | "border" | "pulse" | "fade" | "jiggle";

export const EFFECTS: { value: Effect; zh: string; en: string }[] = [
    { value: "none", zh: "无（只滚动）", en: "None (scroll only)" },
    { value: "border", zh: "高亮边框", en: "Highlight border" },
    { value: "pulse", zh: "脉冲光晕", en: "Pulse glow" },
    { value: "fade", zh: "淡入淡出", en: "Fade" },
    { value: "jiggle", zh: "经典抖动", en: "Classic jiggle" },
];

const running = new WeakMap<Element, Animation>();

const KEYFRAMES: Record<Exclude<Effect, "none">, { frames: Keyframe[]; duration: number }> = {
    border: {
        frames: [
            { outline: "2px solid rgba(255,196,0,.95)", outlineOffset: "4px", boxShadow: "0 0 0 0 rgba(255,196,0,.45)" },
            { outline: "2px solid rgba(255,196,0,.95)", outlineOffset: "4px", boxShadow: "0 0 0 12px rgba(255,196,0,0)", offset: 0.6 },
            { outline: "2px solid rgba(255,196,0,0)", outlineOffset: "4px", boxShadow: "0 0 0 12px rgba(255,196,0,0)" },
        ],
        duration: 2000,
    },
    pulse: {
        frames: [
            { boxShadow: "0 0 0 0 rgba(59,130,246,.7)" },
            { boxShadow: "0 0 0 15px rgba(59,130,246,0)", offset: 0.5 },
            { boxShadow: "0 0 0 0 rgba(59,130,246,0)" },
        ],
        duration: 2000,
    },
    fade: {
        frames: [
            { backgroundColor: "rgba(59,130,246,0)" },
            { backgroundColor: "rgba(59,130,246,.28)", offset: 0.5 },
            { backgroundColor: "rgba(59,130,246,0)" },
        ],
        duration: 1500,
    },
    jiggle: {
        frames: [0, -3, 3, -3, 3, -3, 3, -3, 3, 0].map(x => ({ transform: `translateX(${x}px)` })),
        duration: 400,
    },
};

export function playEffect(element: Element, effect: Effect) {
    if (effect === "none" || typeof element.animate !== "function") return;
    running.get(element)?.cancel();
    const { frames, duration } = KEYFRAMES[effect];
    const reduced = reducedMotion();
    const animation = element.animate(effect === "jiggle" && reduced ? KEYFRAMES.fade.frames : frames, {
        duration: reduced ? Math.min(duration, 1000) : duration,
        easing: "ease-in-out",
    });
    running.set(element, animation);
}

const PREVIEW_ID = "notionai-pp-effect-preview";

/** Plays the effect on a temporary card at the top of the page, like the original's 预览 button. */
export function previewEffect(effect: Effect) {
    document.getElementById(PREVIEW_ID)?.remove();
    const info = EFFECTS.find(item => item.value === effect);
    // The holder centers the card, because the jiggle keyframes own the card's `transform`.
    const holder = document.createElement("div");
    holder.id = PREVIEW_ID;
    Object.assign(holder.style, {
        position: "fixed", left: "0", right: "0", top: "24px", zIndex: "2147483647",
        display: "flex", justifyContent: "center", pointerEvents: "none",
    });
    const card = document.createElement("div");
    card.textContent = info ? t(info.zh, info.en) : effect;
    const dark = currentTheme() === "dark";
    Object.assign(card.style, {
        padding: "12px 20px", borderRadius: "10px", background: dark ? "#202020" : "#fff", color: dark ? "#f0efed" : "#37352f",
        font: "500 14px/20px ui-sans-serif, -apple-system, system-ui, sans-serif",
        boxShadow: dark ? "0 0 0 1px #383836, 0 12px 32px rgba(0,0,0,.5)" : "0 0 0 1px rgba(15,15,15,.05), 0 12px 32px rgba(15,15,15,.18)",
    });
    holder.append(card);
    document.body.append(holder);
    playEffect(card, effect);
    const duration = effect === "none" ? 600 : KEYFRAMES[effect].duration;
    setTimeout(() => holder.remove(), duration + 600);
}
