/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { registerPlugins } from "@api/PluginManager";
import { getValue, reloadFromStorage, SETTINGS_KEY } from "@api/Settings";
import focusHighlight from "@plugins/focusHighlight";
import chatNavigator from "@plugins/navigator";
import settingsPlugin, { openSettings, SETTINGS_HOST_ID } from "@plugins/settings";

const root = () => document.getElementById(SETTINGS_HOST_ID)!.shadowRoot!;
const card = (name: string) => root().querySelector<HTMLElement>(`.card[data-plugin="${name}"]`)!;

describe("settings dialog", () => {
    beforeAll(() => registerPlugins([settingsPlugin, chatNavigator, focusHighlight]));

    afterEach(() => {
        document.getElementById(SETTINGS_HOST_ID)?.remove();
        localStorage.removeItem(SETTINGS_KEY);
        reloadFromStorage(null);
    });

    test("renders Void++-style nav, category tabs and a plugin card grid", () => {
        openSettings();
        expect([...root().querySelectorAll(".nav-item")].map(n => n.getAttribute("aria-current"))).toEqual(["page", null]);
        expect(root().querySelectorAll(".tab").length).toBeGreaterThanOrEqual(2);
        expect(root().querySelector(".tab.active")!.textContent).toMatch(/All|全部/);
        const grids = root().querySelectorAll(".grid");
        expect(grids.length).toBe(2);
        expect(card("settings").classList.contains("required")).toBe(true);
        expect(card("settings").querySelector<HTMLButtonElement>(".switch")!.disabled).toBe(true);
        expect(card("chatNavigator").querySelector(".card-icon svg")).not.toBeNull();
    });

    test("switch toggles the plugin and search/filter narrow the grid", () => {
        openSettings();
        card("chatNavigator").querySelector<HTMLButtonElement>(".switch")!.click();
        expect(getValue("chatNavigator", "enabled")).toBe(false);
        const filter = root().querySelector<HTMLSelectElement>(".search-bar select")!;
        filter.value = "disabled";
        filter.dispatchEvent(new Event("change"));
        expect([...root().querySelectorAll(".card")].map(c => c.getAttribute("data-plugin"))).toEqual(["chatNavigator"]);
        filter.value = "all";
        filter.dispatchEvent(new Event("change"));
        const search = root().querySelector<HTMLInputElement>(".search-bar input")!;
        search.value = "高亮";
        search.dispatchEvent(new Event("input"));
        expect([...root().querySelectorAll(".card")].map(c => c.getAttribute("data-plugin"))).toEqual([focusHighlight.name]);
    });

    test("star moves a plugin into favorites", () => {
        openSettings();
        card(focusHighlight.name).querySelector<HTMLButtonElement>(".icon-btn")!.click();
        expect(getValue("settings", "starred")).toBe(focusHighlight.name);
        root().querySelector<HTMLButtonElement>(".tab")!.click();
        expect([...root().querySelectorAll(".card")].map(c => c.getAttribute("data-plugin"))).toEqual([focusHighlight.name]);
    });

    test("plugin dialog edits colours and resets to defaults after confirm", () => {
        openSettings();
        const buttons = card(focusHighlight.name).querySelectorAll<HTMLButtonElement>(".icon-btn");
        buttons[buttons.length - 1].click();
        const sheet = root().querySelector(".layer-nested .sheet")!;
        expect(sheet.querySelector(".sheet-title")!.textContent).toBe(focusHighlight.title);
        const color = sheet.querySelector<HTMLInputElement>("input[type=color]")!;
        color.value = "#ff0000";
        color.dispatchEvent(new Event("input"));
        const key = Object.keys(focusHighlight.settings!.def).find(k => focusHighlight.settings!.def[k].type === "color")!;
        expect(getValue(focusHighlight.name, key)).toBe("#ff0000");
        [...sheet.querySelectorAll<HTMLButtonElement>(".footer .btn")].at(-1)!.click();
        root().querySelector<HTMLButtonElement>(".layer-confirm .btn-danger")!.click();
        expect(getValue(focusHighlight.name, key)).toBeUndefined();
        expect(root().querySelector(".layer-confirm")).toBeNull();
        expect(root().querySelector<HTMLInputElement>(".layer-nested input[type=color]")!.value).not.toBe("#ff0000");
    });

    test("Escape closes the top layer first, then the dialog", () => {
        openSettings();
        const buttons = card(focusHighlight.name).querySelectorAll<HTMLButtonElement>(".icon-btn");
        buttons[buttons.length - 1].click();
        const esc = () => root().querySelector(".dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
        esc();
        expect(root().querySelector(".layer-nested")).toBeNull();
        expect(document.getElementById(SETTINGS_HOST_ID)).not.toBeNull();
        esc();
        expect(document.getElementById(SETTINGS_HOST_ID)).toBeNull();
    });
});
