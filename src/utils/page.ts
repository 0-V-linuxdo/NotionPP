/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { getValue } from "@api/Settings";

declare const unsafeWindow: (Window & typeof globalThis) | undefined;

export const pageWindow: Window & typeof globalThis =
    typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

const NOTION_HOSTS = new Set(["app.notion.com", "www.notion.so", "notion.so"]);

export function isNotionUrl(value: unknown): boolean {
    try {
        const url = new URL(String(value));
        return url.protocol === "https:" && NOTION_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
}

export function isTopmostNotionDocument(win: Window = pageWindow): boolean {
    if (!isNotionUrl(win.location.href)) return false;
    const ancestors = win.location.ancestorOrigins;
    if (ancestors) {
        for (let index = 0; index < ancestors.length; index++) {
            if (isNotionUrl(ancestors[index])) return false;
        }
    }
    let current: Window = win;
    for (let depth = 0; depth < 32; depth++) {
        let parent: Window;
        try {
            parent = current.parent;
        } catch {
            return true;
        }
        if (!parent || parent === current) return true;
        try {
            if (isNotionUrl(parent.location.href)) return false;
        } catch {
            return true;
        }
        current = parent;
    }
    return true;
}

export const isAiRoute = (pathname = pageWindow.location.pathname) => /^\/(?:ai|chat)(?:\/|$)/i.test(pathname);

/** The language chosen in NotionAI++'s settings, else Notion's own UI language. */
export function uiLanguage(): "zh" | "en" {
    const chosen = getValue("settings", "language");
    if (chosen === "zh" || chosen === "en") return chosen;
    return /^zh(?:-|$)/i.test(document.documentElement?.lang ?? "") ? "zh" : "en";
}

export const t = (zh: string, en: string) => (uiLanguage() === "zh" ? zh : en);

/** User-facing text: one string for both languages, or a translation per language. */
export type Text = string | { zh: string; en: string };

export const tr = (text: Text) => (typeof text === "string" ? text : t(text.zh, text.en));

export function trustedHtml(html: string): string {
    const policy = (globalThis as any).ADG_policyApi;
    try {
        if (policy && typeof policy.createHTML === "function") return policy.createHTML(html);
    } catch {}
    return html;
}
