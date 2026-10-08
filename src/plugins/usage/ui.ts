/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { createOverlay, type Overlay } from "@api/Overlay";
import { onRouteChange } from "@api/Router";
import { boxOf, type Box, viewport } from "@utils/dom";
import { safeJson } from "@utils/guards";
import { isAiRoute, pageWindow, t } from "@utils/page";

import { visibleBilling } from "./billing";
import { ComposerTracker } from "./composer";
import { billingRow, formatCountdown, formatDate, formatPercent } from "./format";
import { type Anchor, dockPoint, parseAnchor, type Point, pointFromAnchor } from "./geometry";
import type { UsageService } from "./service";
import { readDay, statDelta, usedOn } from "./stats";
import { openStats, type StatsContext } from "./statsDialog";
import { RING_CIRCUMFERENCE, USAGE_CSS, USAGE_HTML } from "./styles";
import { activeMonthly, meterViews } from "./verdict";

export const HOST_ID = "notionai-pp-usage";
export const KEYS = {
    anchor: "notionai-pp:usage:anchor:v1",
    legacyAnchor: "notion-ai-usage:position:v2",
} as const;
const DEFAULT_ANCHOR: Anchor = { xEdge: "right", xOffset: 16, yEdge: "top", yOffset: 16 };
const TIP_SPACE = 140;
const TICK_MS = 15_000;

function readAnchor(): Anchor | null {
    try {
        const storage = pageWindow.localStorage;
        return parseAnchor(safeJson(storage.getItem(KEYS.anchor) ?? "")) ?? parseAnchor(safeJson(storage.getItem(KEYS.legacyAnchor) ?? ""));
    } catch {
        return null;
    }
}

export interface WidgetStats extends StatsContext {
    hoverDelay: () => number;
    showPlan: () => boolean;
}

/**
 * One form only, like Void++'s usage button: two rings docked in the composer, a Notion
 * tooltip with the numbers and reset times on hover, and the usage-by-date dialog on click.
 */
export class UsageWidget {
    private overlay: Overlay;
    private q: <T extends Element = HTMLElement>(selector: string) => T;
    private anchor: Anchor = readAnchor() ?? DEFAULT_ANCHOR;
    private tracker = new ComposerTracker(box => this.layout(box));
    private cleanups: (() => void)[] = [];
    private tipToday = false;
    private tipTimer = 0;

    constructor(private readonly service: UsageService, private readonly stats: WidgetStats) {
        this.overlay = createOverlay(HOST_ID, USAGE_CSS, USAGE_HTML);
        const { root } = this.overlay;
        this.q = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
        this.bind();
        this.render();
        this.cleanups.push(service.onChange(() => this.render()));
        this.cleanups.push(onRouteChange(() => this.layout()));
        this.tracker.start();
        const tick = setInterval(() => this.render(), TICK_MS);
        const onResize = () => this.layout();
        const onStorage = (event: StorageEvent) => {
            if (event.key !== KEYS.anchor) return;
            const anchor = parseAnchor(safeJson(event.newValue ?? ""));
            if (anchor) {
                this.anchor = anchor;
                this.layout();
            }
        };
        pageWindow.addEventListener("resize", onResize, { passive: true });
        pageWindow.addEventListener("storage", onStorage);
        this.cleanups.push(() => {
            clearInterval(tick);
            clearTimeout(this.tipTimer);
            pageWindow.removeEventListener("resize", onResize);
            pageWindow.removeEventListener("storage", onStorage);
        });
    }

    destroy() {
        this.tracker.stop();
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.overlay.destroy();
    }

    get host() {
        return this.overlay.host;
    }

    private bind() {
        const orb = this.q(".orb");
        orb.addEventListener("click", () => {
            if (this.service.state.canRefresh) this.service.refreshNow();
            openStats(this.stats);
        });
        const showToday = (value: boolean) => {
            clearTimeout(this.tipTimer);
            if (!value || !this.stats.enabled()) return void this.setTipToday(false);
            const delay = this.stats.hoverDelay();
            if (delay <= 0) this.setTipToday(true);
            else this.tipTimer = setTimeout(() => this.setTipToday(true), delay * 1000) as unknown as number;
        };
        orb.addEventListener("pointerenter", () => showToday(true));
        orb.addEventListener("pointerleave", () => showToday(false));
        orb.addEventListener("focus", () => showToday(true));
        orb.addEventListener("blur", () => showToday(false));
    }

    private setTipToday(value: boolean) {
        if (value) this.stats.refresh();
        this.tipToday = value;
        this.render();
    }

    /** Today's share of the monthly allowance, or null when stats are off or nothing is known. */
    private todayText() {
        if (!this.stats.enabled()) return null;
        const day = readDay(this.stats.space());
        return day ? statDelta(usedOn(day) ?? 0) : null;
    }

    private place(point: Point) {
        const { host } = this.overlay;
        host.style.left = `${Math.round(point.left)}px`;
        host.style.top = `${Math.round(point.top)}px`;
        host.style.right = "auto";
    }

