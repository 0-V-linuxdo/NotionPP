/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { createOverlay, type Overlay } from "@api/Overlay";
import { CSS as SHEET_CSS } from "@plugins/settings/styles";
import { el } from "@utils/dom";
import { finiteNumber } from "@utils/guards";
import { Icons, svgIcon } from "@utils/icons";
import { t } from "@utils/page";

import {
    chartDays, chartScale, clearDays, dateKey, type DayRecord, dayLabel, dayNumber, loadDays,
    looksWiped, repairWiped, shiftDate, statDelta, statPercent, usedOn, writeDay,
} from "./stats";

export const STATS_HOST_ID = "notionai-pp-usage-stats";

export interface StatsContext {
    space: () => string;
    enabled: () => boolean;
    setEnabled: (value: boolean) => void;
    retain: () => number;
    /** Records the latest reading before the dialog reads the log. */
    refresh: () => void;
}

const CSS = `${SHEET_CSS}
.sheet > .stack { gap: .875rem; }
.toggle-row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.toggle-row b { font-size: .875rem; font-weight: 500; }
.muted { margin: 0; color: var(--fg-secondary); font-size: .8125rem; }
.chart { display: flex; align-items: stretch; gap: .35rem; height: 9.25rem; overflow-x: auto; outline: none; }
.chart:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; border-radius: .5rem; }
.bar { flex: 1 0 2.5rem; min-width: 2.5rem; height: 100%; padding: .25rem .15rem .2rem; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; gap: .3rem; border: 0; border-radius: .5rem; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.bar:hover, .bar.on { background: var(--surface-l2); }
.track { display: flex; flex: 1; align-items: flex-end; justify-content: center; width: 100%; min-height: 0; }
.fill { width: 1.1rem; min-height: 2px; border-radius: 4px 4px 0 0; background: color-mix(in srgb, var(--fg-primary) 45%, transparent); }
.bar.on .fill { background: var(--fg-primary); }
.bar.empty .fill { background: var(--border-l1); }
.bar-value, .bar-label { font-size: .6875rem; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-value { min-height: .6875rem; font-weight: 550; opacity: .85; }
.bar.empty .bar-value { opacity: 0; }
.bar-label { opacity: .7; }
.bar.on .bar-value, .bar.on .bar-label { opacity: 1; font-weight: 550; }
.detail { display: flex; flex-direction: column; gap: .4rem; padding-top: .6rem; border-top: 1px solid var(--border-l1); }
.detail-title { font-size: .875rem; font-weight: 600; }
.formula { display: flex; align-items: flex-end; gap: .6rem; font-variant-numeric: tabular-nums; }
.term { display: flex; flex-direction: column; gap: .1rem; }
.term small { color: var(--fg-secondary); font-size: .6875rem; }
.term b { font-size: .9375rem; font-weight: 600; }
.op { padding-bottom: .1rem; color: var(--fg-secondary); }
.caption { color: var(--fg-secondary); font-size: .75rem; font-variant-numeric: tabular-nums; }
.repair { display: flex; flex-direction: column; gap: .4rem; padding: .6rem; border-radius: .6rem; background: var(--surface-l2); }
.repair-row { display: flex; align-items: center; gap: .5rem; }
.repair .input { width: 6rem; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
`;

let overlay: Overlay | null = null;

export function closeStats() {
    overlay?.destroy();
    overlay = null;
}

function iconButton(markup: string, label: string, onclick: () => void) {
    const button = el("button", { type: "button", class: "icon-btn close", title: label, "aria-label": label });
    button.append(svgIcon(markup));
    button.addEventListener("click", onclick);
    return button;
}

function textButton(variant: "secondary" | "danger", label: string, onclick: () => void) {
    const button = el("button", { type: "button", class: `btn btn-${variant}`, text: label });
    button.addEventListener("click", onclick);
    return button;
}

