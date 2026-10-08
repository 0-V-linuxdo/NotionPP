/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { definePlugin, StartAt } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Icons } from "@utils/icons";

import { UsageService } from "./service";
import { HOVER_DELAY, recordSnapshot, RETAIN } from "./stats";
import { closeStats, openStats } from "./statsDialog";
import { UsageWidget, type WidgetStats } from "./ui";
import { activeMonthly } from "./verdict";

export const settings = definePluginSettings({
    usageStats: {
        type: "boolean",
        label: { zh: "记录每日用量", en: "Daily usage stats" },
        description: { zh: "按天记录月度额度的使用量", en: "Log how much of the monthly allowance is used each day" },
        default: true,
    },
    hoverStatsDelay: {
        type: "number",
        label: { zh: "悬停显示今日用量的延迟（秒）", en: "Delay before showing today on hover, in seconds" },
        default: HOVER_DELAY.default,
        min: HOVER_DELAY.min,
        max: HOVER_DELAY.max,
    },
    retainDays: {
        type: "number",
        label: { zh: "保留历史天数", en: "Days of history to keep" },
        default: RETAIN.default,
        min: RETAIN.min,
        max: RETAIN.max,
    },
    openStats: {
        type: "action",
        label: { zh: "按日期查看用量", en: "Usage by date" },
        button: { zh: "打开", en: "Open" },
        run: () => openStats(stats),
    },
    clearStats: {
        type: "action",
        label: { zh: "清空用量历史", en: "Clear usage history" },
        description: { zh: "删除本设备上记录的每日用量", en: "Delete the daily usage recorded on this device" },
        button: { zh: "清空…", en: "Clear…" },
        run: () => openStats(stats, { confirmClearNow: true }),
    },
});

let service: UsageService | null = null;
let widget: UsageWidget | null = null;
let stopRecording: (() => void) | null = null;

function record() {
    const snapshot = service?.snapshot;
    const space = service?.spaceId;
    if (!settings.store.usageStats || !space || !snapshot || snapshot.status === "not_applicable") return;
    const monthly = activeMonthly(snapshot);
    if (monthly) recordSnapshot(space, monthly.percent, monthly.resetAt, settings.store.retainDays);
}

const stats: WidgetStats = {
    space: () => service?.spaceId ?? "",
    enabled: () => settings.store.usageStats,
    setEnabled: value => void (settings.store.usageStats = value),
    retain: () => settings.store.retainDays,
    hoverDelay: () => settings.store.hoverStatsDelay,
    refresh: record,
};

function mount() {
    if (!service || widget || !document.body) return;
    widget = new UsageWidget(service, stats);
}

export default definePlugin({
    name: "usageMeter",
    title: { zh: "AI 用量", en: "AI usage" },
    description: {
        zh: "显示 Notion AI 6 小时与月度用量、套餐与试用状态，并按天统计月度额度的使用量；最小化后双圆环贴在 AI 输入框底部中央。",
        en: "Shows Notion AI's 6-hour and monthly usage, plan and trial status, and logs monthly use per day. Minimized, two rings sit at the bottom center of the AI composer.",
    },
    icon: Icons.gauge,
    tags: ["composer"],
    enabledByDefault: true,
    startAt: StartAt.DocumentStart,
    settings,
    start() {
        service = new UsageService();
        stopRecording = service.onChange(record);
        service.start();
        if (document.body) mount();
        else document.addEventListener("DOMContentLoaded", mount, { once: true });
    },
    stop() {
        document.removeEventListener("DOMContentLoaded", mount);
        stopRecording?.();
        closeStats();
        widget?.destroy();
        service?.stop();
        stopRecording = null;
        widget = null;
        service = null;
    },
    onSettingsChange() {
        record();
        widget?.render();
    },
});
