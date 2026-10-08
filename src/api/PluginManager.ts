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
    }
}

let phase: StartAt | null = null;

export function startPlugins(at: StartAt) {
    phase = at;
    for (const plugin of plugins.values()) {
        if ((plugin.startAt ?? StartAt.DomReady) !== at && at === StartAt.DocumentStart) continue;
        if (isEnabled(plugin)) startPlugin(plugin);
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
