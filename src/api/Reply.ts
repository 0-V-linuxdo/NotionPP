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

let state: ReplyState = "idle";
let failed = false;
let chatId = "";
let users = 0;
let stopDom: (() => void) | null = null;
let stopNet: (() => void) | null = null;

export const currentChatId = () => new URL(pageWindow.location.href).searchParams.get("t") ?? "";
export const replyState = () => state;

function check() {
    const streaming = !!document.querySelector(STOP_BUTTON);
    if (streaming && state === "idle") {
        state = "streaming";
        failed = false;
        chatId = currentChatId();
        emit("replyStart", { chatId });
    } else if (!streaming && state === "streaming") {
        state = "idle";
        // A new chat only gets its id once the reply starts; take the latest one.
        emit("replyEnd", { chatId: currentChatId() || chatId, error: failed });
    }
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
        state = "idle";
    };
}
