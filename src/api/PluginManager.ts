/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { getValue, onSettingsChange, type OptionsDef, type PluginSettings, setValue } from "@api/Settings";
import { Logger } from "@utils/Logger";
import type { Text } from "@utils/page";

const logger = new Logger("PluginManager");

export const enum StartAt {
    DocumentStart = "DocumentStart",
    DomReady = "DomReady",
}

export type PluginTag = "composer" | "chat" | "home" | "appearance";

export interface PluginDef {
    name: string;
    title: Text;
    description: Text;
    /** Inner markup of a 24×24 stroke icon (lucide style) for the settings card. */
    icon?: string;
    tags?: PluginTag[];
    /** Shown in the settings card footer, as Void++ shows plugin authors. */
    authors?: string[];
    enabledByDefault: boolean;
    required?: boolean;
    startAt?: StartAt;
    /** Turning it on or off only fully applies after a page reload (it hooks things the page grabs at load). */
    restartNeeded?: boolean;
    /** The day (YYYY-MM-DD) its behaviour last changed, for the settings panel's "Recently updated". */
    updatedAt?: string;
    settings?: PluginSettings<OptionsDef>;
    start(): void;
    stop(): void;
    onSettingsChange?(key: string): void;
}

export interface Plugin extends PluginDef {
    started: boolean;
}

export const definePlugin = (def: PluginDef): Plugin => ({ ...def, started: false });

const plugins = new Map<string, Plugin>();

export interface PluginError {
    /** Where it was thrown: starting, stopping, or applying a settings change. */
    stage: "start" | "stop" | "settings";
    message: string;
    at: number;
}

const errors = new Map<string, PluginError>();
type ErrorListener = (name: string) => void;
const errorListeners = new Set<ErrorListener>();

/** The last error a plugin threw from start, stop or onSettingsChange, until it starts cleanly again. */
export const pluginError = (name: string) => errors.get(name) ?? null;

export function onPluginError(listener: ErrorListener) {
    errorListeners.add(listener);
    return () => void errorListeners.delete(listener);
}

function fail(plugin: Plugin, stage: PluginError["stage"], error: unknown) {
    logger.error(`${plugin.name} failed to ${stage === "settings" ? "apply settings" : stage}:`, error);
    const message = error instanceof Error ? error.message || error.name : String(error);
    errors.set(plugin.name, { stage, message: message.slice(0, 300), at: Date.now() });
    for (const listener of [...errorListeners]) {
        try {
            listener(plugin.name);
        } catch {}
    }
}

export const allPlugins = () => [...plugins.values()];

export function isEnabled(plugin: Plugin) {
    if (plugin.required) return true;
    const value = getValue(plugin.name, "enabled");
    return typeof value === "boolean" ? value : plugin.enabledByDefault;
}

function startPlugin(plugin: Plugin) {
    if (plugin.started) return;
    try {
        plugin.start();
        plugin.started = true;
        errors.delete(plugin.name);
    } catch (error) {
        fail(plugin, "start", error);
    }
}

function stopPlugin(plugin: Plugin) {
    if (!plugin.started) return;
    plugin.started = false;
    try {
        plugin.stop();
    } catch (error) {
        fail(plugin, "stop", error);
    }
}

export function setEnabled(plugin: Plugin, enabled: boolean) {
    setValue(plugin.name, "enabled", enabled);
}

export function registerPlugins(list: Plugin[]) {
    for (const plugin of list) {
        plugin.settings?.bind(plugin.name);
        plugins.set(plugin.name, plugin);
        bootEnabled.set(plugin.name, isEnabled(plugin));
    }
    trackNewPlugins();
}

/* ---------- reload needed ---------- */

/** Each plugin's on/off state when the page loaded. */
const bootEnabled = new Map<string, boolean>();

/** Plugins switched since the page loaded that only fully apply after a reload; switching back clears them. */
export const pendingRestart = () => allPlugins().filter(p => p.restartNeeded && bootEnabled.has(p.name) && bootEnabled.get(p.name) !== isEnabled(p));

/* ---------- new and recently updated ---------- */

export const SEEN_KEY = "notionai-pp:plugins-seen:v1";
export const NEW_FOR_MS = 2 * 24 * 60 * 60 * 1000;
export const UPDATED_FOR_MS = 7 * 24 * 60 * 60 * 1000;
let seen: Record<string, number> = {};

/**
 * Like Void++'s trackNewPlugins: remembers when each plugin was first seen. On the very first
 * run everything counts as old, so a fresh install does not flag every plugin as new.
 */
function trackNewPlugins(now = Date.now()) {
    let stored: unknown = null;
    try {
        stored = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null");
    } catch {}
    const first = !stored || typeof stored !== "object";
    seen = first ? {} : { ...(stored as Record<string, number>) };
    let changed = first;
    for (const name of plugins.keys()) {
        if (typeof seen[name] === "number") continue;
        seen[name] = first ? 0 : now;
        changed = true;
    }
    if (!changed) return;
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {}
}

export const isNewPlugin = (name: string, now = Date.now()) => (seen[name] ?? 0) > 0 && now - seen[name] < NEW_FOR_MS;

export function isRecentlyUpdated(plugin: Plugin, now = Date.now()) {
    if (isNewPlugin(plugin.name, now)) return true;
    const at = plugin.updatedAt ? Date.parse(plugin.updatedAt) : NaN;
    return Number.isFinite(at) && now - at < UPDATED_FOR_MS && now >= at;
}

let phase: StartAt | null = null;

export function startPlugins(at: StartAt) {
    phase = at;
    for (const plugin of plugins.values()) {
        if ((plugin.startAt ?? StartAt.DomReady) !== at && at === StartAt.DocumentStart) continue;
        if (isEnabled(plugin)) startPlugin(plugin);
    }
    if (at === StartAt.DomReady) scheduleRetries();
}

/**
 * Like Void++'s retryFailedPlugins: Notion builds the AI view well after DOMContentLoaded, so a
 * plugin that failed to start then gets a few more tries as the page fills in.
 */
export const RETRY_DELAYS_MS = [1500, 4000, 10000];
let retryTimers: number[] = [];

function scheduleRetries() {
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers = RETRY_DELAYS_MS.map(delay => setTimeout(retryFailed, delay) as unknown as number);
}

export function retryFailed() {
    for (const plugin of plugins.values()) {
        if (plugin.started || !isEnabled(plugin) || errors.get(plugin.name)?.stage !== "start") continue;
        logger.info(`Retrying ${plugin.name}`);
        // Undo whatever the failed start got done before trying again.
        try {
            plugin.stop();
        } catch {}
        startPlugin(plugin);
    }
}

onSettingsChange((name, key) => {
    for (const plugin of plugins.values()) {
        if (name !== "*" && name !== plugin.name) continue;
        const ready = phase === StartAt.DomReady || plugin.startAt === StartAt.DocumentStart;
        if (key === "enabled" || key === "*") {
            if (isEnabled(plugin) && ready) startPlugin(plugin);
            else if (!isEnabled(plugin)) stopPlugin(plugin);
        }
        if (key !== "enabled" && plugin.started) {
            try {
                plugin.onSettingsChange?.(key);
            } catch (error) {
                fail(plugin, "settings", error);
            }
        }
    }
});
