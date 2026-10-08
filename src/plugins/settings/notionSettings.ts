/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { button, h, row, section } from "@utils/kit";
import { Logger } from "@utils/Logger";
import { t } from "@utils/page";

/*
 * Like the Grok tabs in Void++'s settingsFlyout: shortcuts that open Notion's own Settings dialog
 * on a given page. Notion has no URL for its settings, so this does what a person would: open the
 * workspace menu, choose Settings (the gear item), then the tab, whose test id names the page.
 */

const logger = new Logger("NotionSettings");
const SWITCHER = ".notion-sidebar-switcher";
const GEAR_ITEM = "[role='dialog'] [role='button']:has(svg.gear), [role='menu'] [role='menuitem']:has(svg.gear)";
const tabSelector = (id: string) => `[role='dialog'] [data-testid='settings-tab-${id}']`;

export const NOTION_PAGES = [
    { id: "ai", zh: "Notion AI", en: "Notion AI", desc: { zh: "AI 的默认模型、联网、个性化等", en: "Default model, web access, personalization" } },
    { id: "ai_usage_dashboard", zh: "Notion 额度", en: "Notion credits", desc: { zh: "AI 额度用量明细", en: "AI credit usage" } },
    { id: "user_settings", zh: "偏好设置", en: "Preferences", desc: { zh: "外观、语言、时区、启动页", en: "Appearance, language, time zone, start page" } },
    { id: "notifications", zh: "通知", en: "Notifications", desc: { zh: "邮件、桌面和移动端通知", en: "Email, desktop and mobile notifications" } },
    { id: "integrations", zh: "连接", en: "Connections", desc: { zh: "已连接的应用和集成", en: "Connected apps and integrations" } },
    { id: "integrations_mcp", zh: "Notion MCP", en: "Notion MCP", desc: { zh: "MCP 客户端连接", en: "MCP client connections" } },
    { id: "billing", zh: "账单", en: "Billing", desc: { zh: "套餐、付款方式和发票", en: "Plan, payment method and invoices" } },
];

/** Resolves with the first element matching the selector, or null after the timeout. */
function waitFor<T extends Element>(selector: string, timeout = 4000): Promise<T | null> {
    const found = document.querySelector<T>(selector);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => {
        const done = (value: T | null) => {
            stop();
            clearTimeout(timer);
            resolve(value);
        };
        const stop = onDomChange(() => {
            const el = document.querySelector<T>(selector);
            if (el) done(el);
        });
        const timer = setTimeout(() => done(null), timeout);
    });
}

/** Opens Notion's Settings dialog on the given page. Resolves false when a step could not be found. */
export async function openNotionSettings(id: string): Promise<boolean> {
    let tab = document.querySelector<HTMLElement>(tabSelector(id));
    if (!tab) {
        const switcher = document.querySelector<HTMLElement>(SWITCHER);
        if (!switcher) return false;
        switcher.click();
        const gear = await waitFor<HTMLElement>(GEAR_ITEM);
        if (!gear) return false;
        gear.click();
        tab = await waitFor<HTMLElement>(tabSelector(id));
    }
    if (!tab) return false;
    tab.click();
    return true;
}

export function notionSettingsTab(close: () => void) {
    const open = (id: string) => {
        close();
        void openNotionSettings(id).then(ok => {
            if (!ok) logger.warn(`could not open Notion settings page "${id}"`);
        });
    };
    return h("div", { class: "tab-root notion-settings" },
        section(t("Notion 自带设置", "Notion's own settings"),
            ...NOTION_PAGES.map(page => row(t(page.zh, page.en), t(page.desc.zh, page.desc.en), button("secondary", t("打开", "Open"), () => open(page.id))))));
}
