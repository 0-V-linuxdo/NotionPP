/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";

import { chatKey, chatUrl, sameChat } from "@api/Chats";
import { type EventMap, on } from "@api/Events";
import { chatIdFor, settle, threadIdOf, track, watchStreams } from "@api/Streams";
import { dismissAllToasts, dismissToast, showToast, toastKeys } from "@api/Toast";
import { shouldToast, toastKey } from "@plugins/chatDoneToast/index";
import { type ExportedChat, fileName, gather, render } from "@plugins/exportChat/index";
import { toMarkdown } from "@plugins/exportChat/markdown";
import { isTrigger, switcherItems } from "@plugins/recentChats/index";
import { describe as describeChat, touch } from "@plugins/recentChats/store";

const A = "2a1b3c4d5e6f708192a3b4c5d6e7f809";
const A_DASHED = "2a1b3c4d-5e6f-7081-92a3-b4c5d6e7f809";
const B = "ffffffffffffffffffffffffffffffff";

describe("chat ids", () => {
    test("the URL and API spellings name the same chat", () => {
        expect(chatKey(A_DASHED)).toBe(A);
        expect(sameChat(A, A_DASHED)).toBe(true);
        expect(sameChat(A, B)).toBe(false);
        expect(sameChat("", "")).toBe(false);
        expect(new URL(chatUrl(A, "https://app.notion.com/ai?t=old&x=1")).searchParams.get("t")).toBe(A);
    });
});

describe("streams across chats", () => {
    test("finds the thread id in a request body", () => {
        expect(threadIdOf(JSON.stringify({ threadId: A_DASHED, transcript: [] }))).toBe(A_DASHED);
        expect(threadIdOf(JSON.stringify({ context: { thread_id: A } }))).toBe(A);
        expect(threadIdOf(JSON.stringify({ threadId: "not-an-id" }))).toBe("");
        expect(threadIdOf("not json")).toBe("");
        expect(chatIdFor(A_DASHED, A)).toBe(A);
        expect(chatIdFor(A_DASHED, "")).toBe(A);
        expect(chatIdFor("", B)).toBe(B);
    });

    test("a response's end decides how the reply ended", async () => {
        const ok = (text: () => Promise<string>) => ({ response: Promise.resolve({ ok: true, status: 200, text }) });
        expect(await settle(ok(async () => "{}"))).toBe("done");
        expect(await settle(ok(async () => { throw new Error("response-too-large"); }))).toBe("done");
        expect(await settle(ok(async () => { throw new DOMException("aborted", "AbortError"); }))).toBe("aborted");
        expect(await settle({ response: Promise.resolve(null) })).toBe("aborted");
        expect(await settle({ response: Promise.resolve({ ok: false, status: 500, text: async () => "" }) })).toBe("error");
    });

    test("a reply finishing after the user left its chat is reported as elsewhere", async () => {
        history.replaceState(null, "", `/ai?t=${A}`);
        document.title = "Plan the trip | Notion";
        const events: EventMap["streamEnd"][] = [];
        const off = on("streamEnd", event => void events.push(event));
        const release = watchStreams();
        let finish!: (text: string) => void;
        const body = new Promise<string>(resolve => resolve(JSON.stringify({ threadId: A_DASHED })));
        const tracked = track({
            sequence: 9001,
            body,
            response: Promise.resolve({ ok: true, status: 200, text: () => new Promise<string>(resolve => (finish = resolve)) }),
        });
        await new Promise(resolve => setTimeout(resolve, 10));
        history.replaceState(null, "", `/ai?t=${B}`);
        document.title = "Something else | Notion";
        finish("{}");
        await tracked;
        release();
        off();
        expect(events.length).toBe(1);
        expect(events[0]).toMatchObject({ chatId: A, title: "Plan the trip", status: "done", stopped: false, elsewhere: true });
    });
});

