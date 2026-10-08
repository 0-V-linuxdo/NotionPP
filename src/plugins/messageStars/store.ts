/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { emit } from "@api/Events";
import { isRecord, safeJson } from "@utils/guards";
import { pageWindow } from "@utils/page";

/** Starred message ids per chat: `{ [chatId]: [messageId, …] }`, kept in this browser. */
export const STARS_KEY = "notionai-pp:stars:v1";

let active = false;

/** The navigator only shows stars while the stars plugin is on. */
export const starsActive = () => active;
export function setStarsActive(value: boolean) {
    if (active === value) return;
    active = value;
    emit("starsChanged", undefined);
}

function readAll(): Record<string, string[]> {
    try {
        const data = safeJson(pageWindow.localStorage.getItem(STARS_KEY) ?? "");
        if (!isRecord(data)) return {};
        const out: Record<string, string[]> = {};
        for (const [chat, ids] of Object.entries(data)) {
            if (Array.isArray(ids)) out[chat] = ids.filter((id): id is string => typeof id === "string");
        }
        return out;
    } catch {
        return {};
    }
}

export const starsOf = (chatId: string) => new Set(chatId ? readAll()[chatId] ?? [] : []);

export function toggleStar(chatId: string, id: string): boolean {
    if (!chatId) return false;
    const all = readAll();
    const ids = new Set(all[chatId] ?? []);
    const starred = !ids.delete(id);
    if (starred) ids.add(id);
    if (ids.size) all[chatId] = [...ids];
    else delete all[chatId];
    try {
        pageWindow.localStorage.setItem(STARS_KEY, JSON.stringify(all));
    } catch {}
    emit("starsChanged", undefined);
    return starred;
}
