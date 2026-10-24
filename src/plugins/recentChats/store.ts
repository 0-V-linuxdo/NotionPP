/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { sameChat } from "@api/Chats";
import { isRecord } from "@utils/guards";
import { pageWindow } from "@utils/page";

/** Recently opened chats, most recent first, kept in this browser only. */
export const RECENT_KEY = "notionai-pp:recent-chats:v1";
export const MAX_STORED = 30;

export interface RecentChat {
    id: string;
    title: string;
    /** The last question and reply seen in it, shortened. */
    question: string;
    reply: string;
    /** When it was last opened. */
    at: number;
}

export function readRecent(): RecentChat[] {
    try {
        const parsed = JSON.parse(pageWindow.localStorage.getItem(RECENT_KEY) ?? "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is RecentChat => isRecord(item) && typeof item.id === "string" && !!item.id)
            .map(item => ({
                id: item.id,
                title: typeof item.title === "string" ? item.title : "",
                question: typeof item.question === "string" ? item.question : "",
                reply: typeof item.reply === "string" ? item.reply : "",
                at: typeof item.at === "number" ? item.at : 0,
            }));
    } catch {
        return [];
    }
}

function write(list: RecentChat[]) {
    try {
        pageWindow.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_STORED)));
    } catch {}
}

/** Moves a chat to the front, as just opened. */
export function touch(list: RecentChat[], id: string, now = Date.now()): RecentChat[] {
    const found = list.find(item => sameChat(item.id, id));
    const entry: RecentChat = found ? { ...found, id, at: now } : { id, title: "", question: "", reply: "", at: now };
    return [entry, ...list.filter(item => item !== found)].slice(0, MAX_STORED);
}

/** Refreshes what a chat shows (title, last question and reply) without changing its place. */
export function describe(list: RecentChat[], id: string, info: Partial<Pick<RecentChat, "title" | "question" | "reply">>): RecentChat[] {
    let changed = false;
    const next = list.map(item => {
        if (!sameChat(item.id, id)) return item;
        const merged = { ...item };
        for (const key of ["title", "question", "reply"] as const) {
            const value = info[key];
            if (value && value !== item[key]) {
                merged[key] = value;
                changed = true;
            }
        }
        return merged;
    });
    return changed ? next : list;
}

export function saveRecent(list: RecentChat[]) {
    write(list);
}

export function clearRecent() {
    try {
        pageWindow.localStorage.removeItem(RECENT_KEY);
    } catch {}
}
