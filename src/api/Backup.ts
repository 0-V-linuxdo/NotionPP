/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { reloadFromStorage, SETTINGS_KEY } from "@api/Settings";
import { isRecord, safeJson } from "@utils/guards";
import { pageWindow } from "@utils/page";

/*
 * Everything NotionAI++ keeps lives in this origin's localStorage under one prefix: settings,
 * stars, prompt history, usage stats, the reply sound. A backup is those entries as one JSON
 * file; restoring writes them back, so a new browser or a reinstall picks up where it left off.
 */

const PREFIX = "notionai-pp:";
/** Caches that are rebuilt on their own and would only carry stale state across. */
const SKIP = new Set(["notionai-pp:health:v1"]);
const FORMAT = "notionai-pp-backup";

export interface Backup {
    format: typeof FORMAT;
    version: string;
    exportedAt: string;
    data: Record<string, string>;
}

const storage = () => pageWindow.localStorage;

export function collectBackup(version = ""): Backup {
    const data: Record<string, string> = {};
    const store = storage();
    for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key?.startsWith(PREFIX) || SKIP.has(key)) continue;
        const value = store.getItem(key);
        if (value !== null) data[key] = value;
    }
    return { format: FORMAT, version, exportedAt: new Date().toISOString(), data };
}

/** The entries a backup file would restore, or null when it is not a NotionAI++ backup. */
export function parseBackup(text: string): Record<string, string> | null {
    const parsed = safeJson(text);
    if (!isRecord(parsed) || parsed.format !== FORMAT || !isRecord(parsed.data)) return null;
    const entries = Object.entries(parsed.data)
        .filter((entry): entry is [string, string] => entry[0].startsWith(PREFIX) && !SKIP.has(entry[0]) && typeof entry[1] === "string");
    return Object.fromEntries(entries);
}

/** Writes the entries back; keys the backup lacks are left as they are. Returns how many were written. */
export function restoreBackup(data: Record<string, string>): number {
    const store = storage();
    let written = 0;
    for (const [key, value] of Object.entries(data)) {
        try {
            store.setItem(key, value);
            written++;
        } catch {}
    }
    if (SETTINGS_KEY in data) reloadFromStorage(data[SETTINGS_KEY]);
    return written;
}

export function backupFileName(date = new Date()) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `NotionAI++-backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.json`;
}
