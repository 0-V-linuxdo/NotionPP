/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { createOverlay, type Overlay } from "@api/Overlay";
import { definePlugin } from "@api/PluginManager";
import { currentChatId, currentChatTitle } from "@api/Reply";
import { onRouteChange } from "@api/Router";
import { definePluginSettings } from "@api/Settings";
import { showToast } from "@api/Toast";
import { Icons, svgIcon } from "@utils/icons";
import { pageWindow, t } from "@utils/page";
import { debounce } from "@utils/time";

import { controlRow, headerSample, LIST_MARK, placeButton } from "../messageStars/list";
import { type ChatMessage, collectMessages } from "../navigator/messages";
import { toMarkdown } from "./markdown";

/*
 * Like Void++'s ExportChat: the open chat as Markdown, plain text or JSON, from a button in the
 * chat's top-right controls. Notion keeps the whole chat only on its servers; the export is made
 * from the messages on the page, so a long chat's oldest messages need to have been scrolled into
 * view first. The toast after an export says how many messages it holds.
 */

export const EXPORT_MARK = "data-npp-export";
const HOST_ID = "notionai-pp-export-menu";

export type Format = "md" | "txt" | "json";

export const settings = definePluginSettings({
    headerButton: {
        type: "boolean",
        label: { zh: "对话右上角显示导出按钮", en: "Export button in the chat header" },
        default: true,
    },
    exportNow: {
        type: "action",
        label: { zh: "导出当前对话", en: "Export the current chat" },
        description: { zh: "下载为 Markdown 文件", en: "Download it as a Markdown file" },
        button: { zh: "导出", en: "Export" },
        run: () => exportChat("md"),
    },
});

export interface ExportedMessage {
    role: "user" | "assistant";
    text: string;
    markdown: string;
}

export interface ExportedChat {
    title: string;
    chatId: string;
    url: string;
    exportedAt: string;
    messages: ExportedMessage[];
}

/** Each message once, in order: the user's words as typed, a reply rebuilt as Markdown. */
export function gather(messages: ChatMessage[]): ExportedMessage[] {
    const seen = new Set<string>();
    const out: ExportedMessage[] = [];
    for (const message of messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        const markdown = message.role === "assistant" ? toMarkdown(message.element) || message.text : message.text;
        out.push({ role: message.role, text: message.text, markdown });
    }
    return out;
}

const speaker = (role: ExportedMessage["role"]) => (role === "user" ? t("你", "You") : "Notion AI");

export function render(chat: ExportedChat, format: Format): string {
    if (format === "json") return JSON.stringify(chat, null, 2);
    if (format === "txt") {
        const lines = [chat.title, chat.url, ""];
        for (const message of chat.messages) lines.push(`${speaker(message.role)}:`, message.text, "", "----------", "");
        return lines.join("\n").trimEnd() + "\n";
    }
    const lines = [`# ${chat.title}`, "", `> ${t("导出时间", "Exported")} ${new Date(chat.exportedAt).toLocaleString()} · ${chat.url}`, ""];
    for (const message of chat.messages) {
        lines.push(`## ${speaker(message.role)}`, "");
        // A question stays as typed: quote lines and line breaks are the user's own.
        lines.push(message.role === "user" ? message.text.split("\n").join("  \n") : message.markdown, "", "---", "");
    }
    return lines.join("\n").trimEnd() + "\n";
}

export function fileName(title: string, format: Format, date = new Date()) {
    const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Notion AI chat";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${safe} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.${format}`;
}

const MIME: Record<Format, string> = { md: "text/markdown", txt: "text/plain", json: "application/json" };

function current(): ExportedChat | null {
    const messages = gather(collectMessages());
    if (!messages.length) return null;
    return {
        title: currentChatTitle() || t("Notion AI 对话", "Notion AI chat"),
        chatId: currentChatId(),
        url: pageWindow.location.href,
        exportedAt: new Date().toISOString(),
        messages,
    };
}

function nothing() {
    showToast({ key: "export", kind: "error", title: t("没有可导出的消息", "Nothing to export"), body: t("先打开一个 Notion AI 对话", "Open a Notion AI chat first") });
}

const done = (count: number, copied: boolean) => showToast({
    key: "export",
    kind: "success",
    title: copied ? t(`已复制 ${count} 条消息`, `Copied ${count} messages`) : t(`已导出 ${count} 条消息`, `Exported ${count} messages`),
    body: t("只包含页面上已加载的消息；很长的对话请先往上滚到开头", "Only messages loaded on the page are included; scroll a long chat to its start first"),
});

