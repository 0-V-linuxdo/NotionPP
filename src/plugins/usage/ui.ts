/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { emit } from "@api/Events";
import { createOverlay, type Overlay } from "@api/Overlay";
import { onRouteChange } from "@api/Router";
import { boxOf, type Box, viewport } from "@utils/dom";
import { safeJson } from "@utils/guards";
import { isAiRoute, pageWindow, t } from "@utils/page";

import { visibleBilling } from "./billing";
import { ComposerTracker } from "./composer";
import { billingRow, billingSummary, formatAbsolute, formatPercent, formatReset, formatUpdated, windowLabel } from "./format";
import { type Anchor, anchorFromBox, dockPoint, dragDistanceReached, opensUpward, parseAnchor, type Point, pointFromAnchor } from "./geometry";
import type { UsageService } from "./service";
import { readDay, statDelta, usedOn } from "./stats";
import { openStats, type StatsContext } from "./statsDialog";
import { USAGE_CSS, USAGE_HTML } from "./styles";
import { activeMonthly, type Meter, meterViews, toneOf } from "./verdict";

export const HOST_ID = "notionai-pp-usage";
export const KEYS = {
    anchor: "notionai-pp:usage:anchor:v1",
    expanded: "notionai-pp:usage:expanded:v1",
    minimized: "notionai-pp:usage:minimized:v1",
    legacyAnchor: "notion-ai-usage:position:v2",
} as const;
const DEFAULT_ANCHOR: Anchor = { xEdge: "right", xOffset: 16, yEdge: "top", yOffset: 16 };
const TIP_SPACE = 64;
const CARD_GAP = 7;
const CLICK_GUARD_MS = 500;
const TICK_MS = 15_000;

function readFlag(key: string) {
    try {
        return pageWindow.localStorage.getItem(key) === "1";
    } catch {
        return false;
    }
}

function writeFlag(key: string, value: boolean) {
    try {
        pageWindow.localStorage.setItem(key, value ? "1" : "0");
    } catch {}
}

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
}

export class UsageWidget {
    private overlay: Overlay;
    private q: <T extends Element = HTMLElement>(selector: string) => T;
    private expanded = readFlag(KEYS.expanded);
    private minimized = readFlag(KEYS.minimized);
    private anchor: Anchor = readAnchor() ?? DEFAULT_ANCHOR;
    private dragging = false;
    private suppressClickUntil = 0;
    private tracker = new ComposerTracker(box => this.layout(box));
    private cleanups: (() => void)[] = [];
    private tipToday = false;
    private tipTimer = 0;

    constructor(private readonly service: UsageService, private readonly stats: WidgetStats) {
        this.overlay = createOverlay(HOST_ID, USAGE_CSS, USAGE_HTML);
        const { root } = this.overlay;
        this.q = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
        this.bind();
        this.applyMode();
        this.render();
        this.cleanups.push(service.onChange(() => this.render()));
        this.cleanups.push(onRouteChange(() => this.layout()));
        this.tracker.start();
        const tick = setInterval(() => this.render(), TICK_MS);
        const onResize = () => this.layout();
        const onStorage = (event: StorageEvent) => this.onStorage(event);
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
        const toggle = this.q(".toggle");
        toggle.addEventListener("click", () => {
            if (Date.now() < this.suppressClickUntil) return;
            this.setExpanded(!this.expanded);
        });
        this.q(".minimize").addEventListener("click", () => {
            this.setMinimized(true);
            this.q(".orb").focus({ preventScroll: true });
        });
        this.q(".orb").addEventListener("click", () => {
            this.setMinimized(false);
            toggle.focus({ preventScroll: true });
        });
        const orb = this.q(".orb");
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
        const today = this.q(".m-today");
        today.addEventListener("click", () => openStats(this.stats));
        today.addEventListener("keydown", event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openStats(this.stats);
        });
        this.q(".stats").addEventListener("click", () => openStats(this.stats));
        this.q(".refresh").addEventListener("click", () => this.service.refreshNow());
        this.q(".settings").addEventListener("click", () => emit("openSettings", undefined));
        this.q(".native").addEventListener("click", () => {
            const url = new URL(pageWindow.location.href);
            url.searchParams.set("target", "aiusage");
            pageWindow.location.assign(url.href);
        });
        this.installDrag(this.q(".summary"), ".minimize");
        this.installDrag(this.q(".header"), "button");
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

    private setExpanded(value: boolean) {
        this.expanded = value;
        writeFlag(KEYS.expanded, value);
        this.applyMode();
    }