function formula(day: DayRecord, isToday: boolean) {
    const term = (label: string, value: string) => el("span", { class: "term" }, el("small", { text: label }), el("b", { text: value }));
    const op = (sign: string) => el("span", { class: "op", text: sign });
    const used = statPercent(usedOn(day));
    if (day.carried <= 0) {
        return el("div", { class: "formula" },
            term(isToday ? t("当前", "Current") : t("最后", "Last"), statPercent(day.last)), op("−"),
            term(t("开始", "Start"), statPercent(day.first)), op("="),
            term(t("已用", "Used"), used));
    }
    const after = day.first === null || day.last === null ? null : Math.max(0, day.last - day.first);
    const box = el("div", { class: "stack" }, el("div", { class: "formula" },
        term(t("重置前", "Before"), statPercent(day.carried)), op("+"),
        term(t("重置后", "After"), statPercent(after)), op("="),
        term(t("已用", "Used"), used)));
    if (day.closedFirst !== null && day.closedLast !== null) {
        let caption = `${statPercent(day.closedFirst)} → ${statPercent(day.closedLast)}`;
        if (day.first !== null && day.last !== null) caption += `  +  ${statPercent(day.first)} → ${statPercent(day.last)}`;
        box.append(el("div", { class: "caption", text: caption }));
    }
    return box;
}

function repairBox(ctx: StatsContext, day: DayRecord, previous: DayRecord | null, rerender: () => void) {
    if (!looksWiped(day, previous)) return null;
    const hint = previous?.last ?? null;
    const input = el("input", {
        type: "number", min: "0", max: "100", step: "0.1", class: "input",
        value: hint === null ? "" : String(hint), "aria-label": t("重置前的月度用量百分比", "Monthly percent before the reset"),
    });
    const apply = textButton("secondary", t("修复", "Repair"), () => {
        const before = finiteNumber(input.value);
        if (before === null) return;
        writeDay(ctx.space(), repairWiped(day, hint ?? 0, before), ctx.retain());
        rerender();
    });
    input.addEventListener("input", () => void (apply.disabled = finiteNumber(input.value) === null));
    return el("div", { class: "repair" },
        el("p", { class: "muted", text: t(
            "月度额度在这一天开始前已重置，记录只剩 0% 左右。填入重置前的月度用量即可补回当天的用量。",
            "The monthly allowance reset before this day was first seen, so only ~0% was recorded. Enter the monthly usage just before the reset.",
        ) }),
        el("div", { class: "repair-row" }, input, apply));
}

function confirmClear(ctx: StatsContext, root: ShadowRoot, done: () => void) {
    const layer = el("div", { class: "layer layer-confirm" });
    const close = () => layer.remove();
    const sheet = el("div", { class: "sheet sheet-sm", role: "dialog", "aria-modal": "true" },
        iconButton(Icons.x, t("关闭", "Close"), close),
        el("div", { class: "sheet-head" },
            el("h3", { class: "sheet-title", text: t("清空用量历史", "Clear usage history") }),
            el("p", { class: "sheet-desc", text: t("删除本设备上记录的所有每日用量？此操作无法撤销。", "Delete all daily usage recorded on this device? This cannot be undone.") })),
        el("div", { class: "footer" },
            textButton("secondary", t("取消", "Cancel"), close),
            textButton("danger", t("清空", "Clear"), () => {
                clearDays(ctx.space());
                close();
                done();
            })));
    layer.append(sheet);
    layer.addEventListener("mousedown", event => event.target === layer && close());
    root.append(layer);
    sheet.tabIndex = -1;
    sheet.focus();
}

