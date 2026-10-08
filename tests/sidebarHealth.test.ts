/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from "bun:test";

import { composerBox, css as composerCss } from "@plugins/composerLook/index";
import { CHECKS, failedChecks, shouldNotify } from "@plugins/healthCheck/index";
import { isActive, sidebarButton } from "@plugins/sidebarTweaks/index";

afterEach(() => {
    document.body.innerHTML = "";
});

describe("sidebar tweaks", () => {
    function sidebar() {
        document.body.innerHTML = `
          <nav class="notion-sidebar-container">
            <div class="head"><div role="button" aria-label="Close sidebar"><svg class="sidebarLeft"></svg></div></div>
            <div class="list"><div class="gap"></div><div role="treeitem"><span class="label">Chat</span></div></div>
          </nav>`;
        return document.querySelector("nav")!;
    }

    test("rows and buttons count as active, gaps do not", () => {
        const nav = sidebar();
        expect(isActive(nav.querySelector(".label"), nav)).toBe(true);
        expect(isActive(nav.querySelector(".gap"), nav)).toBe(false);
        expect(isActive(nav, nav)).toBe(false);
    });

    test("finds Notion's collapse button, then the lock button when collapsed", () => {
        const nav = sidebar();
        expect(sidebarButton(nav)?.getAttribute("aria-label")).toBe("Close sidebar");
        nav.querySelector(".head")!.remove();
        document.body.insertAdjacentHTML("beforeend", `<div role="button" aria-label="Lock sidebar open"><svg class="menu"></svg></div>`);
        expect(sidebarButton(nav)?.getAttribute("aria-label")).toBe("Lock sidebar open");
    });
});

describe("composer look", () => {
    test("finds the box that paints the composer background", () => {
        document.body.innerHTML = `<div data-notion-chat-input-container><div class="outer"><div class="box" style="background-color: var(--c-bacSec); border-radius: 16px"></div></div></div>`;
        expect(composerBox(document.body.firstElementChild!)?.className).toBe("box");
    });

    test("css mixes the background and adds blur only when asked", () => {
        expect(composerCss(70, 0)).toContain("color-mix(in srgb, var(--c-bacSec) 70%, transparent)");
        expect(composerCss(70, 0)).not.toContain("blur");
        expect(composerCss(150, 8)).toContain("100%");
        expect(composerCss(50, 8)).toContain("blur(8px)");
    });
});

describe("update self-check", () => {
    test("every check passes on a healthy chat", () => {
        document.body.innerHTML = `
          <nav class="notion-sidebar-container"></nav>
          <div data-testid="share-chat-button"></div>
          <div data-agent-chat-user-step-id="u1">Hi</div>
          <div role="button" aria-label="Copy response"></div>
          <div data-notion-chat-input-container><div data-testid="agent-send-message-button"></div></div>`;
        expect(failedChecks()).toEqual([]);
    });

    test("names what is missing and skips checks that do not apply", () => {
        document.body.innerHTML = `<div data-notion-chat-input-container></div>`;
        const failed = failedChecks();
        expect(failed).toEqual(["send", "messages", "share", "sidebar"]);
        expect(CHECKS.find(check => check.id === "copy")!.applies!()).toBe(false);
    });

    test("notifies only about news that affects an enabled plugin", () => {
        expect(shouldNotify([], null, 0)).toBe(false);
        expect(shouldNotify(["share"], null, 0)).toBe(false);
        expect(shouldNotify(["share"], null, 1)).toBe(true);
        expect(shouldNotify(["share"], { version: "a", failed: ["share"], at: 0 }, 1)).toBe(false);
        expect(shouldNotify(["share", "copy"], { version: "a", failed: ["share"], at: 0 }, 2)).toBe(true);
    });
});
