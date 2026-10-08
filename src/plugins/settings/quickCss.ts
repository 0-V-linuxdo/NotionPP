/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { getValue, onSettingsChange, setValue } from "@api/Settings";
import { h, row, section, switchControl } from "@utils/kit";
import { t } from "@utils/page";
import { debounce } from "@utils/time";

/*
 * Like Void++'s Quick CSS tab: your own CSS for the Notion page, applied as you type and kept
 * with the rest of the settings.
 */

const SELF = "settings";
export const CSS_KEY = "quickCss";
export const CSS_ON_KEY = "quickCssOn";
export const QUICK_CSS_ID = "notionai-pp-quick-css";
const INDENT = "  ";

export const quickCss = () => String(getValue(SELF, CSS_KEY) ?? "");
export const quickCssOn = () => getValue(SELF, CSS_ON_KEY) !== false;

/** Puts the saved CSS on the page, or takes it off when it is empty or switched off. */
export function applyQuickCss() {
    const css = quickCssOn() ? quickCss() : "";
    let style = document.getElementById(QUICK_CSS_ID);
    if (!css.trim()) {
        style?.remove();
        return;
    }
    if (!style) {
        style = document.createElement("style");
        style.id = QUICK_CSS_ID;
    }
    if (style.textContent !== css) style.textContent = css;
    // Last in <head>, so it wins over Notion's rules of the same specificity.
    const parent = document.head ?? document.documentElement;
    if (style.parentNode !== parent || style.nextElementSibling) parent.append(style);
}

/** Applies now and whenever the CSS or its switch changes, in this tab or another. */
export function startQuickCss() {
    applyQuickCss();
    return onSettingsChange((plugin, key) => {
        if (plugin === "*" || (plugin === SELF && (key === CSS_KEY || key === CSS_ON_KEY || key === "*"))) applyQuickCss();
    });
}

export function stopQuickCss() {
    document.getElementById(QUICK_CSS_ID)?.remove();
}

/** Tab inserts two spaces, Shift+Tab removes them, instead of leaving the editor. */
function onEditorKey(event: KeyboardEvent, area: HTMLTextAreaElement) {
    if (event.key !== "Tab" || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = area;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    if (event.shiftKey) {
        if (value.startsWith(INDENT, lineStart)) {
            area.setRangeText("", lineStart, lineStart + INDENT.length, "preserve");
            area.setSelectionRange(Math.max(lineStart, start - INDENT.length), Math.max(lineStart, end - INDENT.length));
        }
    } else {
        area.setRangeText(INDENT, start, end, "end");
    }
    area.dispatchEvent(new Event("input"));
}

export function quickCssTab() {
    const area = h("textarea", {
        class: "code",
        spellcheck: false,
        "aria-label": t("自定义 CSS", "Custom CSS"),
        placeholder: t(
            "/* 例：把 AI 回复的字号调大 */\n[data-agent-chat-user-step-id] { font-size: 15px; }",
            "/* Example: larger text in prompts */\n[data-agent-chat-user-step-id] { font-size: 15px; }"),
    });
    area.value = quickCss();
    const status = h("span", { class: "code-status" });
    const showStatus = () => {
        const lines = area.value ? area.value.split("\n").length : 0;
        status.textContent = !quickCssOn()
            ? t("已停用", "Off")
            : lines ? t(`已应用 · ${lines} 行`, `Applied · ${lines} lines`) : t("未填写", "Empty");
    };
    const save = debounce(() => {
        setValue(SELF, CSS_KEY, area.value);
        showStatus();
    }, 300, 1200);
    area.addEventListener("input", () => save());
    area.addEventListener("keydown", event => onEditorKey(event, area));
    area.addEventListener("blur", () => {
        save.cancel();
        setValue(SELF, CSS_KEY, area.value);
        showStatus();
    });
    const toggle = switchControl(quickCssOn(), t("启用自定义 CSS", "Use custom CSS"), value => {
        setValue(SELF, CSS_ON_KEY, value);
        showStatus();
    });
    showStatus();
    return h("div", { class: "tab-root quick-css" },
        section(t("开关", "Switch"),
            row(t("启用自定义 CSS", "Use custom CSS"),
                t("关掉后样式立即移除，内容会保留", "Turning it off removes the styles at once and keeps what you wrote"), toggle)),
        h("div", { class: "code-wrap" }, area, h("div", { class: "code-foot" },
            h("span", {}, t("输入即生效 · 作用于 Notion 页面，不影响 NotionAI++ 自己的面板 · Tab 缩进", "Applies as you type · styles the Notion page, not NotionAI++'s own panels · Tab indents")),
            status)));
}