    private setMinimized(value: boolean) {
        this.minimized = value;
        writeFlag(KEYS.minimized, value);
        this.applyMode();
    }

    private applyMode() {
        this.q(".orb").hidden = !this.minimized;
        this.q(".tip").hidden = !this.minimized;
        this.q(".summary").hidden = this.minimized;
        this.q(".card").hidden = this.minimized || !this.expanded;
        const toggle = this.q(".toggle");
        toggle.setAttribute("aria-expanded", String(this.expanded));
        this.layout();
    }

    private place(point: Point) {
        const { host } = this.overlay;
        host.style.left = `${Math.round(point.left)}px`;
        host.style.top = `${Math.round(point.top)}px`;
        host.style.right = "auto";
    }

    layout(composer: Box | null = this.tracker.current) {
        if (this.dragging) return;
        const { host } = this.overlay;
        // On AI pages the widget belongs to the composer: stay out of sight while Notion is still
        // rendering its loading skeleton, so nothing appears in an empty page.
        host.hidden = isAiRoute() && !composer;
        if (host.hidden) return;
        const vp = viewport();
        if (this.minimized) {
            const orb = boxOf(this.q(".orb"));
            const point = composer ? dockPoint(composer, orb, vp) : null;
            host.toggleAttribute("data-docked", !!point);
            host.removeAttribute("data-up");
            if (point) {
                host.dataset.side = "left";
                this.place(point);
                host.toggleAttribute("data-tip-up", vp.height - (point.top + orb.height) < TIP_SPACE);
                return;
            }
        } else {
            host.removeAttribute("data-docked");
        }
        const handle = this.q(this.minimized ? ".orb" : ".summary");
        host.dataset.side = this.anchor.xEdge;
        const handleSize = boxOf(handle);
        const target = pointFromAnchor(this.anchor, vp, handleSize);
        const cardHeight = this.expanded && !this.minimized ? boxOf(this.q(".card")).height + CARD_GAP : 0;
        const handleBox = { ...target, right: target.left + handleSize.width, bottom: target.top + handleSize.height, width: handleSize.width, height: handleSize.height };
        host.toggleAttribute("data-up", cardHeight > 0 && opensUpward(handleBox, cardHeight, vp));
        host.toggleAttribute("data-tip-up", vp.height - handleBox.bottom < TIP_SPACE);
        this.place({ left: 0, top: 0 });
        const hostBox = boxOf(host);
        const handleNow = boxOf(handle);
        this.place({ left: target.left - (handleNow.left - hostBox.left), top: target.top - (handleNow.top - hostBox.top) });
    }

    private installDrag(handle: HTMLElement, ignore: string) {
        handle.addEventListener("pointerdown", event => {
            if (event.button !== 0 || !event.isPrimary || this.minimized) return;
            if ((event.target as Element).closest(ignore)) return;
            const { host } = this.overlay;
            const start = { x: event.clientX, y: event.clientY };
            const origin = boxOf(host);
            const shell = this.q(".shell");
            let moved = false;
            const move = (e: PointerEvent) => {
                if (e.pointerId !== event.pointerId) return;
                const dx = e.clientX - start.x;
                const dy = e.clientY - start.y;
                if (!moved && !dragDistanceReached(dx, dy)) return;
                moved = true;
                this.dragging = true;
                shell.classList.add("dragging");
                const vp = viewport();
                this.place({
                    left: Math.min(Math.max(8, origin.left + dx), Math.max(8, vp.width - origin.width - 8)),
                    top: Math.min(Math.max(8, origin.top + dy), Math.max(8, vp.height - origin.height - 8)),
                });
            };
            const end = (e: Event) => {
                if (e instanceof PointerEvent && e.pointerId !== event.pointerId) return;
                pageWindow.removeEventListener("pointermove", move, true);
                pageWindow.removeEventListener("pointerup", end, true);
                pageWindow.removeEventListener("pointercancel", end, true);
                shell.classList.remove("dragging");
                this.dragging = false;
                if (!moved) return;
                this.suppressClickUntil = Date.now() + CLICK_GUARD_MS;
                if (e.type === "pointerup") {
                    this.anchor = anchorFromBox(boxOf(this.q(".summary")), viewport());
                    try {
                        pageWindow.localStorage.setItem(KEYS.anchor, JSON.stringify(this.anchor));
                    } catch {}
                }
                this.layout();
            };
            pageWindow.addEventListener("pointermove", move, true);
            pageWindow.addEventListener("pointerup", end, true);
            pageWindow.addEventListener("pointercancel", end, true);
        });
    }

