/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { t } from "@utils/page";

import { MAX_COUNT, MAX_LEN } from "./store";

// Follows NotionAI++'s language setting, like every other panel.
const STRINGS = {
    title: ["管理问候语", "Manage greetings"],
    subtitle: ["首页问候语会在这些文案之间轮播。在首页双击右键问候语也能打开这里。", "The home greeting rotates through these lines. Double right-click the greeting on home to open this too."],
    close: ["关闭", "Close"],
    newSection: ["添加问候语", "Add a greeting"],
    editSection: ["修改问候语", "Edit greeting"],
    placeholder: [`输入问候语，可换行，最多 ${MAX_LEN} 字`, `Type a greeting. Line breaks are fine, up to ${MAX_LEN} characters`],
    add: ["添加", "Add"],
    cancelEdit: ["取消", "Cancel"],
    saveEdit: ["保存", "Save"],
    listSection: ["问候语（{count}/{max}）", "Greetings ({count}/{max})"],
    current: ["当前", "Current"],
    edit: ["修改", "Edit"],
    delete: ["删除", "Delete"],
    empty: ["问候语不能为空。", "A greeting can't be empty."],
    tooLong: [`单条问候语不能超过 ${MAX_LEN} 字。`, `A greeting can't be longer than ${MAX_LEN} characters.`],
    tooMany: [`最多只能保存 ${MAX_COUNT} 条问候语。`, `You can save up to ${MAX_COUNT} greetings.`],
    rotation: ["轮播", "Rotation"],
    done: ["完成", "Done"],
    clickHint: ["点击切换问候语", "Click to switch the greeting"],
} as const;

export type StringKey = keyof typeof STRINGS;

export function tr(key: StringKey, vars: Record<string, string | number> = {}) {
    const [zh, en] = STRINGS[key];
    return t(zh, en).replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
