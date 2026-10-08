/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";
import { t } from "@utils/page";
import { debounce } from "@utils/time";

import { USER_STEP } from "../navigator/messages";

/*
 * Like Void++'s autoCollapse: long code blocks in Notion AI's replies start folded to a set
 * height with a fade at the bottom and a bar to open them. Notion's code blocks cannot be
 * folded on their own. Only blocks inside the chat are touched, never the composer or pages.
 */

const STYLE_ID = "notionai-pp-code-fold";
const MARK = "data-npp-fold";
const BAR = "data-npp-fold-bar";
const CODE = ".notion-code-block, pre";
const COMPOSER = "[data-notion-chat-input-container]";

export const settings = definePluginSettings({
    height: {
        type: "number",
        label: { zh: "折叠后的高度（像素）", en: "Folded height (px)" },
        description: { zh: "比这更高的代码块默认折叠", en: "Code blocks taller than this start folded" },
        default: 320,
        min: 120,
        max: 1200,
    },
});

/** The code blocks of the chat's replies; anything inside the composer is left alone. */
export function chatCodeBlocks(root: ParentNode = document): HTMLElement[] {
    if (!root.querySelector(`[${USER_STEP}]`)) return [];
    const blocks = [...root.querySelectorAll<HTMLElement>(CODE)].filter(block => !block.closest(COMPOSER) && !block.parentElement?.closest(CODE));
    return blocks;
}

const lineCount = (block: HTMLElement) => (block.innerText ?? "").replace(/\n$/, "").split("\n").length;

function css(height: number) {
    return `[${MARK}="folded"] { max-height: ${height}px !important; overflow: hidden !important; position: relative;
  -webkit-mask-image: linear-gradient(#000 calc(100% - 56px), transparent); mask-image: linear-gradient(#000 calc(100% - 56px), transparent); }
[${BAR}] { display: flex; align-items: center; justify-content: center; width: 100%; margin: 2px 0 6px; padding: 4px 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--c-texSec, rgba(120,119,116,1)); font: inherit; font-size: 12.5px; cursor: pointer; }
[${BAR}]:hover { background: var(--ca-bacHov, rgba(55,53,47,.06)); color: var(--c-texPri, inherit); }`;
}

function makeBar(block: HTMLElement): HTMLButtonElement {
    const bar = document.createElement("button");
    bar.type = "button";
    bar.setAttribute(BAR, "");
    bar.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const folded = block.getAttribute(MARK) === "folded";
        block.setAttribute(MARK, folded ? "open" : "folded");
        label(bar, block);
        if (!folded) block.scrollIntoView({ block: "nearest" });
    });
    return bar;
}

function label(bar: HTMLElement, block: HTMLElement) {
    const folded = block.getAttribute(MARK) === "folded";
    const lines = lineCount(block);
    bar.textContent = folded ? t(`展开全部代码（${lines} 行）`, `Show all ${lines} lines`) : t("收起代码", "Fold code");
    bar.setAttribute("aria-expanded", String(!folded));
}

/** Folds every new tall block once; a block the reader opened stays open. */
export function scan() {
    const limit = settings.store.height;
    for (const block of chatCodeBlocks()) {
        let bar = block.nextElementSibling?.hasAttribute(BAR) ? block.nextElementSibling as HTMLElement : null;
        if (!block.hasAttribute(MARK)) {
            // Still streaming in or short: look again later.
            if (block.scrollHeight <= limit + 40) continue;
            block.setAttribute(MARK, "folded");
        }
        if (!bar) {
            bar = makeBar(block);
            block.after(bar);
        }
        label(bar, block);
    }
}

function removeAll() {
    for (const bar of document.querySelectorAll(`[${BAR}]`)) bar.remove();
    for (const block of document.querySelectorAll(`[${MARK}]`)) block.removeAttribute(MARK);
}

function applyStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css(settings.store.height);
}

let cleanups: (() => void)[] = [];

export default definePlugin({
    name: "codeFold",
    title: { zh: "长代码块折叠", en: "Fold long code" },
    description: {
        zh: "Notion AI 回复里很长的代码块默认折叠到设定高度，底部有「展开全部代码」按钮，看完可以再收起。",
        en: "Long code blocks in Notion AI replies start folded to a set height, with a bar to show all of it and fold it again.",
    },
    icon: Icons.code,
    tags: ["chat"],
    enabledByDefault: true,
    updatedAt: "2026-10-08",
    settings,
    start() {
        applyStyle();
        const rescan = debounce(scan, 250, 1000);
        cleanups = [
            onDomChange(mutations => {
                if (mutations.every(m => [...m.addedNodes, ...m.removedNodes].every(node => node instanceof Element && node.hasAttribute(BAR)))) return;
                rescan();
            }),
            () => rescan.cancel(),
        ];
        scan();
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        removeAll();
        document.getElementById(STYLE_ID)?.remove();
    },
    onSettingsChange() {
        applyStyle();
        scan();
    },
});
