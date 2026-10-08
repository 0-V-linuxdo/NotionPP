/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { clamp, finiteNumber, isRecord, safeJson } from "@utils/guards";
import { pageWindow, t, uiLanguage } from "@utils/page";

/*
 * Daily usage of the monthly allowance, kept per workspace on this device.
 * A day is a run of segments: each segment starts at the first percent seen and ends at
 * the last one. A billing reset (resetAt moves, or the percent falls sharply) closes the
 * open segment into `carried` and starts a new one, so a reset mid-day keeps what was used.
 */

export const STATS_PREFIX = "notionai-pp:usage-stats:v1:";
export const RESET_DROP = 5;
export const RESET_TOLERANCE_MS = 60_000;
export const RETAIN = { min: 7, max: 180, default: 90 } as const;
export const HOVER_DELAY = { min: 0, max: 5, default: 1 } as const;
export const CHART_DAYS = 7;
export const CHART_FLOOR = 20;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DayRecord {
    date: string;
    first: number | null;
    last: number | null;
    resetAt: number | null;
    /** Usage from segments closed by a reset earlier the same day. */
    carried: number;
    /** The last closed segment, shown in the day's breakdown. */
    closedFirst: number | null;
    closedLast: number | null;
    updatedAt: number;
}

const memory = new Map<string, string>();

function read(key: string) {
    try {
        return pageWindow.localStorage.getItem(key);
    } catch {
        return memory.get(key) ?? null;
    }
}

function write(key: string, value: string | null) {
    try {
        if (value === null) pageWindow.localStorage.removeItem(key);
        else pageWindow.localStorage.setItem(key, value);
    } catch {
        if (value === null) memory.delete(key);
        else memory.set(key, value);
    }
}

const percentOf = (value: unknown) => {
    const n = finiteNumber(value);
    return n === null ? null : clamp(n, 0, 100);
};

export function dateKey(at: number) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function shiftDate(date: string, days: number) {
    const [y, m, d] = date.split("-").map(Number);
    return y && m && d ? dateKey(new Date(y, m - 1, d + days).getTime()) : date;
}

export const emptyDay = (date: string, now: number): DayRecord => ({
    date, first: null, last: null, resetAt: null, carried: 0, closedFirst: null, closedLast: null, updatedAt: now,
});

function parseDay(date: string, raw: unknown): DayRecord | null {
    if (!DATE_RE.test(date) || !isRecord(raw)) return null;
    return {
        date,
        first: percentOf(raw.first),
        last: percentOf(raw.last),
        resetAt: finiteNumber(raw.resetAt),
        carried: Math.max(0, finiteNumber(raw.carried) ?? 0),
        closedFirst: percentOf(raw.closedFirst),
        closedLast: percentOf(raw.closedLast),
        updatedAt: finiteNumber(raw.updatedAt) ?? 0,
    };
}

export function loadDays(space: string): Map<string, DayRecord> {
    const days = new Map<string, DayRecord>();
    if (!space) return days;
    const raw = safeJson(read(STATS_PREFIX + space) ?? "");
    if (!isRecord(raw) || !isRecord(raw.days)) return days;
    for (const [date, value] of Object.entries(raw.days)) {
        const day = parseDay(date, value);
        if (day) days.set(date, day);
    }
    return days;
}

export function prune(days: Map<string, DayRecord>, retain: number, now: number) {
    const keep = clamp(Math.floor(retain), RETAIN.min, RETAIN.max);
    const cutoff = shiftDate(dateKey(now), 1 - keep);
    for (const date of [...days.keys()]) if (date < cutoff) days.delete(date);
    return days;
}

function saveDay(space: string, day: DayRecord, retain: number, now: number) {
    const days = loadDays(space);
    days.set(day.date, day);
    prune(days, retain, now);
    write(STATS_PREFIX + space, JSON.stringify({ days: Object.fromEntries(days) }));
    return days.get(day.date) ?? day;
}

