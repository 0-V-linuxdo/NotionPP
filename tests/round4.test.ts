/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";

import { collectBackup, parseBackup, restoreBackup } from "@api/Backup";
import { on } from "@api/Events";
import { definePlugin, isNewPlugin, isRecentlyUpdated, NEW_FOR_MS, UPDATED_FOR_MS } from "@api/PluginManager";
import { STOP_BUTTON, watchReplies } from "@api/Reply";
import { type Bag, diffBags, getValue, SETTINGS_KEY } from "@api/Settings";
import { chatCodeBlocks, scan as foldScan } from "@plugins/codeFold/index";
import { capHistory, fill } from "@plugins/inputHistory/index";
import { chatUrl } from "@plugins/messageStars/list";
import { allStarredChats, readMeta, toggleStar } from "@plugins/messageStars/store";
import { attachmentLabel } from "@plugins/navigator/messages";
import { blockedSummary } from "@plugins/noTelemetry/index";

const until = async (check: () => boolean, ms = 3000) => {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error("timed out");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

describe("prompt history fixes", () => {
    test("walking back leaves the caret at the start, so the next ↑ goes on at once", () => {
        (document as any).execCommand ??= () => true;
        document.body.innerHTML = `<div contenteditable="true" id="ed"></div>`;
        const editor = document.getElementById("ed")!;
        // happy-dom has no execCommand: give the editor the text directly and check the caret only.
        editor.textContent = "hello";
        fill(editor, "", "start");
        const selection = document.getSelection()!;
        expect(selection.rangeCount).toBe(1);
        const range = selection.getRangeAt(0);
        expect(range.collapsed).toBe(true);
        expect(range.startOffset).toBe(0);
    });

    test("a smaller limit trims the oldest prompts", () => {
        expect(capHistory(["a", "b", "c"], 2)).toEqual(["b", "c"]);
        expect(capHistory(["a"], 5)).toEqual(["a"]);
    });
});

describe("backup", () => {
    test("collects only NotionAI++ data and restores it", () => {
        localStorage.clear();
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ widerChat: { width: 1300 } }));
        localStorage.setItem("notionai-pp:input-history:v1", JSON.stringify(["hi"]));
        localStorage.setItem("notionai-pp:health:v1", "{}");
        localStorage.setItem("someone-else", "x");
        const backup = collectBackup("test");
        expect(Object.keys(backup.data).sort()).toEqual([SETTINGS_KEY, "notionai-pp:input-history:v1"].sort());

        localStorage.clear();
        const data = parseBackup(JSON.stringify(backup))!;
        expect(restoreBackup(data)).toBe(2);
        expect(localStorage.getItem("notionai-pp:input-history:v1")).toBe(JSON.stringify(["hi"]));
        expect(getValue("widerChat", "width")).toBe(1300);
    });

    test("refuses files that are not a backup, and foreign keys inside one", () => {
        expect(parseBackup("{}")).toBeNull();
        expect(parseBackup("not json")).toBeNull();
        const parsed = parseBackup(JSON.stringify({ format: "notionai-pp-backup", data: { "evil:key": "1", "notionai-pp:stars:v1": "{}" } }));
        expect(parsed).toEqual({ "notionai-pp:stars:v1": "{}" });
    });
});

describe("settings sync between tabs", () => {
    test("announces only what changed, enabled first", () => {
        const before: Bag = { a: { enabled: false, x: 1 }, b: { y: "k" } };
        const after: Bag = { a: { x: 2, enabled: true }, b: { y: "k" }, c: { z: true } };
        expect(diffBags(before, after)).toEqual([["a", "enabled"], ["a", "x"], ["c", "z"]]);
    });
});

