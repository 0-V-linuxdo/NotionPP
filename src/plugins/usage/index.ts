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
        label: "记录每日用量 / Daily usage stats",
        description: "按天记录月度额度的使用量；悬停最小化圆环显示今天，点卡片里的统计按钮查看历史 / Log monthly-allowance use per day; hover the minimized rings for today, open history from the card",
        default: true,
    },
    hoverStatsDelay: {
        type: "number",
        label: "悬停显示今日用量的延迟（秒） / Hover delay for today (seconds)",
        default: HOVER_DELAY.default,
        min: HOVER_DELAY.min,
        max: HOVER_DELAY.max,
    },
    retainDays: {
        type: "number",
        label: "保留历史天数 / Days of history to keep",
        default: RETAIN.default,
        min: RETAIN.min,
        max: RETAIN.max,
    },
    openStats: {
        type: "action",
        label: "按日期查看用量 / Usage by date",
        button: "打开 / Open",
        run: () => openStats(stats),
    },
    clearStats: {
        type: "action",
        label: "清空用量历史 / Clear usage history",
        description: "删除本设备上记录的每日用量 / Delete the daily usage recorded on this device",
        button: "清空… / Clear…",
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
    title: "AI 用量 / AI usage",
    description: "显示 Notion AI 6 小时与月度用量、套餐与试用状态，并按天统计月度额度的使用量；最小化后双圆环贴在 AI 输入框底部中央。",
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
