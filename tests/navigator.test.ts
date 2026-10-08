/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from "bun:test";

import { type ChatMessage, cleanLines, collectMessages, outlineLabels, summarize } from "@plugins/navigator/messages";

afterEach(() => void (document.body.innerHTML = ""));

function chat() {
    document.body.innerHTML = `
      <div id="transcript">
        <div><div><div data-agent-chat-user-step-id="u1"><div>
          <div class="bubble"><div><div data-content-editable-leaf="true" contenteditable="false">任务: 汇总红警2单位属性</div></div></div>
          <div><div>October 7 at 1:10 AM</div><div><div role="button" aria-label="Copy text"></div></div></div>
        </div></div></div></div>
        <div>
          <div class="col">
            <div><div role="button" aria-expanded="false" aria-controls=":r1:"><div>10 steps</div><svg></svg></div></div>
            <div class="body">汇总表已经改成数据库了</div>
          </div>
          <div><div role="button" aria-label="Copy response"></div></div>
        </div>
        <div><div><div data-agent-chat-user-step-id="u2"><div>
          <div class="bubble"><div><div data-content-editable-leaf="true">补上单位的图片!</div></div></div>
          <div><div>3:27 AM</div></div>
        </div></div></div></div>
        <div>
          <div class="col">
            <div><div role="button" aria-expanded="true" aria-controls=":r2:"><div>7 steps</div></div></div>
            <div id=":r2:">Searched the web</div>
            <div class="body">图片已补上</div>
          </div>
        </div>
      </div>`;
}