    private onStorage(event: StorageEvent) {
        if (event.key === KEYS.anchor) {
            const anchor = parseAnchor(safeJson(event.newValue ?? ""));
            if (anchor && !this.dragging) {
                this.anchor = anchor;
                this.layout();
            }
        }
    }

    private renderMeter(selector: string, meter: Meter | null, label: string, now: number) {
        const row = this.q(selector);
        row.hidden = !meter;
        if (!meter) return;
        row.querySelector(".label")!.textContent = label;
        row.querySelector(".value")!.textContent = t(`${formatPercent(meter.percent)} 已使用`, `${formatPercent(meter.percent)} used`);
        row.querySelector(".sub")!.textContent = formatReset(meter.resetAt, now, meter.used);
        const fill = row.querySelector<HTMLElement>(".fill")!;
        fill.style.width = `${meter.percent}%`;
        fill.dataset.tone = toneOf(meter.percent);
        row.title = t(
            `${meter.used} / ${meter.limit}；重置时间：${formatAbsolute(meter.resetAt)}`,
            `${meter.used} / ${meter.limit}; resets: ${formatAbsolute(meter.resetAt)}`,
        );
    }

    private renderSummary(parts: { text: string; sep?: "usage" | "billing" }[]) {
        const container = this.q(".text");
        const signature = parts.map(p => `${p.sep ?? ""}:${p.text}`).join("|");
        if (container.dataset.signature === signature) return;
        container.dataset.signature = signature;
        container.replaceChildren(...parts.map(part => {
            const span = document.createElement("span");
            span.className = "part";
            if (part.sep) span.dataset.sep = part.sep;
            span.textContent = part.text;
            return span;
        }));
        this.layout();
    }