describe("reply watcher", () => {
    test("pressing stop is reported as stopped, not finished", async () => {
        history.replaceState(null, "", "/chat?t=abc");
        const ends: { stopped: boolean; left: boolean }[] = [];
        const off = on("replyEnd", ({ stopped, left }) => void ends.push({ stopped, left }));
        const release = watchReplies();
        document.body.innerHTML = `<div data-notion-chat-input-container><div role="button" data-testid="agent-stop-inference-button"></div></div>`;
        await new Promise(resolve => setTimeout(resolve, 50));
        const stop = document.querySelector<HTMLElement>(STOP_BUTTON)!;
        stop.click();
        stop.remove();
        await until(() => ends.length === 1);
        release();
        off();
        expect(ends[0]).toEqual({ stopped: true, left: false });
    });

    test("a stop button that blinks out and back does not end the reply", async () => {
        history.replaceState(null, "", "/chat?t=abc");
        let ends = 0;
        const off = on("replyEnd", () => void ends++);
        const release = watchReplies();
        document.body.innerHTML = `<div data-notion-chat-input-container><div role="button" data-testid="agent-stop-inference-button"></div></div>`;
        await new Promise(resolve => setTimeout(resolve, 50));
        const container = document.querySelector("[data-notion-chat-input-container]")!;
        const stop = container.firstElementChild!;
        stop.remove();
        await new Promise(resolve => setTimeout(resolve, 100));
        // A fresh node, as Notion renders one (happy-dom stops reporting a node once it is re-inserted).
        const again = stop.cloneNode() as HTMLElement;
        container.append(again);
        await new Promise(resolve => setTimeout(resolve, 600));
        expect(ends).toBe(0);
        again.remove();
        await until(() => ends === 1);
        release();
        off();
    });
});

describe("new and recently updated plugins", () => {
    test("a recent updatedAt counts, an old one does not", () => {
        const now = Date.parse("2026-10-10");
        const fresh = definePlugin({ name: "freshForTest", title: "", description: "", enabledByDefault: false, updatedAt: "2026-10-08", start() {}, stop() {} });
        const old = definePlugin({ name: "oldForTest", title: "", description: "", enabledByDefault: false, updatedAt: "2026-09-01", start() {}, stop() {} });
        expect(isRecentlyUpdated(fresh, now)).toBe(true);
        expect(isRecentlyUpdated(old, now)).toBe(false);
        expect(UPDATED_FOR_MS).toBeGreaterThan(NEW_FOR_MS);
        expect(isNewPlugin("neverSeenForTest", now)).toBe(false);
    });
});

describe("stars", () => {
    test("keep a snippet and the chat title, listed across chats", () => {
        localStorage.clear();
        toggleStar("chat1", "m1", { role: "user", text: "first   question", title: "Chat one" });
        toggleStar("chat2", "m2:assistant", { role: "assistant", text: "an answer", title: "Chat two" });
        expect(readMeta().chat1.items.m1.text).toBe("first question");
        const chats = allStarredChats();
        expect(chats.map(chat => chat.title).sort()).toEqual(["Chat one", "Chat two"]);
        toggleStar("chat1", "m1");
        expect(readMeta().chat1).toBeUndefined();
        expect(allStarredChats().map(chat => chat.chatId)).toEqual(["chat2"]);
    });

    test("another chat's url keeps the page and swaps the chat id", () => {
        expect(chatUrl("xyz", "https://app.notion.com/chat?t=abc&wr=1")).toBe("https://app.notion.com/chat?t=xyz&wr=1");
    });
});

describe("outline labels", () => {
    test("a prompt with only an image or a file still gets a label", () => {
        document.body.innerHTML = `<div id="a"><img width="200" src="x.png"></div><div id="b"><a href="/f" download>f.pdf</a></div><div id="c"></div>`;
        expect(attachmentLabel(document.getElementById("a")!)).toBe("[Image]");
        expect(attachmentLabel(document.getElementById("b")!)).toBe("[Attachment]");
        expect(attachmentLabel(document.getElementById("c")!)).toBe("");
    });
});

describe("telemetry counts", () => {
    test("summary lists every kind", () => {
        const text = blockedSummary({ events: 3, experiments: 1, logs: 0, errors: 2 });
        expect(text).toContain("6");
        expect(text.split("\n").length).toBe(6);
    });
});

describe("code folding", () => {
    test("only the chat's code blocks, never the composer's", () => {
        document.body.innerHTML = `<div data-agent-chat-user-step-id="u1"></div><pre id="reply">a</pre>
          <div data-notion-chat-input-container><pre id="draft">b</pre></div>`;
        expect(chatCodeBlocks().map(block => block.id)).toEqual(["reply"]);
    });

    test("a tall block is folded with a bar to open it", () => {
        document.body.innerHTML = `<div data-agent-chat-user-step-id="u1"></div><pre id="reply">${"line\n".repeat(80)}</pre>`;
        const block = document.getElementById("reply")!;
        Object.defineProperty(block, "scrollHeight", { value: 2000 });
        foldScan();
        expect(block.getAttribute("data-npp-fold")).toBe("folded");
        const bar = block.nextElementSibling as HTMLElement;
        bar.click();
        expect(block.getAttribute("data-npp-fold")).toBe("open");
    });
});
