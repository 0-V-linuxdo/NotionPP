/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from "bun:test";

import { on } from "@api/Events";
import { STOP_BUTTON, watchReplies } from "@api/Reply";
import { remember } from "@plugins/inputHistory/index";
import { messageIdFor, scan } from "@plugins/messageStars/index";
import { setStarsActive, STARS_KEY, starsOf, toggleStar } from "@plugins/messageStars/store";
import { columnOf, css } from "@plugins/widerChat/index";

const frame = () => new Promise(resolve => setTimeout(resolve, 40));

afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(STARS_KEY);
    history.replaceState(null, "", "/chat");
});

function chat() {
    document.body.innerHTML = `
      <div style="max-width: 798px; padding-inline: 52px">
        <div><div data-agent-chat-user-step-id="u1"><div>
          <div data-content-editable-leaf="true">first prompt</div>
          <div class="row"><div class="w"><div role="button" aria-label="Copy text"></div></div></div>
        </div></div></div>
        <div><div class="body">first reply</div>
          <div class="row"><div class="w"><div role="button" aria-label="Copy response"></div></div></div></div>
        <div><div data-agent-chat-user-step-id="u2"><div>
          <div data-content-editable-leaf="true">second prompt</div>
          <div class="row"><div class="w"><div role="button" aria-label="Copy text"></div></div></div>
        </div></div></div>
        <div><div class="body">second reply</div>
          <div class="row"><div class="w"><div role="button" aria-label="Copy response"></div></div></div></div>
      </div>`;
}

describe("reply watcher", () => {
    test("reports start and end from the composer's stop button", async () => {
        history.replaceState(null, "", "/chat?t=abc");
        const events: string[] = [];
        const offs = [
            on("replyStart", ({ chatId }) => void events.push(`start:${chatId}`)),
            on("replyEnd", ({ chatId, error }) => void events.push(`end:${chatId}:${error}`)),
        ];
        const release = watchReplies();
        document.body.innerHTML = `<div data-notion-chat-input-container><div role="button" data-testid="agent-stop-inference-button"></div></div>`;
        await frame();
        document.querySelector(STOP_BUTTON)!.remove();
        await frame();
        release();
        offs.forEach(off => off());
        expect(events).toEqual(["start:abc", "end:abc:false"]);
    });
});

describe("prompt history", () => {
    test("keeps the newest last, without repeats, up to the limit", () => {
        let list: string[] = [];
        for (const text of ["a", "b", "a", "  ", "c"]) list = remember(list, text, 2);
        expect(list).toEqual(["a", "c"]);
    });
});

describe("message stars", () => {
    test("maps copy buttons to the navigator's message ids", () => {
        chat();
        const steps = [...document.querySelectorAll<HTMLElement>("[data-agent-chat-user-step-id]")];
        const ids = [...document.querySelectorAll("[aria-label^='Copy']")].map(button => messageIdFor(button, steps));
        expect(ids).toEqual(["u1", "u1:assistant", "u2", "u2:assistant"]);
    });

    test("adds one star per toolbar and toggles it per chat", () => {
        chat();
        history.replaceState(null, "", "/chat?t=c1");
        setStarsActive(true);
        scan();
        scan();
        const stars = document.querySelectorAll<HTMLElement>("[data-npp-star]");
        expect(stars.length).toBe(4);
        (stars[1].firstElementChild as HTMLElement).click();
        expect([...starsOf("c1")]).toEqual(["u1:assistant"]);
        expect(starsOf("other").size).toBe(0);
        expect(stars[1].firstElementChild!.getAttribute("aria-pressed")).toBe("true");
        expect(toggleStar("c1", "u1:assistant")).toBe(false);
        expect(starsOf("c1").size).toBe(0);
        setStarsActive(false);
    });
});

describe("wider chat", () => {
    test("finds the column that carries Notion's width cap", () => {
        chat();
        const column = columnOf(document.querySelector("[data-agent-chat-user-step-id]")!);
        expect(column?.style.maxWidth).toBe("798px");
        expect(css(1100)).toContain("max-width: 1044px");
    });
});

describe("star placement", () => {
    test("sits after Notion's icon buttons, before a stretching group, and widens a fixed row", async () => {
        const { place } = await import("@plugins/messageStars/index");
        document.body.innerHTML = `
          <div id="row" style="display:flex">
            <div class="w"><div role="button" aria-label="Copy response"></div></div>
            <div class="w"><div role="button" aria-label="Share positive feedback"></div></div>
            <div style="flex: 1 1 0px"><div role="button" aria-label="Undo">Undo</div></div>
          </div>
          <div id="user" style="display:flex; width: 24px"><div class="w"><div role="button" aria-label="Copy text"></div></div></div>`;
        const row = document.getElementById("row")!;
        const star = document.createElement("div");
        place(row, row.firstElementChild as HTMLElement, star);
        expect([...row.children].indexOf(star)).toBe(2);
        const user = document.getElementById("user")!;
        place(user, user.firstElementChild as HTMLElement, document.createElement("div"));
        expect(user.children.length).toBe(2);
        expect(user.style.width).toBe("auto");
    });
});
