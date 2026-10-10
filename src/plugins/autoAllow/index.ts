/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { definePlugin } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";
import { Logger } from "@utils/Logger";

/*
 * When Notion AI wants to open a site it does not trust yet, it stops and asks "Do you trust
 * example.org?" with Allow once / Reject. This answers Allow once for you, so a long task does
 * not sit waiting. It skips Notion's safety check, so it is off until you turn it on.
 */

const logger = new Logger("AutoAllow");
const QUESTION = /^\s*(?:do you trust|是否信任|你信任|您信任)/i;
const ALLOW = /^\s*(?:allow once|允许一次|仅允许一次|本次允许)\s*$/i;

export const settings = definePluginSettings({
    scope: {
        type: "select",
        label: { zh: "适用范围", en: "Applies to" },
        default: "all",
        options: [
            { value: "all", label: { zh: "所有网站", en: "Every site" } },
            { value: "https", label: { zh: "只限 https 网址", en: "Only https addresses" } },
        ],
    },
});

let answered = new WeakSet<Element>();
let stopDom: (() => void) | null = null;

/** The trust prompt's Allow once button, and the site it asks about. */
export function findPrompts(root: ParentNode = document): { allow: HTMLElement; site: string; url: string }[] {
    const out: { allow: HTMLElement; site: string; url: string }[] = [];
    for (const button of root.querySelectorAll<HTMLElement>("button, [role='button']")) {
        if (!ALLOW.test(button.textContent ?? "")) continue;
        // The smallest ancestor that also holds the question is the prompt card.
        let card: HTMLElement | null = button.parentElement;
        while (card && card !== document.body && !QUESTION.test(card.textContent ?? "")) card = card.parentElement;
        if (!card || card === document.body) continue;
        // One prompt per card: a container holding several is not this button's own prompt.
        if ([...card.querySelectorAll("button, [role='button']")].filter(node => ALLOW.test(node.textContent ?? "")).length !== 1) continue;
        const question = [...card.querySelectorAll<HTMLElement>("*")].find(node => QUESTION.test(node.textContent ?? "") && !node.querySelector("button, [role='button']"));
        const site = (question?.textContent ?? "").replace(QUESTION, "").replace(/[?？]\s*$/, "").trim();
        const url = (card.textContent ?? "").match(/https?:\/\/\S+/)?.[0] ?? "";
        out.push({ allow: button, site, url });
    }
    return out;
}

function scan() {
    for (const prompt of findPrompts()) {
        if (answered.has(prompt.allow)) continue;
        if (settings.store.scope === "https" && prompt.url && !prompt.url.startsWith("https://")) continue;
        answered.add(prompt.allow);
        logger.info(`Allowing once: ${prompt.site || prompt.url || "(unknown site)"}`);
        prompt.allow.click();
    }
}

export default definePlugin({
    name: "autoAllow",
    title: { zh: "自动同意访问网址", en: "Auto-allow site access" },
    description: {
        zh: "Notion AI 询问「Do you trust 某网站?」时，自动点「Allow once」，长任务不用停下来等你。这会跳过 Notion 的安全确认，所以默认关闭。",
        en: "When Notion AI asks \"Do you trust a site?\", clicks Allow once for you so long tasks keep going. This skips Notion's safety check, so it is off by default.",
    },
    icon: Icons.checkCircle,
    tags: ["chat"],
    enabledByDefault: false,
    updatedAt: "2026-10-10",
    settings,
    start() {
        answered = new WeakSet();
        stopDom = onDomChange(scan);
        scan();
    },
    stop() {
        stopDom?.();
        stopDom = null;
    },
});
