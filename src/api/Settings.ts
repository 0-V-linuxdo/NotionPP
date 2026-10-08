/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { isRecord, safeJson } from "@utils/guards";
import { Logger } from "@utils/Logger";
import type { Text } from "@utils/page";

const logger = new Logger("Settings");

export const SETTINGS_KEY = "notionai-pp:settings:v1";

export type OptionValue = string | number | boolean;

export interface BooleanOption {
    type: "boolean";
    label: Text;
    description?: Text;
    default: boolean;
}

export interface SelectOption {
    type: "select";
    label: Text;
    description?: Text;
    default: string;
    options: { value: string; label: Text }[];
}

export interface ColorOption {
    type: "color";
    label: Text;
    description?: Text;
    /** #rrggbb */
    default: string;
}

export const isHexColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export interface NumberOption {
    type: "number";
    label: Text;
    description?: Text;
    default: number;
    min: number;
    max: number;
}

/** A button in the settings dialog; it stores nothing. */
export interface ActionOption {
    type: "action";
    label: Text;
    description?: Text;
    button: Text;
    /** When set, the button asks this question before running. */
    confirm?: Text;
    run(): void;
}

export type OptionDef = BooleanOption | SelectOption | ColorOption | NumberOption | ActionOption;

export type OptionsDef = Record<string, OptionDef>;

export type OptionValues<D extends OptionsDef> = {
    [K in keyof D]: D[K] extends BooleanOption ? boolean : D[K] extends NumberOption ? number : D[K] extends ActionOption ? undefined : string;
};

export type Bag = Record<string, Record<string, OptionValue>>;

type Listener = (plugin: string, key: string) => void;

const listeners = new Set<Listener>();

function read(): Bag {
    try {
        const parsed = safeJson(localStorage.getItem(SETTINGS_KEY) ?? "");
        return isRecord(parsed) ? (parsed as Bag) : {};
    } catch {
        return {};
    }
}

let bag: Bag = read();

function persist() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(bag));
    } catch (error) {
        logger.warn("Settings could not be saved:", error);
    }
}

export function getValue(plugin: string, key: string): OptionValue | undefined {
    return bag[plugin]?.[key];
}

export function setValue(plugin: string, key: string, value: OptionValue) {
    if (bag[plugin]?.[key] === value) return;
    bag = { ...bag, [plugin]: { ...bag[plugin], [key]: value } };
    persist();
    for (const listener of [...listeners]) {
        try {
            listener(plugin, key);
        } catch (error) {
            logger.error("Settings listener failed:", error);
        }
    }
}

/** Drops stored values so the keys fall back to their defaults. */
export function resetValues(plugin: string, keys: string[]) {
    const current = bag[plugin];
    if (!current || !keys.some(key => key in current)) return;
    const next = { ...current };
    for (const key of keys) delete next[key];
    bag = { ...bag, [plugin]: next };
    persist();
    for (const key of keys) {
        for (const listener of [...listeners]) {
            try {
                listener(plugin, key);
            } catch (error) {
                logger.error("Settings listener failed:", error);
            }
        }
    }
}

export function onSettingsChange(listener: Listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

/** Another tab (or a restored backup) changed the stored bag: announce only what actually changed. */
export function reloadFromStorage(raw: string | null) {
    const parsed = safeJson(raw ?? "");
    const next = isRecord(parsed) ? (parsed as Bag) : {};
    const changed = diffBags(bag, next);
    bag = next;
    for (const [plugin, key] of changed) {
        for (const listener of [...listeners]) {
            try {
                listener(plugin, key);
            } catch (error) {
                logger.error("Settings listener failed:", error);
            }
        }
    }
}

/** Every [plugin, key] whose stored value differs between two bags; "enabled" first, so a plugin starts before it is tuned. */
export function diffBags(before: Bag, after: Bag): [string, string][] {
    const out: [string, string][] = [];
    for (const plugin of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const a = isRecord(before[plugin]) ? before[plugin] : {};
        const b = isRecord(after[plugin]) ? after[plugin] : {};
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => a[key] !== b[key]);
        keys.sort((x, y) => Number(y === "enabled") - Number(x === "enabled"));
        for (const key of keys) out.push([plugin, key]);
    }
    return out;
}

export interface PluginSettings<D extends OptionsDef> {
    def: D;
    store: OptionValues<D>;
    bind(plugin: string): void;
}

export function definePluginSettings<D extends OptionsDef>(def: D): PluginSettings<D> {
    let owner = "";
    const store = new Proxy({} as OptionValues<D>, {
        get: (_, key: string) => {
            const option = def[key];
            if (!option) return undefined;
            const value = getValue(owner, key);
            if (option.type === "boolean") return typeof value === "boolean" ? value : option.default;
            if (option.type === "color") return isHexColor(value) ? value.toLowerCase() : option.default;
            if (option.type === "action") return undefined;
            if (option.type === "number") {
                return typeof value === "number" && Number.isFinite(value)
                    ? Math.min(option.max, Math.max(option.min, Math.round(value)))
                    : option.default;
            }
            return typeof value === "string" && option.options.some(o => o.value === value) ? value : option.default;
        },
        set: (_, key: string, value: OptionValue) => {
            setValue(owner, key, value);
            return true;
        },
    });
    return { def, store, bind: (plugin: string) => void (owner = plugin) };
}
