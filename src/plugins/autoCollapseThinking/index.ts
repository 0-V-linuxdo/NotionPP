/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";

/*
 * Notion AI shows its thinking as one collapsible group per reply: a toggle
 * labelled "Noodling…" (shimmer text plus a role=status live region) while the
 * reply streams, then "N steps" once it is done. The toggle is a
 * role=button[aria-expanded][aria-controls] whose panel (the element with that
 * id) lists the steps, each with a .notion-agent-tool-use-title. Notion leaves
 * the group expanded after a reply finishes; this plugin collapses it.
 *
 * A group the user opens or closes by hand is theirs: we only ever touch a
 * group nobody has clicked, and real clicks are told apart from ours by
 * Event.isTrusted.
 */

const TOGGLE = "[role='button'][aria-expanded][aria-controls]";
const STEP_TITLE = ".notion-agent-tool-use-title";
const STREAMING = "[role='status'], .nds-shimmer-text";
const THINKING_LABEL = /^(?:\d+\s*(?:steps?|个?步骤?)|thought|thinking|reasoning|已?思考|推理)/i;

export const settings = definePluginSettings({
    mode: {
        type: "select",
        label: { zh: "折叠时机", en: "When to collapse" },
        description: { zh: "回复完成后折叠，或生成过程中就折叠", en: "After the reply finishes, or while it is still writing" },
        default: "finished",
        options: [
            { value: "finished", label: { zh: "回复完成后", en: "When the reply finishes" } },
            { value: "immediate", label: { zh: "立即（含生成中）", en: "Immediately, even while streaming" } },
        ],
    },
    collapseHistory: {
        type: "boolean",
        label: { zh: "折叠历史回复", en: "Collapse earlier replies" },
        description: { zh: "打开对话时，也折叠已经展开的旧回复思考", en: "Also collapse expanded thinking in replies already on the page" },
        default: true,
    },
});

/** Toggles the user clicked or keyed themselves; we never touch these again. */
let userOwned = new WeakSet<Element>();
/** Toggles that were already on the page (and finished) when the plugin started. */
let seenAtStart = new WeakSet<Element>();
let stopDom: (() => void) | null = null;
let attrObserver: MutationObserver | null = null;
let scheduled = false;

function panelOf(toggle: Element): Element | null {
    const id = toggle.getAttribute("aria-controls");
    return id ? toggle.ownerDocument.getElementById(id) : null;
}

function labelOf(toggle: Element): string {
    return (toggle.textContent ?? "").replace(/\s+/g, " ").trim();
}

export const isStreaming = (toggle: Element) => !!toggle.querySelector(STREAMING);

/** True for the per-reply thinking group, false for sidebar headers, single tool rows, etc. */
export function isThinkingToggle(toggle: Element): boolean {
    if (!toggle.matches(TOGGLE)) return false;
    if (toggle.closest(".notion-sidebar, nav")) return false;
    // A single step row carries its own title; the group toggle does not.
    if (toggle.querySelector(STEP_TITLE)) return false;
    if (isStreaming(toggle)) return true;
    if (THINKING_LABEL.test(labelOf(toggle))) return true;
    const panel = panelOf(toggle);
    return !!panel?.querySelector(STEP_TITLE);
}

function shouldCollapse(toggle: Element): boolean {
    if (toggle.getAttribute("aria-expanded") !== "true") return false;
    if (userOwned.has(toggle)) return false;
    if (!isThinkingToggle(toggle)) return false;
    if (seenAtStart.has(toggle) && !settings.store.collapseHistory) return false;
    if (settings.store.mode !== "immediate" && isStreaming(toggle)) return false;
    return true;
}

export function scan(root: ParentNode = document) {
    for (const toggle of root.querySelectorAll<HTMLElement>(TOGGLE)) {
        if (shouldCollapse(toggle)) toggle.click();
    }
}

function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        scan();
    });
}

function claim(event: Event) {
    if (!event.isTrusted) return;
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    const toggle = (event.target as Element | null)?.closest?.(TOGGLE);
    if (toggle && isThinkingToggle(toggle)) userOwned.add(toggle);
}

export default definePlugin({
    name: "AutoCollapseThinking",
    title: { zh: "自动折叠 AI 思考", en: "Auto-collapse AI thinking" },
    description: {
        zh: "Notion AI 回复完成后，自动折叠它的思考步骤（“N steps”）。手动展开过的不会再被折叠。",
        en: "Collapses Notion AI's thinking steps (\"N steps\") once a reply finishes. Steps you expand stay open.",
    },
    icon: Icons.collapse,
    tags: ["chat"],
    enabledByDefault: true,
    settings,

    start() {
        userOwned = new WeakSet();
        seenAtStart = new WeakSet();
        for (const toggle of document.querySelectorAll(TOGGLE)) {
            if (!isStreaming(toggle)) seenAtStart.add(toggle);
        }
        document.addEventListener("click", claim, true);
        document.addEventListener("keydown", claim, true);
        stopDom = onDomChange(schedule);
        // DomWatch only reports childList; Notion re-expanding a group is an attribute change.
        attrObserver = new MutationObserver(schedule);
        attrObserver.observe(document.documentElement, {
            subtree: true,
            attributes: true,
            attributeFilter: ["aria-expanded"],
        });
        scan();
    },

    stop() {
        document.removeEventListener("click", claim, true);
        document.removeEventListener("keydown", claim, true);
        stopDom?.();
        stopDom = null;
        attrObserver?.disconnect();
        attrObserver = null;
    },

    onSettingsChange() {
        scan();
    },
});
