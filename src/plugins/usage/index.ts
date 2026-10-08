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
    showPlan: {
        type: "boolean",
        label: { zh: "悬停时显示套餐", en: "Show plan on hover" },
        description: { zh: "在悬停提示里显示套餐和周期截止日期", en: "Show the plan and its period end date in the hover tooltip" },
        default: false,
    },
    showPercent: {
        type: "boolean",
        label: { zh: "圆环旁常驻显示百分比", en: "Always show percentages" },
        description: { zh: "不用悬停也能看到 6 小时和月度用量的百分比", en: "See the 6-hour and monthly percentages without hovering" },
        default: false,
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
    showPlan: () => settings.store.showPlan,
    showPercent: () => settings.store.showPercent,
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
        zh: "在 AI 输入框底部中央用两个圆环显示 6 小时与月度用量，悬停查看百分比和重置时间，点击按日期查看用量。",
        en: "Two rings at the bottom center of the AI composer show 6-hour and monthly usage. Hover for percentages and reset times; click for usage by date.",
    },
    icon: Icons.gauge,
    tags: ["composer"],
    enabledByDefault: true,
    updatedAt: "2026-10-08",
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