describe("toasts", () => {
    test("a key keeps one card, updated in place", () => {
        dismissAllToasts();
        showToast({ key: "k", title: "first", duration: 0 });
        showToast({ key: "k", title: "second", duration: 0 });
        expect(toastKeys()).toEqual(["k"]);
        const host = document.getElementById("notionai-pp-toasts")!;
        expect(host.shadowRoot!.querySelectorAll(".toast").length).toBe(1);
        expect(host.shadowRoot!.querySelector(".title")!.textContent).toBe("second");
        dismissToast("k");
        expect(toastKeys()).toEqual([]);
        expect(document.getElementById("notionai-pp-toasts")).toBeNull();
    });

    test("clicking runs the action and closes; timers close on their own", async () => {
        dismissAllToasts();
        let clicked = 0;
        showToast({ key: "c", title: "click me", duration: 0, onClick: () => clicked++ });
        document.getElementById("notionai-pp-toasts")!.shadowRoot!.querySelector<HTMLElement>(".toast")!.click();
        expect(clicked).toBe(1);
        expect(toastKeys()).toEqual([]);
        showToast({ key: "t", title: "brief", duration: 30 });
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(toastKeys()).toEqual([]);
    });

    test("only replies written while away get a chat toast", () => {
        const base = { chatId: A, title: "x", status: "done" as const, stopped: false, elsewhere: true, durationMs: 1 };
        expect(shouldToast(base, true)).toBe(true);
        expect(shouldToast({ ...base, elsewhere: false }, true)).toBe(false);
        expect(shouldToast({ ...base, stopped: true }, true)).toBe(false);
        expect(shouldToast({ ...base, status: "aborted" }, true)).toBe(false);
        expect(shouldToast({ ...base, status: "error" }, true)).toBe(true);
        expect(shouldToast({ ...base, status: "error" }, false)).toBe(false);
        expect(toastKey(A_DASHED)).toBe(toastKey(A));
    });
});

