/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";

import { definePlugin, pluginError, registerPlugins, startPlugins, StartAt } from "@api/PluginManager";
import { counterText, searchHistory } from "@plugins/inputHistory/index";
import { categoryOf } from "@plugins/noTelemetry/index";
import { NOTION_PAGES } from "@plugins/settings/notionSettings";

describe("prompt history browser", () => {
    test("counter shows the entry's position, oldest first", () => {
        expect(counterText(2, 20)).toBe("3 / 20");
    });

    test("search is newest first and needs every word", () => {
        const list = ["写一封邮件", "翻译这段 code", "解释 code 的含义"];
        expect(searchHistory(list, "").map(entry => entry.index)).toEqual([2, 1, 0]);
        expect(searchHistory(list, "CODE 解释").map(entry => entry.text)).toEqual(["解释 code 的含义"]);
    });
});

describe("telemetry categories", () => {
    const of = (href: string) => categoryOf(new URL(href));

    test("matches only the reporting endpoints", () => {
        expect(of("https://app.notion.com/api/v3/etClient")).toBe("events");
        expect(of("https://exp.notion.com/v1/rgstr?k=client-x&st=ja")).toBe("experiments");
        expect(of("https://http-inputs-notion.splunkcloud.com/services/collector/raw")).toBe("logs");
        expect(of("https://o324374.ingest.sentry.io/api/5741876/envelope/")).toBe("errors");
    });

    test("leaves feature flags and normal API calls alone", () => {
        expect(of("https://exp.notion.com/v1/initialize?k=client-x")).toBeNull();
        expect(of("https://app.notion.com/api/v3/getAvailableModels")).toBeNull();
        expect(of("https://evil.example/api/v3/etClient")).toBeNull();
    });
});

describe("plugin errors", () => {
    test("a plugin that throws on start records why", () => {
        const broken = definePlugin({
            name: "brokenForTest",
            title: "Broken",
            description: "",
            enabledByDefault: true,
            start() {
                throw new Error("selector not found");
            },
            stop() {},
        });
        registerPlugins([broken]);
        startPlugins(StartAt.DomReady);
        expect(pluginError("brokenForTest")).toMatchObject({ stage: "start", message: "selector not found" });
        expect(broken.started).toBe(false);
    });
});

describe("Notion settings shortcuts", () => {
    test("every shortcut names a settings tab id", () => {
        expect(NOTION_PAGES.map(page => page.id)).toContain("ai");
        expect(NOTION_PAGES.every(page => /^[a-z_]+$/.test(page.id))).toBe(true);
    });
});