    layout(composer: Box | null = this.tracker.current) {
        const { host } = this.overlay;
        // On AI pages the rings belong to the composer: stay out of sight while Notion is still
        // rendering its loading skeleton, so nothing appears in an empty page.
        host.hidden = isAiRoute() && !composer;
        if (host.hidden) return;
        const vp = viewport();
        const orb = this.q(".orb");
        const size = boxOf(orb);
        const point = composer ? dockPoint(composer, size, vp) : null;
        host.toggleAttribute("data-docked", !!point);
        host.dataset.side = point ? "left" : this.anchor.xEdge;
        const target = point ?? pointFromAnchor(this.anchor, vp, size);
        host.toggleAttribute("data-tip-up", vp.height - (target.top + size.height) < TIP_SPACE);
        this.place({ left: 0, top: 0 });
        const hostBox = boxOf(host);
        const orbNow = boxOf(orb);
        this.place({ left: target.left - (orbNow.left - hostBox.left), top: target.top - (orbNow.top - hostBox.top) });
    }

    private setText(selector: string, text: string) {
        const el = this.q(selector);
        el.textContent = text;
        el.hidden = !text;
    }

    render() {
        const now = Date.now();
        const { snapshot, loading, error, spaceId } = this.service.state;
        const billing = visibleBilling(this.service.state.billing, now);
        const views = meterViews(snapshot, now);

        for (const [selector, view] of [[".r-rolling", views.rolling], [".r-monthly", views.monthly]] as const) {
            const ring = this.q(selector);
            const percent = Math.min(100, Math.max(0, view.percent ?? 0));
            ring.querySelector(".ring-fill")!.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - percent / 100)));
            // A round cap still draws a dot at 0%; hide the fill until there is something to show.
            ring.toggleAttribute("data-empty", view.percent == null || view.percent <= 0);
            ring.dataset.tone = view.tone;
        }

        const applicable = !!snapshot && snapshot.status !== "not_applicable";
        const rolling = applicable ? snapshot.rolling : null;
        const monthly = applicable ? activeMonthly(snapshot, now) : null;
        const rollingText = formatPercent(views.rolling.percent);
        const monthlyText = formatPercent(views.monthly.percent);
        // Stacked label / value / reset blocks like Void++'s UsagePanel: one meter per column, so
        // no column is stretched by the longest free text of another row.
        const used = (text: string) => text === "—" ? text : t(`已用 ${text}`, `${text} used`);
        this.q(".tip-l-rolling").textContent = t("6 小时", "6-hour");
        this.q(".tip-v-rolling").textContent = used(rollingText);
        this.setText(".tip-w-rolling", rolling ? formatCountdown(rolling.resetAt, now, rolling.used) : "");
        this.q(".tip-l-monthly").textContent = t("月度", "Monthly");
        this.q(".tip-v-monthly").textContent = used(monthlyText);
        this.setText(".tip-w-monthly", monthly ? formatCountdown(monthly.resetAt, now, monthly.used) : "");

        const todayText = this.todayText();
        this.q(".today").hidden = !(this.tipToday && todayText !== null && !!monthly);
        this.q(".tip-l-today").textContent = t("今天", "Today");
        this.q(".tip-v-today").textContent = todayText === null ? "" : t(`占月度额度 ${todayText}`, `${todayText} of monthly`);

        const plan = this.stats.showPlan() && billing ? billingRow(billing, now) : null;
        this.q(".plan").hidden = !plan;
        if (plan && billing) {
            // The card's "Current period ends …" line is too long for a tooltip; keep the date only.
            const planWhen = billing.kind === "subscription" && billing.periodEndAt !== null
                ? t(`周期至 ${formatDate(billing.periodEndAt)}`, `until ${formatDate(billing.periodEndAt)}`)
                : billing.kind === "trial" ? t(`${formatDate(billing.endAt)} 结束`, `ends ${formatDate(billing.endAt)}`) : "";
            this.q(".tip-l-plan").textContent = plan.label;
            this.q(".tip-v-plan").textContent = plan.value;
            this.setText(".tip-w-plan", planWhen);
        }

        let note = "";
        let kind: "info" | "error" = error ? "error" : "info";
        if (!snapshot) {
            note = error || (loading || spaceId ? t("正在读取 Notion AI 用量…", "Loading Notion AI usage…") : t("等待 Notion 初始化当前工作区", "Waiting for Notion to set up this workspace"));
        } else if (snapshot.status === "not_applicable") {
            note = error || t("当前账户或套餐没有 AI 用量窗口", "This account or plan has no AI usage window");
        } else if (snapshot.status === "rate_limited") {
            kind = "error";
            note = snapshot.limitedBy === "billing_period"
                ? t("已达到月度额度上限", "The monthly allowance has been reached")
                : t("已达到 6 小时额度上限", "The 6-hour allowance has been reached");
        } else if (error) {
            note = t(`${error}（显示最后一次有效数据）`, `${error} (showing the last valid data)`);
        }
        const noteEl = this.q(".tip-note");
        noteEl.textContent = note;
        noteEl.hidden = !note;
        noteEl.dataset.kind = kind;

        this.q(".orb").setAttribute("aria-label", !applicable
            ? t("AI 用量，点击按日期查看", "AI usage, click for usage by date")
            : t(`AI 用量：6 小时 ${rollingText}，月度 ${monthlyText}，点击按日期查看`, `AI usage: 6h ${rollingText}, Monthly ${monthlyText}, click for usage by date`));
        this.layout();
    }
}