export function openStats(ctx: StatsContext, { confirmClearNow = false } = {}) {
    closeStats();
    ctx.refresh();
    overlay = createOverlay(STATS_HOST_ID, CSS, "");
    const { root } = overlay;
    const body = el("div", { class: "stack" });
    const sheet = el("div", { class: "sheet sheet-sm", role: "dialog", "aria-modal": "true" },
        iconButton(Icons.x, t("关闭", "Close"), closeStats),
        el("div", { class: "sheet-head" },
            el("h3", { class: "sheet-title", text: t("按日期查看用量", "Usage by date") }),
            el("p", { class: "sheet-desc", text: t("每天用掉的月度额度百分比，仅保存在本设备。", "Share of the monthly allowance used each day, stored on this device.") })),
        body);
    const backdrop = el("div", { class: "layer layer-root" }, sheet);
    backdrop.addEventListener("mousedown", event => event.target === backdrop && closeStats());
    root.addEventListener("keydown", event => {
        if ((event as KeyboardEvent).key !== "Escape") return;
        const confirm = root.querySelector(".layer-confirm");
        if (confirm) confirm.remove();
        else closeStats();
    });
    root.append(backdrop);

    let selected = dateKey(Date.now());

    const render = () => {
        const space = ctx.space();
        const enabled = ctx.enabled();
        const now = Date.now();
        const today = dateKey(now);
        const days = enabled ? loadDays(space) : new Map<string, DayRecord>();

        const toggle = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(enabled), "aria-label": t("记录每日用量", "Daily usage stats") });
        toggle.addEventListener("click", () => {
            ctx.setEnabled(!enabled);
            if (!enabled) ctx.refresh();
            render();
        });
        const parts: Node[] = [el("div", { class: "toggle-row" }, el("b", { text: t("记录每日用量", "Daily usage stats") }), toggle)];

        if (!space) {
            parts.push(el("p", { class: "muted", text: t("等待 Notion 初始化当前工作区。", "Waiting for Notion to initialize this workspace.") }));
        } else if (!enabled) {
            parts.push(el("p", { class: "muted", text: t("开启后按天记录月度额度的使用量；悬停最小化的圆环会在延迟后显示今天的用量。", "Turn on to keep a per-day log of the monthly allowance. Hovering the minimized rings shows today after a delay.") }));
        } else if (!days.size) {
            parts.push(el("p", { class: "muted", text: t("还没有记录。统计从开启记录的那一刻开始。", "No days recorded yet. Stats start from the moment tracking is on.") }));
        } else {
            const bars = chartDays(days, now);
            const scale = chartScale(bars);
            const active = bars.find(day => day.date === selected) ?? bars[bars.length - 1];
            const chart = el("div", { class: "chart", tabindex: "0", role: "listbox", "aria-label": t("每日用量", "Daily usage") });
            for (const day of bars) {
                const used = usedOn(day);
                const on = day.date === active.date;
                const bar = el("button", {
                    type: "button", tabindex: "-1", role: "option", "aria-selected": String(on),
                    class: ["bar", on && "on", used === null && "empty"].filter(Boolean).join(" "),
                    "aria-label": `${dayLabel(day.date, today)}, ${statDelta(used)}`,
                });
                const fill = el("span", { class: "fill" });
                fill.style.height = `${used === null ? 0 : Math.min(100, (used / scale) * 100)}%`;
                bar.append(
                    el("span", { class: "bar-value", text: used === null ? " " : statPercent(used) }),
                    el("span", { class: "track" }, fill),
                    el("span", { class: "bar-label", text: day.date === today ? t("今天", "Today") : dayNumber(day.date) }));
                bar.addEventListener("click", () => {
                    selected = day.date;
                    render();
                    root.querySelector<HTMLElement>(".chart")?.focus({ preventScroll: true });
                });
                chart.append(bar);
            }
            chart.addEventListener("keydown", event => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const index = bars.findIndex(day => day.date === active.date);
                const next = bars[Math.min(bars.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)))];
                selected = next.date;
                render();
                root.querySelector<HTMLElement>(".chart")?.focus({ preventScroll: true });
            });
            const previous = days.get(shiftDate(active.date, -1)) ?? null;
            const detail = el("div", { class: "detail" },
                el("div", { class: "detail-title", text: dayLabel(active.date, today) }),
                formula(active, active.date === today));
            const repair = repairBox(ctx, active, previous, render);
            if (repair) detail.append(repair);
            parts.push(chart, detail);
            queueMicrotask(() => {
                const on = chart.querySelector<HTMLElement>(".bar.on");
                if (on && chart.scrollWidth > chart.clientWidth) chart.scrollLeft = on.offsetLeft - chart.clientWidth + on.offsetWidth + 8;
            });
        }

        const stored = space ? loadDays(space).size : 0;
        const clear = textButton("secondary", t("清空历史", "Clear history"), () => confirmClear(ctx, root, render));
        clear.disabled = !stored;
        parts.push(el("div", { class: "foot" },
            el("p", { class: "muted", text: t(`已记录 ${stored} 天，保留 ${ctx.retain()} 天`, `${stored} recorded day${stored === 1 ? "" : "s"}, keeping ${ctx.retain()}`) }),
            clear));
        body.replaceChildren(...parts);
    };

    render();
    sheet.tabIndex = -1;
    sheet.focus();
    if (confirmClearNow && ctx.space() && loadDays(ctx.space()).size) confirmClear(ctx, root, render);
}
