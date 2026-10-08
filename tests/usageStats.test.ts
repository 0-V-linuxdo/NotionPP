/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
    applySnapshot, CHART_DAYS, chartDays, chartScale, clearDays, dateKey, type DayRecord, emptyDay, loadDays,
    looksWiped, prune, readDay, recordSnapshot, repairWiped, RESET_DROP, RESET_TOLERANCE_MS, shiftDate, statDelta, usedOn, writeDay,
} from "@plugins/usage/stats";

const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const day = (date: string, ...readings: [number | null, number | null][]) =>
    readings.reduce<DayRecord>((rec, [percent, resetAt], i) => applySnapshot(rec, percent, resetAt, i + 2), emptyDay(date, 1));
const SPACE = "stats-test-space";

beforeEach(() => clearDays(SPACE));

describe("usage stats: one day", () => {
    test("first reading sets both ends; later ones move the last", () => {
        const rec = day("2026-10-08", [12.5, 100], [18, 100]);
        expect([rec.first, rec.last, rec.carried, rec.resetAt]).toEqual([12.5, 18, 0, 100]);
        expect(usedOn(rec)).toBe(5.5);
    });

    test("nothing seen means null, a drop within noise means zero", () => {
        expect(usedOn(emptyDay("2026-10-08", 1))).toBeNull();
        expect(usedOn(day("2026-10-08", [10, 100], [9, 100]))).toBe(0);
    });

    test("a billing reset (resetAt moves) carries the closed segment", () => {
        const rec = day("2026-10-10", [55, 100], [89, 100], [4, 100 + RESET_TOLERANCE_MS]);
        expect([rec.carried, rec.closedFirst, rec.closedLast, rec.first, rec.last]).toEqual([34, 55, 89, 4, 4]);
        expect(usedOn(applySnapshot(rec, 6, 100 + RESET_TOLERANCE_MS, 9))).toBe(36);
    });

    test("a sharp percent drop also counts as a reset", () => {
        const rec = day("2026-10-10", [12.5, 100], [80, 100], [80 - RESET_DROP - 1, 100]);
        expect(rec.carried).toBe(67.5);
        expect(usedOn(rec)).toBe(67.5);
    });

    test("resetAt jitter under the tolerance keeps the segment open", () => {
        const rec = day("2026-10-08", [12.5, 1000], [18, 1000 + RESET_TOLERANCE_MS - 1]);
        expect([rec.first, rec.last, rec.carried]).toEqual([12.5, 18, 0]);
    });

    test("a missing percent changes nothing", () => {
        expect(day("2026-10-08", [12, 100], [null, 100]).last).toBe(12);
    });
});

describe("usage stats: wiped reset repair", () => {
    const wiped = () => day("2026-10-10", [0, 200], [1, 200]);
    const previous = day("2026-10-09", [55, 100], [88, 100]);

    test("spots a ~0% day after a high previous day", () => {
        expect(looksWiped(wiped(), previous)).toBe(true);
        expect(looksWiped(wiped(), null)).toBe(false);
        expect(looksWiped(previous, null)).toBe(false);
    });

    test("restores what was used before the reset", () => {
        const rec = repairWiped(wiped(), 88, 95, 5);
        expect(usedOn(rec)).toBe(8);
        expect(looksWiped(rec, previous)).toBe(false);
    });
});

describe("usage stats: storage", () => {
    test("records per local day and reads today back", () => {
        const now = noon(2026, 10, 8);
        recordSnapshot(SPACE, 40, 100, 90, now);
        recordSnapshot(SPACE, 43.5, 100, 90, now + 60_000);
        expect(usedOn(readDay(SPACE, now)!)).toBe(3.5);
        expect(dateKey(now)).toBe("2026-10-08");
    });

    test("writes a repaired day and clears everything", () => {
        const now = noon(2026, 10, 8);
        writeDay(SPACE, repairWiped(day("2026-10-08", [0, 1], [1, 1]), 88, 89), 90, now);
        expect(usedOn(loadDays(SPACE).get("2026-10-08")!)).toBe(2);
        clearDays(SPACE);
        expect(loadDays(SPACE).size).toBe(0);
    });

    test("keeps only the last retain days, today included", () => {
        const now = noon(2026, 10, 8);
        const days = new Map<string, DayRecord>();
        for (let i = 0; i < 10; i++) {
            const date = shiftDate("2026-10-08", -i);
            days.set(date, emptyDay(date, now));
        }
        expect([...prune(days, 7, now).keys()].sort()[0]).toBe("2026-10-02");
    });

    test("days are kept apart per workspace", () => {
        const now = noon(2026, 10, 8);
        recordSnapshot(SPACE, 40, 100, 90, now);
        expect(readDay("another-space", now)).toBeNull();
    });
});

describe("usage stats: chart", () => {
    test("pads a week ending today and reaches back to older records", () => {
        const now = noon(2026, 10, 8);
        expect(chartDays(new Map(), now).map(d => d.date)).toHaveLength(CHART_DAYS);
        const old = new Map([["2026-09-25", emptyDay("2026-09-25", now)]]);
        const bars = chartDays(old, now);
        expect(bars[0].date).toBe("2026-09-25");
        expect(bars.at(-1)!.date).toBe("2026-10-08");
        expect(shiftDate("2026-09-30", 1)).toBe("2026-10-01");
    });

    test("scale has a 20% floor and rounds up to tens", () => {
        expect(chartScale([day("2026-10-08", [10, 1], [12, 1])])).toBe(20);
        expect(chartScale([day("2026-10-08", [10, 1], [44, 1])])).toBe(40);
    });

    test("deltas format with a sign and one decimal", () => {
        expect(statDelta(null)).toBe("—");
        expect(statDelta(0)).toBe("0%");
        expect(statDelta(4.24)).toBe("+4.2%");
    });
});

describe("usage stats: dialog", () => {
    test("shows a bar per day, today's breakdown, and clears after confirming", async () => {
        const { openStats, closeStats, STATS_HOST_ID } = await import("@plugins/usage/statsDialog");
        const now = Date.now();
        recordSnapshot(SPACE, 40, 100, 90, now - 1000);
        recordSnapshot(SPACE, 46, 100, 90, now);
        let enabled = true;
        const ctx = { space: () => SPACE, enabled: () => enabled, setEnabled: (v: boolean) => void (enabled = v), retain: () => 90, refresh: () => {} };
        openStats(ctx);
        const root = document.getElementById(STATS_HOST_ID)!.shadowRoot!;
        expect(root.querySelectorAll(".bar")).toHaveLength(CHART_DAYS);
        expect(root.querySelector(".bar.on .bar-value")!.textContent).toBe("6%");
        expect(root.querySelector(".formula")!.textContent).toContain("46%");
        [...root.querySelectorAll<HTMLButtonElement>("button")].find(b => /清空历史|Clear history/.test(b.textContent!))!.click();
        [...root.querySelectorAll<HTMLButtonElement>(".layer-confirm button")].find(b => /^(清空|Clear)$/.test(b.textContent!))!.click();
        expect(loadDays(SPACE).size).toBe(0);
        expect(root.querySelectorAll(".bar")).toHaveLength(0);
        closeStats();
        expect(document.getElementById(STATS_HOST_ID)).toBeNull();
    });
});