function closeSegment(day: DayRecord, percent: number | null) {
    if (day.first !== null && day.last !== null) {
        day.carried += Math.max(0, day.last - day.first);
        day.closedFirst = day.first;
        day.closedLast = day.last;
    }
    day.first = percent;
    day.last = percent;
}

export function applySnapshot(day: DayRecord, percent: number | null, resetAt: number | null, now: number): DayRecord {
    const next = { ...day, updatedAt: now };
    if (resetAt !== null && next.resetAt !== null && Math.abs(resetAt - next.resetAt) >= RESET_TOLERANCE_MS) {
        closeSegment(next, percent);
        next.resetAt = resetAt;
        return next;
    }
    if (resetAt !== null) next.resetAt = resetAt;
    if (percent === null) return next;
    if (next.last !== null && percent < next.last - RESET_DROP) {
        closeSegment(next, percent);
        return next;
    }
    if (next.first === null) next.first = percent;
    next.last = percent;
    return next;
}

/** Percent of the monthly allowance used that day, or null when nothing was seen. */
export function usedOn(day: DayRecord) {
    if (day.first === null || day.last === null) return day.carried > 0 ? day.carried : null;
    return day.carried + Math.max(0, day.last - day.first);
}

export function recordSnapshot(space: string, percent: number | null, resetAt: number | null, retain: number, now = Date.now()) {
    if (!space) return null;
    const date = dateKey(now);
    const current = loadDays(space).get(date) ?? emptyDay(date, now);
    return saveDay(space, applySnapshot(current, percent, resetAt, now), retain, now);
}

export function writeDay(space: string, day: DayRecord, retain: number, now = Date.now()) {
    return space && DATE_RE.test(day.date) ? saveDay(space, { ...day, updatedAt: now }, retain, now) : null;
}

export const readDay = (space: string, now = Date.now()) => loadDays(space).get(dateKey(now)) ?? null;

export const clearDays = (space: string) => void (space && write(STATS_PREFIX + space, null));

/**
 * A reset before the first visit of the day leaves only the new period's ~0% on record,
 * which hides what was used before it. The previous day's last percent marks where it started.
 */
export function looksWiped(day: DayRecord, previous: DayRecord | null) {
    if (day.carried > 0 || day.closedLast !== null || day.first === null || day.last === null) return false;
    if (day.first > RESET_DROP) return false;
    return previous?.last != null && previous.last > day.first + RESET_DROP;
}

export function repairWiped(day: DayRecord, dayStart: number, beforeReset: number, now = Date.now()): DayRecord {
    const start = clamp(dayStart, 0, 100);
    const before = clamp(beforeReset, 0, 100);
    return { ...day, carried: Math.max(0, before - start), closedFirst: start, closedLast: before, updatedAt: now };
}

/** At least a week of bars ending today, reaching back to the oldest record. */
export function chartDays(days: Map<string, DayRecord>, now = Date.now()) {
    const today = dateKey(now);
    let start = shiftDate(today, 1 - CHART_DAYS);
    for (const date of days.keys()) if (date < start) start = date;
    const out: DayRecord[] = [];
    for (let date = start; date <= today; date = shiftDate(date, 1)) out.push(days.get(date) ?? emptyDay(date, now));
    return out;
}

export function chartScale(days: DayRecord[]) {
    const max = Math.max(0, ...days.map(day => usedOn(day) ?? 0));
    return Math.max(CHART_FLOOR, Math.ceil(max / 10) * 10);
}

export function statPercent(value: number | null) {
    if (value === null || !Number.isFinite(value)) return "—";
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

export const statDelta = (value: number | null) => value === null ? "—" : value > 0 ? `+${statPercent(value)}` : statPercent(value);

export function dayLabel(date: string, today = dateKey(Date.now())) {
    if (date === today) return t("今天", "Today");
    const [y, m, d] = date.split("-").map(Number);
    if (!y || !m || !d) return date;
    return new Date(y, m - 1, d).toLocaleDateString(uiLanguage() === "zh" ? "zh-CN" : "en", { weekday: "short", month: "short", day: "numeric" });
}

export const dayNumber = (date: string) => String(Number(date.split("-")[2]) || date);
