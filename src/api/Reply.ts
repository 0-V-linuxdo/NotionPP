/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { emit } from "@api/Events";
import { observeNetwork } from "@api/Network";
import { pageWindow } from "@utils/page";

/*
 * Whether Notion AI is writing a reply, as Void++'s StreamEvents tells plugins. While a reply
 * streams the composer's send button is swapped for a stop button; that swap is the signal.
 * The request behind it, runInferenceTranscript, failing marks the reply as an error.
 */

export const STOP_BUTTON = "[data-testid='agent-stop-inference-button']";
const INFERENCE_PATH = /\/api\/v3\/runInferenceTranscript$/;

export type ReplyState = "idle" | "streaming";

/** The stop button can blink out while Notion re-renders the composer; only a lasting absence ends a reply. */
export const END_GRACE_MS = 400;

let state: ReplyState = "idle";
let failed = false;
let stopped = false;
let chatId = "";
let endTimer = 0;
let users = 0;
let stopDom: (() => void) | null = null;
let stopNet: (() => void) | null = null;

export const currentChatId = () => new URL(pageWindow.location.href).searchParams.get("t") ?? "";
export const replyState = () => state;
/** The open chat's title, as the browser tab shows it without the " | Notion" suffix. */
export const currentChatTitle = () => document.title.replace(/\s*\|\s*Notion\s*$/, "").trim();

function check() {
    const streaming = !!document.querySelector(STOP_BUTTON);
    if (streaming) {
        clearTimeout(endTimer);
        endTimer = 0;
        if (state === "idle") {
            state = "streaming";
            failed = false;
            stopped = false;
            chatId = currentChatId();
            emit("replyStart", { chatId });
        }
    } else if (state === "streaming" && !endTimer) {
        endTimer = setTimeout(finish, END_GRACE_MS) as unknown as number;
    }
}

function finish() {
    endTimer = 0;
    if (state !== "streaming" || document.querySelector(STOP_BUTTON)) return;
    state = "idle";
    const now = currentChatId();
    // A new chat only gets its id once the reply starts; take the latest one.
    emit("replyEnd", { chatId: now || chatId, error: failed, stopped, left: !!chatId && !!now && now !== chatId });
}

function onPress(event: Event) {
    if ((event.target as Element | null)?.closest?.(STOP_BUTTON)) stopped = true;
}

/** Starts watching while at least one plugin needs it. Returns the release function. */
export function watchReplies() {
    if (users++ === 0) {
        stopDom = onDomChange(check);
        stopNet = observeNetwork({
            matches: (url, method) => method === "POST" && INFERENCE_PATH.test(url.pathname),
            onExchange(exchange) {
                void exchange.response.then(response => {
                    if (!response?.ok) failed = true;
                });
            },
        });
        document.addEventListener("click", onPress, true);
        check();
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--users > 0) return;
        stopDom?.();
        stopNet?.();
        stopDom = stopNet = null;
        document.removeEventListener("click", onPress, true);
        clearTimeout(endTimer);
        endTimer = 0;
        state = "idle";
    };
}