describe("chat navigator detection", () => {
    test("user steps and the assistant replies that follow them", () => {
        chat();
        const messages = collectMessages();
        expect(messages.map(m => [m.role, m.id])).toEqual([
            ["user", "u1"], ["assistant", "u1:assistant"], ["user", "u2"], ["assistant", "u2:assistant"],
        ]);
        expect(messages[0].text).toBe("任务: 汇总红警2单位属性");
        expect(messages[0].element.classList.contains("bubble")).toBe(true);
        expect(messages[1].element.classList.contains("body")).toBe(true);
        expect(messages[1].text).toBe("汇总表已经改成数据库了");
        expect(messages[3].text).toBe("图片已补上");
    });

    test("a picked option fills the empty user step after a choice question", () => {
        document.body.innerHTML = `
          <div>
            <div><div><div data-agent-chat-user-step-id="u1"><div><div class="bubble"><div><div data-content-editable-leaf="true">continue where you left</div></div></div><div>3:07 AM</div></div></div></div></div>
            <div>
              <div><div><div><div role="button" aria-expanded="false" aria-controls=":ra:"><div>查看视图接口用法</div></div></div>
                <div><div role="button" aria-expanded="false" aria-controls=":rc:"><div>9 steps</div></div></div></div></div>
              <div><div><div><div class="question">新图鉴现在放在两个页面的最底部，接下来怎么处理？</div>
                <div class="picked" data-content-editable-leaf="true" contenteditable="false">用新图鉴替换旧图鉴</div></div></div></div>
              <div><div role="button" aria-label="Copy response"></div><div role="button">Undo</div></div>
            </div>
            <div><div><div data-agent-chat-user-step-id="u2"></div></div></div>
            <div><div class="col"><div><div role="button" aria-expanded="false" aria-controls=":rd:"><div>2 steps</div></div></div><div class="body">原版页面的图鉴已经换好了</div></div></div>
          </div>`;
        const messages = collectMessages();
        expect(messages.map(m => [m.role, m.text])).toEqual([
            ["user", "continue where you left"],
            ["assistant", "新图鉴现在放在两个页面的最底部，接下来怎么处理？"],
            ["user", "用新图鉴替换旧图鉴"],
            ["assistant", "原版页面的图鉴已经换好了"],
        ]);
        expect(messages[2].element.classList.contains("picked")).toBe(true);
    });

    test("a reply cut off before any text is listed by its steps", () => {
        document.body.innerHTML = `<div>
          <div><div data-agent-chat-user-step-id="u1"><div data-content-editable-leaf="true">重写布局</div></div></div>
          <div class="cut"><div><div role="button" aria-expanded="false" aria-controls=":r1:"><div>10 steps</div></div></div>
            <div><div role="button" aria-expanded="false" aria-controls=":r2:"><div>2 steps</div></div></div>
            <div><div role="button" aria-label="Copy response"></div></div></div>
          <div><div data-agent-chat-user-step-id="u2"><div data-content-editable-leaf="true">continue where you left</div></div></div>
          <div><div class="body">好的</div></div></div>`;
        const messages = collectMessages();
        expect(messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
        expect(messages[1].text).toMatch(/^(回答已中断（10 steps · 2 steps）|Reply interrupted \(10 steps · 2 steps\))$/);
        expect(messages[1].element.classList.contains("cut")).toBe(true);
    });

    test("an empty user step with nothing to recover is left out", () => {
        document.body.innerHTML = `<div>
          <div><div data-agent-chat-user-step-id="u1"><div data-content-editable-leaf="true">Hi</div></div></div>
          <div><div class="body">Hello there</div></div>
          <div><div data-agent-chat-user-step-id="u2"></div></div>
          <div><div class="body">Anything else?</div></div></div>`;
        expect(collectMessages().map(m => [m.role, m.text])).toEqual([["user", "Hi"], ["assistant", "Hello there"], ["assistant", "Anything else?"]]);
    });

    test("a re-sent prompt shows where it differs from the earlier one", () => {
        const msg = (role: "user" | "assistant", text: string) => ({ id: text, role, element: document.body, text }) as ChatMessage;
        const first = "问题描述: 当前的页面,采用瀑布流,不太合适! 要求: 联网搜索,深入分析问题原因! 然后重写布局!";
        const labels = outlineLabels([msg("user", first), msg("assistant", "两个页面的布局都已重写"), msg("user", `${first} 注意: 保留卡片布局!`), msg("user", "continue")]);
        expect(labels[0]).toBe(summarize(first));
        expect(labels[2]).toBe("问题描述: 当前… 注意: 保留卡片布局!");
        expect(labels[3]).toBe("continue");
    });

    test("noise lines are removed and summaries are truncated", () => {
        expect(cleanLines("10 steps\nOctober 7 at 3:03 AM\nHello\nSearched the web")).toEqual(["Hello"]);
        expect(summarize("x".repeat(70))).toBe(`${"x".repeat(60)}…`);
    });

    test("falls back to copy buttons when Notion has no user step ids", () => {
        document.body.innerHTML = `
          <main>
            <div><div class="q">How do I export?</div><div><span>Today</span><button aria-label="Copy text"></button></div></div>
            <div><div class="content"><div>Thought for 3s</div><div class="answer">Use the export menu in settings.</div></div><div><button aria-label="Copy response"></button></div></div>
          </main>`;
        const messages = collectMessages();
        expect(messages.map(m => m.role)).toEqual(["user", "assistant"]);
        expect(messages[1].element.classList.contains("answer")).toBe(true);
    });
});

describe("chat navigator rail", () => {
    test("moves left of a right-hand side panel and back when it closes", async () => {
        const { default: navigator, placeRail, NAV_HOST_ID } = await import("@plugins/navigator/index");
        navigator.start();
        const host = document.getElementById(NAV_HOST_ID)!;
        const panel = document.createElement("aside");
        panel.getBoundingClientRect = () => ({ left: 1008, top: 50, right: 1328, bottom: 850, width: 320, height: 800, x: 1008, y: 50, toJSON() {} }) as DOMRect;
        document.body.append(panel);
        placeRail();
        expect(host.style.getPropertyValue("--nav-right")).toBe(`${1344 - 1008 + 20}px`);
        panel.remove();
        placeRail();
        expect(host.style.getPropertyValue("--nav-right")).toBe("20px");
        navigator.stop();
    });

    test("follows a panel closing on the next frame, without waiting for the rescan", async () => {
        const { default: navigator, NAV_HOST_ID } = await import("@plugins/navigator/index");
        const panel = document.createElement("aside");
        panel.getBoundingClientRect = () => ({ left: 1008, top: 50, right: 1328, bottom: 850, width: 320, height: 800, x: 1008, y: 50, toJSON() {} }) as DOMRect;
        document.body.append(panel);
        navigator.start();
        const host = document.getElementById(NAV_HOST_ID)!;
        expect(host.style.getPropertyValue("--nav-right")).toBe("356px");
        panel.remove();
        // Frames can run late on a loaded machine; still well inside the 250ms rescan delay.
        for (let waited = 0; waited < 240 && host.style.getPropertyValue("--nav-right") !== "20px"; waited += 10) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(host.style.getPropertyValue("--nav-right")).toBe("20px");
        navigator.stop();
    });
});