export function exportChat(format: Format) {
    const chat = current();
    if (!chat) return nothing();
    const blob = new Blob([render(chat, format)], { type: `${MIME[format]};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: fileName(chat.title, format) });
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    done(chat.messages.length, false);
}

async function copyMarkdown() {
    const chat = current();
    if (!chat) return nothing();
    try {
        await pageWindow.navigator.clipboard.writeText(render(chat, "md"));
        done(chat.messages.length, true);
    } catch {
        showToast({ key: "export", kind: "error", title: t("复制失败", "Could not copy"), body: t("浏览器没有允许写入剪贴板，改用下载吧", "The browser blocked the clipboard; download instead") });
    }
}

/* ---------- header button and its menu ---------- */

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
.menu { min-width: 200px; padding: 6px; border: 1px solid var(--border); border-radius: 10px; color: var(--text); background: var(--bg); box-shadow: var(--shadow); }
.head { padding: 4px 8px 6px; color: var(--subtle); font-size: 12px; }
button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 6px 8px; border: 0; border-radius: 6px; color: inherit; background: transparent; font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
button:hover, button:focus-visible { background: var(--hover); outline: none; }
.ext { margin-left: auto; color: var(--subtle); font-size: 12px; }
`;

let overlay: Overlay | null = null;
let button: HTMLElement | null = null;
let cleanups: (() => void)[] = [];

function closeMenu() {
    if (overlay) overlay.host.hidden = true;
    button?.setAttribute("aria-expanded", "false");
}

const menuOpen = () => !!overlay && !overlay.host.hidden;

function openMenu() {
    if (!button) return;
    overlay ??= createOverlay(HOST_ID, CSS, `<div class="menu" role="menu"></div>`);
    const menu = overlay.root.querySelector<HTMLElement>(".menu")!;
    const item = (label: string, ext: string, run: () => void) => {
        const el = document.createElement("button");
        el.type = "button";
        el.setAttribute("role", "menuitem");
        el.append(label);
        if (ext) {
            const tag = document.createElement("span");
            tag.className = "ext";
            tag.textContent = ext;
            el.append(tag);
        }
        el.addEventListener("click", () => {
            closeMenu();
            run();
        });
        return el;
    };
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = t("导出对话", "Export chat");
    menu.replaceChildren(
        head,
        item("Markdown", ".md", () => exportChat("md")),
        item(t("纯文本", "Plain text"), ".txt", () => exportChat("txt")),
        item("JSON", ".json", () => exportChat("json")),
        item(t("复制为 Markdown", "Copy as Markdown"), "", () => void copyMarkdown()),
    );
    overlay.host.hidden = false;
    const anchor = button.getBoundingClientRect();
    const width = menu.offsetWidth || 200;
    overlay.host.style.left = `${Math.round(Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)))}px`;
    overlay.host.style.top = `${Math.round(anchor.bottom + 6)}px`;
    button.setAttribute("aria-expanded", "true");
    menu.querySelector<HTMLElement>("button")?.focus();
}

function headerIcon(native: SVGElement | null): SVGSVGElement {
    const svg = svgIcon(Icons.download);
    svg.setAttribute("stroke-width", "1.5");
    const classes = native?.getAttribute("class")?.split(/\s+/).filter(name => /^x[0-9a-z]+$/.test(name));
    if (classes?.length) svg.setAttribute("class", classes.join(" "));
    const ink = (native as SVGElement & { style: CSSStyleDeclaration } | null)?.style.fill || "currentColor";
    svg.style.cssText = `width:20px;height:20px;display:block;flex-shrink:0;fill:none;stroke:${ink}`;
    return svg;
}

function makeButton(row: HTMLElement): HTMLElement | null {
    const sample = headerSample(row);
    const sampleWrapper = sample?.parentElement;
    if (!sample || !sampleWrapper) return null;
    const wrapper = sampleWrapper.cloneNode(false) as HTMLElement;
    wrapper.removeAttribute("data-popup-origin");
    wrapper.setAttribute(EXPORT_MARK, "");
    const btn = sample.cloneNode(false) as HTMLElement;
    for (const name of ["id", "aria-pressed", "aria-expanded", "aria-haspopup", "aria-disabled", "data-testid"]) btn.removeAttribute(name);
    const label = t("导出对话", "Export chat");
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.tabIndex = 0;
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.append(headerIcon(sample.querySelector("svg")));
    btn.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (menuOpen()) closeMenu();
        else openMenu();
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

function removeButton() {
    document.querySelector(`[${EXPORT_MARK}]`)?.remove();
    button = null;
    closeMenu();
}

export function sync() {
    const row = settings.store.headerButton && currentChatId() ? controlRow() : null;
    let wrapper = document.querySelector<HTMLElement>(`[${EXPORT_MARK}]`);
    if (!row) return removeButton();
    if (wrapper && !row.contains(wrapper)) {
        wrapper.remove();
        wrapper = null;
    }
    wrapper ??= makeButton(row);
    if (wrapper) placeButton(row, wrapper, [LIST_MARK]);
}

export default definePlugin({
    name: "exportChat",
    title: { zh: "导出对话", en: "Export chat" },
    description: {
        zh: "把当前对话导出为 Markdown、纯文本或 JSON，或复制为 Markdown。入口在对话右上角，只包含页面上已加载的消息。",
        en: "Export the open chat as Markdown, plain text or JSON, or copy it as Markdown, from the chat's top-right controls. Only messages loaded on the page are included.",
    },
    icon: Icons.download,
    tags: ["chat"],
    enabledByDefault: true,
    updatedAt: "2026-10-24",
    settings,
    start() {
        const resync = debounce(sync, 150, 600);
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || !menuOpen()) return;
            event.stopPropagation();
            closeMenu();
            button?.focus();
        };
        const onDown = (event: PointerEvent) => {
            if (!menuOpen()) return;
            const path = event.composedPath();
            if ((button && path.includes(button)) || (overlay && path.includes(overlay.host))) return;
            closeMenu();
        };
        document.addEventListener("keydown", onKey, true);
        document.addEventListener("pointerdown", onDown, true);
        cleanups = [
            onDomChange(mutations => {
                if (mutations.every(m => [...m.addedNodes, ...m.removedNodes].every(node => node instanceof Element && (node.hasAttribute(EXPORT_MARK) || node.id === HOST_ID)))) return;
                resync();
            }),
            onRouteChange(() => {
                closeMenu();
                resync();
            }),
            () => resync.cancel(),
            () => document.removeEventListener("keydown", onKey, true),
            () => document.removeEventListener("pointerdown", onDown, true),
        ];
        sync();
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        removeButton();
        overlay?.destroy();
        overlay = null;
    },
    onSettingsChange(key) {
        if (key === "headerButton") sync();
    },
});
