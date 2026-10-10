/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";

import { findPrompts } from "@plugins/autoAllow/index";
import { panelOpen } from "@plugins/autoHidePanel/index";
import { collectMessages, isCodeLine, proseOf } from "@plugins/navigator/messages";

describe("outline skips tool output", () => {
    test("raw script lines are not a reply's text", () => {
        expect(isCodeLine("window.LOCALE_SETUP={\"locale\":\"en-US\"};")).toBe(true);
        expect(isCodeLine("const x = 1;")).toBe(true);
        expect(isCodeLine("弗诺·文奇共出版了 6 部长篇小说。")).toBe(false);
        expect(isCodeLine("Here is what I found.")).toBe(false);
        expect(proseOf("window.LOCALE_SETUP={};\nvar a = 2;")).toBe("");
        expect(proseOf("结论如下\nwindow.a=1;")).toBe("结论如下");
    });
});

describe("outline skips the to-do list", () => {
    test("the reply after nested task steps is the label, not the plan above them", () => {
        document.body.innerHTML = `
          <main>
            <div><div data-agent-chat-user-step-id="u1"><div data-content-editable-leaf>检查封面</div></div></div>
            <div><div class="col">
              <div><div role="button" aria-expanded="false" aria-controls=":a:"><div>2 steps</div></div></div>
              <div><div><div><div>检索书目</div><div>检索中文版</div><div>Find cover images</div></div></div></div>
              <div><div><div role="button" aria-expanded="false" aria-controls=":b:"><div>导出并下载中文版封面</div></div></div></div>
              <div><div role="button" aria-expanded="false" aria-controls=":c:"><div>9 steps</div></div></div>
              <div><div><div role="button" aria-expanded="false" aria-controls=":d:"><div>替换封面</div></div></div></div>
              <div><div><div>这次检查没有发现封面放错书的情况。</div></div></div>
              <div><div role="button"></div></div>
            </div></div>
            <div><div data-agent-chat-user-step-id="u2"><div data-content-editable-leaf>好</div></div></div>
          </main>`;
        const reply = collectMessages().find(message => message.role === "assistant");
        expect(reply?.text).toBe("这次检查没有发现封面放错书的情况。");
        document.body.innerHTML = "";
    });
});

describe("auto-allow", () => {
    test("finds the trust prompt's Allow once button and its site", () => {
        document.body.innerHTML = `<div><div class="card">
            <div>Do you trust <span>openlibrary.org</span>?</div>
            <div>Allowing Notion AI to access untrusted URLs can be a security risk.</div>
            <div>https://openlibrary.org/search.json?author=Vernor+Vinge</div>
            <div><div role="button">Allow once</div><div role="button">Reject</div></div>
          </div><div role="button">Allow once</div></div>`;
        const prompts = findPrompts();
        expect(prompts.length).toBe(1);
        expect(prompts[0].site).toBe("openlibrary.org");
        expect(prompts[0].url).toBe("https://openlibrary.org/search.json?author=Vernor+Vinge");
    });
});

describe("auto-hide side panel", () => {
    test("reads the toggle's state", () => {
        const toggle = document.createElement("div");
        toggle.setAttribute("aria-label", "Minimize");
        expect(panelOpen(toggle)).toBe(true);
        toggle.setAttribute("aria-label", "Open details");
        expect(panelOpen(toggle)).toBe(false);
        toggle.setAttribute("aria-expanded", "true");
        expect(panelOpen(toggle)).toBe(true);
    });
});
