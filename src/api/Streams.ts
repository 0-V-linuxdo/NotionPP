/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { sameChat } from "@api/Chats";
import { onDomChange } from "@api/DomWatch";
import { emit } from "@api/Events";
import { type Exchange, observeNetwork } from "@api/Network";
import { currentChatId, currentChatTitle, STOP_BUTTON } from "@api/Reply";
import { onRouteChange } from "@api/Router";
import { isRecord, safeJson } from "@utils/guards";
import { debounce } from "@utils/time";

/*
 * Like Void++'s StreamEvents across every chat, not only the open one. Reply.ts reads the stop
 * button, which only exists for the chat on screen; leave it mid-reply and how that reply ends is
 * lost. Each reply is one runInferenceTranscript request whose response streams until the reply
 * is written, so following that response tells when any chat's reply finishes, wherever the user
 * is by then. Only the page's own requests are read; nothing extra is sent.
 */

const INFERENCE_PATH = /\/api\/v3\/runInferenceTranscript$/;
const THREAD_KEYS = new Set(["threadId", "thread_id", "threadID"]);
const ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** How long a brand-new chat may take to show its id in the URL after the first send. */
const NEW_CHAT_ID_MS = 10_000;

export type StreamStatus = "done" | "error" | "aborted";

export interface LiveStream {
    sequence: number;
    /** The chat's id, or "" until a brand-new chat gets one. */
    chatId: string;
    title: string;
    startedAt: number;
    /** The user pressed stop in this chat while it was writing. */
    stopped: boolean;
}

/** The chat a request belongs to, as its body names it: the first thread id within a few levels. */
export function threadIdOf(body: string): string {
    const parsed = safeJson(body);
    const walk = (value: unknown, depth: number): string => {
        if (depth > 3 || !value || typeof value !== "object") return "";
        if (isRecord(value)) {
            for (const [key, item] of Object.entries(value)) {
                if (THREAD_KEYS.has(key) && typeof item === "string" && ID_RE.test(item)) return item;
            }
        }
        for (const item of Object.values(value as object)) {
            const found = walk(item, depth + 1);
            if (found) return found;
        }
        return "";
    };
    return walk(parsed, 0);
}

/** In the `t` parameter's spelling when the request is for the chat on screen. */
export function chatIdFor(threadId: string, current: string): string {
    if (!threadId) return current;
    if (sameChat(threadId, current)) return current;
    return threadId.replace(/-/g, "").toLowerCase();
}

const live = new Map<number, LiveStream>();
let users = 0;
let cleanups: (() => void)[] = [];

export const liveStreams = () => [...live.values()];

export const isChatLive = (chatId: string) => liveStreams().some(stream => sameChat(stream.chatId, chatId));

function refreshTitles() {
    const current = currentChatId();
    if (!current) return;
    const title = currentChatTitle();
    for (const stream of live.values()) {
        // Only a chat that was new when it was sent; later the user may simply have opened another one.
        if (!stream.chatId && Date.now() - stream.startedAt < NEW_CHAT_ID_MS) stream.chatId = current;
        if (title && sameChat(stream.chatId, current)) stream.title = title;
    }
}

function finish(stream: LiveStream, status: StreamStatus) {
    if (!live.delete(stream.sequence)) return;
    refreshTitles();
    const current = currentChatId();
    emit("streamEnd", {
        chatId: stream.chatId,
        title: stream.title,
        status: stream.stopped && status !== "error" ? "aborted" : status,
        stopped: stream.stopped,
        elsewhere: !!stream.chatId && !sameChat(stream.chatId, current),
        durationMs: Date.now() - stream.startedAt,
    });
}

/** Waits for the response to finish streaming; a cut-off stream (stop, reload, network) is "aborted". */
export async function settle(exchange: Pick<Exchange, "response">): Promise<StreamStatus> {
    const response = await exchange.response;
    if (!response) return "aborted";
    if (!response.ok) return "error";
    try {
        await response.text();
        return "done";
    } catch (error) {
        // Too long to keep a copy of is still a reply that came to its end.
        return error instanceof Error && error.message === "response-too-large" ? "done" : "aborted";
    }
}

/** Follows one request to its end; exported for tests. */
export async function track(exchange: Pick<Exchange, "sequence" | "body" | "response">) {
    const current = currentChatId();
    const stream: LiveStream = {
        sequence: exchange.sequence,
        chatId: current,
        title: current ? currentChatTitle() : "",
        startedAt: Date.now(),
        stopped: false,
    };
    live.set(stream.sequence, stream);
    exchange.body.then(body => {
        const id = chatIdFor(threadIdOf(body), currentChatId() || current);
        if (id) stream.chatId = id;
    }, () => {});
    // The request body is read before the stream counts as started, so the chat id is known.
    await exchange.body.catch(() => "");
    if (live.has(stream.sequence)) emit("streamStart", { chatId: stream.chatId, title: stream.title });
    finish(stream, await settle(exchange));
}

function onPress(event: Event) {
    if (!(event.target as Element | null)?.closest?.(STOP_BUTTON)) return;
    const current = currentChatId();
    for (const stream of live.values()) if (sameChat(stream.chatId, current)) stream.stopped = true;
}

/** Starts following every chat's replies while at least one plugin needs it. Returns the release function. */
export function watchStreams() {
    if (users++ === 0) {
        const titles = debounce(refreshTitles, 300, 1000);
        document.addEventListener("click", onPress, true);
        cleanups = [
            observeNetwork({
                matches: (url, method) => method === "POST" && INFERENCE_PATH.test(url.pathname),
                onExchange: exchange => void track(exchange),
            }),
            // A new chat gets its id in the URL after the first send; titles settle a moment later.
            onRouteChange(refreshTitles),
            onDomChange(() => live.size && titles()),
            () => titles.cancel(),
            () => document.removeEventListener("click", onPress, true),
        ];
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--users > 0) return;
        for (const cleanup of cleanups.splice(0)) cleanup();
        live.clear();
    };
}