describe("export", () => {
    test("Notion blocks become Markdown", () => {
        const root = document.createElement("div");
        root.innerHTML = `
          <div class="notion-header-block"><div data-content-editable-leaf>Title</div></div>
          <div class="notion-text-block"><div data-content-editable-leaf>Some <span style="font-weight:600">bold</span> and <a href="https://example.com">a link</a>.</div></div>
          <div class="notion-bulleted_list-block"><div data-content-editable-leaf>one</div></div>
          <div class="notion-bulleted_list-block"><div data-content-editable-leaf>two</div></div>
          <div class="notion-numbered_list-block"><div data-content-editable-leaf>first</div></div>
          <div class="notion-numbered_list-block"><div data-content-editable-leaf>second</div></div>
          <div class="notion-code-block"><div role="button">Copy</div><code class="language-js">let a = 1;</code></div>
          <div class="notion-quote-block"><div data-content-editable-leaf>quoted</div></div>
          <div class="notion-divider-block"></div>`;
        expect(toMarkdown(root)).toBe([
            "# Title",
            "",
            "Some **bold** and [a link](https://example.com).",
            "",
            "- one",
            "- two",
            "",
            "1. first",
            "2. second",
            "",
            "```js",
            "let a = 1;",
            "```",
            "",
            "> quoted",
            "",
            "---",
        ].join("\n"));
    });

    test("plain HTML replies become Markdown too", () => {
        const root = document.createElement("div");
        root.innerHTML = `<h2>Head</h2><p>Text with <code>code</code> and <em>style</em>.</p><ul><li>a<ul><li>b</li></ul></li></ul>
          <table><tr><th>k</th><th>v</th></tr><tr><td>1</td><td>2</td></tr></table>`;
        expect(toMarkdown(root)).toBe([
            "## Head",
            "",
            "Text with `code` and *style*.",
            "",
            "- a",
            "   - b",
            "",
            "| k | v |",
            "| --- | --- |",
            "| 1 | 2 |",
        ].join("\n"));
    });

    test("renders each format, one entry per message", () => {
        const reply = document.createElement("div");
        reply.innerHTML = `<p>The <strong>answer</strong></p>`;
        const user = document.createElement("div");
        const messages = gather([
            { id: "u1", role: "user", element: user, text: "> quoted\nmy question" },
            { id: "u1:assistant", role: "assistant", element: reply, text: "The answer" },
            { id: "u1", role: "user", element: user, text: "duplicate" },
        ]);
        expect(messages.map(m => m.markdown)).toEqual(["> quoted\nmy question", "The **answer**"]);
        const chat: ExportedChat = { title: "T", chatId: A, url: "https://app.notion.com/ai", exportedAt: "2026-10-24T00:00:00.000Z", messages };
        const md = render(chat, "md");
        expect(md).toContain("# T");
        expect(md).toContain("> quoted  \nmy question");
        expect(md).toContain("The **answer**");
        const txt = render(chat, "txt");
        expect(txt).toContain("The answer");
        expect(txt).not.toContain("**");
        expect(JSON.parse(render(chat, "json")).messages).toHaveLength(2);
        expect(fileName("a/b: c?", "md", new Date(2026, 9, 24))).toBe("a b c 2026-10-24.md");
        expect(fileName("", "json", new Date(2026, 0, 2))).toBe("Notion AI chat 2026-01-02.json");
    });

    test("the export and star header buttons settle without moving each other", async () => {
        const { placeButton, LIST_MARK } = await import("../src/plugins/messageStars/list");
        document.body.innerHTML = `<div id="row">
            <div id="group"><div data-popup-origin="true"><div role="button" aria-label="Start new chat"></div></div></div>
            <div data-popup-origin="true"><div role="button" aria-label="Pin chat"></div></div>
        </div>`;
        const row = document.getElementById("row")!;
        const star = document.createElement("div");
        star.id = "star";
        star.setAttribute(LIST_MARK, "");
        const exp = document.createElement("div");
        exp.id = "export";
        exp.setAttribute("data-npp-export", "");
        let moves = 0;
        const observer = new MutationObserver(records => void (moves += records.length));
        for (let round = 0; round < 3; round++) {
            placeButton(row, star);
            placeButton(row, exp, [LIST_MARK]);
            if (round === 0) observer.observe(row, { childList: true, subtree: true });
        }
        await new Promise(resolve => setTimeout(resolve, 0));
        observer.disconnect();
        expect(moves).toBe(0);
        const group = document.getElementById("group")!;
        expect([...group.children].map(c => c.id || c.querySelector("[aria-label]")?.getAttribute("aria-label"))).toEqual(["export", "star", "Start new chat"]);
    });
});

describe("recent chats", () => {
    test("opening moves a chat to the front; details update in place", () => {
        let list = touch([], A, 1);
        list = touch(list, B, 2);
        list = describeChat(list, A, { title: "Trip", question: "where?" });
        expect(list.map(item => item.id)).toEqual([B, A]);
        expect(list[1]).toMatchObject({ title: "Trip", question: "where?", at: 1 });
        list = touch(list, A_DASHED, 3);
        expect(list.map(item => chatKey(item.id))).toEqual([A, B]);
        expect(list).toHaveLength(2);
        // Nothing new: the same list comes back, so nothing is written.
        expect(describeChat(list, A, { title: "Trip" })).toBe(list);
    });

    test("the open chat comes first, then the rest up to the limit", () => {
        const list = [B, A, "c", "d"].map((id, i) => ({ id, title: id, question: "", reply: "", at: 10 - i }));
        expect(switcherItems(list, A, 3).map(item => item.id)).toEqual([A, B, "c"]);
        expect(switcherItems(list, "", 2).map(item => item.id)).toEqual([B, A]);
    });

    test("only Ctrl+` opens the switcher", () => {
        const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
        expect(isTrigger(key({ ctrlKey: true, code: "Backquote", key: "`" }))).toBe(true);
        expect(isTrigger(key({ ctrlKey: true, shiftKey: true, code: "Backquote", key: "~" }))).toBe(true);
        expect(isTrigger(key({ code: "Backquote", key: "`" }))).toBe(false);
        expect(isTrigger(key({ ctrlKey: true, metaKey: true, code: "Backquote", key: "`" }))).toBe(false);
    });
});
