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
/**
 * What each star pointed at when it was set: the chat's title and a snippet of the message, so
 * the lists can show stars whose messages are not on screen, including other chats'.
 */
export const STAR_META_KEY = "notionai-pp:star-meta:v1";

export interface StarMeta {
    role: "user" | "assistant";
    text: string;
    at: number;
}

export interface ChatMeta {
    title: string;
    items: Record<string, StarMeta>;
}

let active = false;

/** The navigator only shows stars while the stars plugin is on. */
export const starsActive = () => active;
export function setStarsActive(value: boolean) {
    if (active === value) return;
    active = value;
    emit("starsChanged", undefined);
}

function readJson(key: string): Record<string, unknown> {
    try {
        const data = safeJson(pageWindow.localStorage.getItem(key) ?? "");
        return isRecord(data) ? data : {};
    } catch {
        return {};
    }
}

function writeJson(key: string, value: unknown) {
    try {
        pageWindow.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
}

export function readAll(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [chat, ids] of Object.entries(readJson(STARS_KEY))) {
        if (Array.isArray(ids)) out[chat] = ids.filter((id): id is string => typeof id === "string");
    }
    return out;
}

export function readMeta(): Record<string, ChatMeta> {
    const out: Record<string, ChatMeta> = {};
    for (const [chat, value] of Object.entries(readJson(STAR_META_KEY))) {
        if (!isRecord(value) || !isRecord(value.items)) continue;
        const items: Record<string, StarMeta> = {};
        for (const [id, item] of Object.entries(value.items)) {
            if (isRecord(item) && typeof item.text === "string") {
                items[id] = { role: item.role === "assistant" ? "assistant" : "user", text: item.text, at: typeof item.at === "number" ? item.at : 0 };
            }
        }
        out[chat] = { title: typeof value.title === "string" ? value.title : "", items };
    }
    return out;
}

export const starsOf = (chatId: string) => new Set(chatId ? readAll()[chatId] ?? [] : []);

export const SNIPPET_MAX = 200;

/** Records (or refreshes) what a starred message says; a no-op when nothing changed. */
export function noteStar(chatId: string, id: string, info: { role: "user" | "assistant"; text: string; title: string }) {
    if (!chatId) return;
    const meta = readMeta();
    const chat = meta[chatId] ?? { title: "", items: {} };
    const text = info.text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
    const old = chat.items[id];
    if (old && old.text === text && (!info.title || chat.title === info.title)) return;
    chat.items[id] = { role: info.role, text, at: old?.at || Date.now() };
    if (info.title) chat.title = info.title;
    meta[chatId] = chat;
    writeJson(STAR_META_KEY, meta);
}

function dropMeta(chatId: string, id: string) {
    const meta = readMeta();
    if (!meta[chatId]?.items[id]) return;
    delete meta[chatId].items[id];
    if (!Object.keys(meta[chatId].items).length) delete meta[chatId];
    writeJson(STAR_META_KEY, meta);
}

export function toggleStar(chatId: string, id: string, info?: { role: "user" | "assistant"; text: string; title: string }): boolean {
    if (!chatId) return false;
    const all = readAll();
    const ids = new Set(all[chatId] ?? []);
    const starred = !ids.delete(id);
    if (starred) ids.add(id);
    if (ids.size) all[chatId] = [...ids];
    else delete all[chatId];
    writeJson(STARS_KEY, all);
    if (starred && info) noteStar(chatId, id, info);
    if (!starred) dropMeta(chatId, id);
    emit("starsChanged", undefined);
    return starred;
}

/** Every chat with stars, most recently starred first, each with its stars in the order they were set. */
export function allStarredChats(): { chatId: string; title: string; stars: { id: string; meta: StarMeta | null }[] }[] {
    const meta = readMeta();
    return Object.entries(readAll())
        .map(([chatId, ids]) => ({
            chatId,
            title: meta[chatId]?.title ?? "",
            stars: ids.map(id => ({ id, meta: meta[chatId]?.items[id] ?? null })),
        }))
        .filter(chat => chat.stars.length)
        .sort((a, b) => latest(b) - latest(a));
}

const latest = (chat: { stars: { meta: StarMeta | null }[] }) => Math.max(0, ...chat.stars.map(star => star.meta?.at ?? 0));
