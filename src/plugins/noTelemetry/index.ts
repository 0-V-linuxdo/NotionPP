/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { blockRequests } from "@api/Network";
import { definePlugin, StartAt } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";
import { Logger } from "@utils/Logger";
import { pageWindow, t } from "@utils/page";

/*
 * Like Void++'s noTelemetry: drops the usage and error reports a Notion AI page sends, before
 * they leave the browser. Only reporting endpoints are matched; the experiment-config request
 * Notion needs to decide which features to show (exp.notion.com/v1/initialize) is left alone.
 * A dropped request gets an empty success back, so Notion's code carries on as usual.
 */

const logger = new Logger("NoTelemetry");

export const settings = definePluginSettings({
    events: {
        type: "boolean",
        label: { zh: "Notion 事件统计", en: "Notion event tracking" },
        description: { zh: "app.notion.com/api/v3/etClient：记录你在页面上的操作", en: "app.notion.com/api/v3/etClient: what you do on the page" },
        default: true,
    },
    experiments: {
        type: "boolean",
        label: { zh: "实验数据上报", en: "Experiment exposure reports" },
        description: { zh: "exp.notion.com 的上报接口；功能开关的读取不受影响", en: "exp.notion.com reporting; reading feature flags is not affected" },
        default: true,
    },
    logs: {
        type: "boolean",
        label: { zh: "日志收集（Splunk）", en: "Log collection (Splunk)" },
        default: true,
    },
    errors: {
        type: "boolean",
        label: { zh: "错误上报（Sentry）", en: "Error reports (Sentry)" },
        default: true,
    },
    stats: {
        type: "action",
        label: { zh: "本页已拦截", en: "Blocked on this page" },
        description: { zh: "从打开这个页面起，各类上报被拦下的次数", en: "How many reports of each kind were dropped since this page loaded" },
        button: { zh: "查看", en: "Show" },
        run: () => pageWindow.alert(blockedSummary(blockedCounts())),
    },
});

const LABELS: Record<Category, [string, string]> = {
    events: ["事件统计", "Event tracking"],
    experiments: ["实验数据", "Experiments"],
    logs: ["日志收集", "Logs"],
    errors: ["错误上报", "Errors"],
};

export function blockedSummary(current: Record<Category, number>): string {
    const total = Object.values(current).reduce((sum, n) => sum + n, 0);
    const lines = (Object.keys(LABELS) as Category[]).map(key => `${t(...LABELS[key])}: ${current[key]}`);
    return [t(`本页共拦截 ${total} 条上报`, `${total} reports blocked on this page`), "", ...lines].join("\n");
}

export type Category = "events" | "experiments" | "logs" | "errors";

/** Which kind of report a request is, or null for anything else. */
export function categoryOf(url: URL): Category | null {
    const host = url.hostname;
    if (/(^|\.)notion\.(so|com)$/.test(host) && /^\/api\/v3\/etClient\b/.test(url.pathname)) return "events";
    if (host === "exp.notion.com" && /\/(rgstr|log_event)\b/.test(url.pathname)) return "experiments";
    if (host.endsWith(".splunkcloud.com")) return "logs";
    if (host === "sentry.io" || host.endsWith(".sentry.io")) return "errors";
    return null;
}

const counts: Record<Category, number> = { events: 0, experiments: 0, logs: 0, errors: 0 };
export const blockedCounts = () => ({ ...counts });

let stopBlocking: (() => void) | null = null;

export default definePlugin({
    name: "noTelemetry",
    title: { zh: "屏蔽统计上报", en: "Block telemetry" },
    description: {
        zh: "拦下 Notion 页面发出的统计、日志和错误上报（事件统计、实验数据、Splunk、Sentry），不影响正常功能。",
        en: "Drops the usage, log and error reports a Notion page sends (event tracking, experiments, Splunk, Sentry) without affecting how Notion works.",
    },
    icon: Icons.shield,
    enabledByDefault: false,
    updatedAt: "2026-10-08",
    // Some reporters (Sentry) take their fetch when the page loads; switching takes a reload to reach them.
    restartNeeded: true,
    // before Notion's first reports go out
    startAt: StartAt.DocumentStart,
    settings,
    start() {
        stopBlocking = blockRequests(url => {
            const category = categoryOf(url);
            if (!category || !settings.store[category]) return false;
            if (!counts[category]++) logger.info(`blocking ${category} reports (${url.hostname})`);
            return true;
        });
    },
    stop() {
        stopBlocking?.();
        stopBlocking = null;
    },
});