    render() {
        const now = Date.now();
        const { snapshot, loading, error, canRefresh, spaceId } = this.service.state;
        const billing = visibleBilling(this.service.state.billing, now);
        const billingPart = billingSummary(billing, now);
        const views = meterViews(snapshot, now);

        this.q(".title-text").textContent = t("Notion AI 用量", "Notion AI Usage");
        const badge = this.q(".badge");
        badge.hidden = !snapshot?.preview;
        badge.title = t("Notion 当前将此额度标记为 preview。", "Notion currently marks this allowance as preview.");
        const refresh = this.q<HTMLButtonElement>(".refresh");
        refresh.disabled = !canRefresh;
        refresh.classList.toggle("spin", loading);
        refresh.setAttribute("aria-label", loading ? t("正在读取", "Loading") : t("刷新", "Refresh"));
        refresh.title = refresh.getAttribute("aria-label")!;
        for (const [selector, zh, en] of [
            [".minimize", "最小化至输入框底部", "Minimize to the composer"],
            [".settings", "NotionAI++ 设置", "NotionAI++ settings"],
            [".stats", "按日期查看用量", "Usage by date"],
            [".native", "打开原生用量页", "Open native Usage page"],
        ] as const) {
            const button = this.q(selector);
            button.setAttribute("aria-label", t(zh, en));
            button.title = t(zh, en);
        }

        for (const [selector, view] of [[".r-rolling", views.rolling], [".r-monthly", views.monthly]] as const) {
            const ring = this.q(selector);
            ring.style.setProperty("--p", String(view.percent ?? 0));
            ring.dataset.tone = view.tone;
        }
        const rollingText = formatPercent(views.rolling.percent);
        const monthlyText = formatPercent(views.monthly.percent);
        this.q(".tip-title").textContent = t("AI 用量", "AI usage");
        this.q(".tip-detail").textContent = t(`6 小时 ${rollingText} · 月度 ${monthlyText}`, `6h ${rollingText} · Monthly ${monthlyText}`);
        const todayText = this.todayText();
        const tipToday = this.q(".tip-today");
        tipToday.hidden = !this.tipToday || todayText === null;
        tipToday.textContent = t(`今天 ${todayText} 月度额度`, `Today ${todayText} of monthly allowance`);
        const todayRow = this.q(".m-today");
        todayRow.hidden = todayText === null || !snapshot || snapshot.status === "not_applicable" || !activeMonthly(snapshot, now);
        todayRow.querySelector(".label")!.textContent = t("今日用量", "Used today");
        todayRow.querySelector(".value")!.textContent = t(`${todayText} 月度额度`, `${todayText} of monthly`);
        todayRow.querySelector(".sub")!.textContent = t("点击按日期查看用量 →", "Click for usage by date →");
        this.q(".orb").setAttribute("aria-label", !snapshot
            ? t("AI 用量：6 小时与月度等待读取，点击恢复", "AI usage: 6h and Monthly waiting, click to restore")
            : snapshot.status === "not_applicable"
                ? t("AI 用量：6 小时与月度均不适用，点击恢复", "AI usage: 6h and Monthly are not applicable, click to restore")
                : snapshot.status === "rate_limited"
                    ? t(`AI 用量：6 小时 ${rollingText}，月度 ${monthlyText}，已达上限，点击恢复`, `AI usage: 6h ${rollingText}, Monthly ${monthlyText}, limit reached, click to restore`)
                    : t(`AI 用量：6 小时 ${rollingText}，月度 ${monthlyText}，点击恢复`, `AI usage: 6h ${rollingText}, Monthly ${monthlyText}, click to restore`));

        const notice = this.q(".notice");
        const dot = this.q(".dot");
        const billingPiece = billingPart ? [{ text: billingPart, sep: "billing" as const }] : [];
        let noticeText = "";
        let noticeKind: "info" | "error" = error ? "error" : "info";
        if (!snapshot) {
            this.renderSummary([{ text: loading ? t("读取中", "Loading") : t("等待", "Waiting") }, ...billingPiece]);
            dot.dataset.status = error ? "error" : "waiting";
            noticeText = error || (spaceId
                ? t("正在读取 Notion AI 用量…", "Loading Notion AI usage…")
                : t("等待 Notion 初始化当前工作区；也可以打开原生用量页触发读取。", "Waiting for Notion to initialize this workspace. You can also open the native Usage page."));
            this.renderMeter(".m-rolling", null, "", now);
            this.renderMeter(".m-monthly", null, "", now);
        } else if (snapshot.status === "not_applicable") {
            this.renderSummary([{ text: t("不适用", "Not applicable") }, ...billingPiece]);
            dot.dataset.status = "neutral";
            noticeText = error || t("Notion 返回 not_applicable：当前账户或套餐没有可展示的 AI 用量窗口。", "Notion returned not_applicable: this account or plan has no AI usage window to display.");
            this.renderMeter(".m-rolling", null, "", now);
            this.renderMeter(".m-monthly", null, "", now);
        } else {
            const monthly = activeMonthly(snapshot, now);
            this.renderSummary([
                { text: formatPercent(snapshot.rolling.percent) },
                ...(monthly ? [{ text: formatPercent(monthly.percent), sep: "usage" as const }] : []),
                ...billingPiece,
            ]);
            dot.dataset.status = snapshot.status === "rate_limited" || error ? "error" : "ok";
            this.renderMeter(".m-rolling", snapshot.rolling, windowLabel(snapshot.rolling.window), now);
            this.renderMeter(".m-monthly", monthly, t("月度用量", "Monthly usage"), now);
            if (snapshot.status === "rate_limited") {
                noticeKind = "error";
                noticeText = snapshot.limitedBy === "billing_period"
                    ? t("已达到月度额度上限。", "The monthly allowance has been reached.")
                    : t("已达到当前滚动窗口的额度上限。", "The rolling-window allowance has been reached.");
                if (error) noticeText += ` ${error}`;
            } else if (error) {
                noticeText = t(`${error}（继续显示最后一次有效数据）`, `${error} (showing the last valid data)`);
            }
        }
        notice.hidden = !noticeText;
        notice.dataset.kind = noticeKind;
        notice.textContent = noticeText;

        const billingRowEl = this.q(".billing");
        billingRowEl.hidden = !billing;
        if (billing) {
            const row = billingRow(billing, now);
            billingRowEl.querySelector(".label")!.textContent = row.label;
            billingRowEl.querySelector(".value")!.textContent = row.value;
            const sub = billingRowEl.querySelector<HTMLElement>(".sub")!;
            sub.textContent = row.detail;
            sub.hidden = !row.detail;
            billingRowEl.dataset.kind = billing.kind;
            billingRowEl.title = row.tooltip;
        }
        const updatedAt = Math.max(snapshot?.updatedAt ?? 0, billing?.updatedAt ?? 0) || null;
        this.q(".updated").textContent = updatedAt
            ? t(`${formatUpdated(updatedAt, now)} · Notion 同源接口`, `${formatUpdated(updatedAt, now)} · Notion same-origin API`)
            : t("尚未取得有效数据", "No valid data yet");
        if (!this.minimized) this.layout();
    }
}
