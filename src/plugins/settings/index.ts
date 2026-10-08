/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { on } from "@api/Events";
import { createOverlay, type Overlay } from "@api/Overlay";
import { allPlugins, definePlugin, isEnabled, type Plugin, type PluginTag, setEnabled } from "@api/PluginManager";
import { getValue, type OptionDef, resetValues, setValue } from "@api/Settings";
import { Icons } from "@utils/icons";
import { button, h, icon, iconButton, optionRow, row, section, selectControl, switchControl } from "@utils/kit";
import { t, type Text, tr } from "@utils/page";

import { CSS } from "./styles";

declare const GM_registerMenuCommand: ((name: string, fn: () => void) => unknown) | undefined;
declare const VERSION: string;

export const SETTINGS_HOST_ID = "notionai-pp-settings";

const SELF = "settings";
const REPO_URL = "https://github.com/0-V-linuxdo/NotionPP";

/** Both translations, so search finds a plugin in either language. */
const both = (text: Text) => (typeof text === "string" ? text : `${text.zh} ${text.en}`);

/* ---------- starred / pinned lists ---------- */

function readList(key: "starred" | "pinned"): string[] {
    const raw = getValue(SELF, key);
    return typeof raw === "string" && raw ? raw.split(",") : [];
}

function toggleInList(key: "starred" | "pinned", name: string) {
    const list = readList(key);
    const next = list.includes(name) ? list.filter(n => n !== name) : [...list, name];
    setValue(SELF, key, next.join(","));
}

/* ---------- dialog state ---------- */

type Category = "favorites" | "all" | PluginTag;
type Filter = "all" | "enabled" | "disabled";

const CATEGORY_LABELS: Record<Category, () => string> = {
    favorites: () => t("收藏", "Favorites"),
    all: () => t("全部", "All"),
    composer: () => t("输入框", "Composer"),
    chat: () => t("对话", "Chat"),
    home: () => t("首页", "Home"),
    appearance: () => t("外观", "Appearance"),
};

let overlay: Overlay | null = null;
const layers: { el: HTMLElement; close(): void }[] = [];
const cleanups: (() => void)[] = [];

const settingKeys = (plugin: Plugin) => Object.entries(plugin.settings?.def ?? {}) as [string, OptionDef][];
const hasSettings = (plugin: Plugin) => settingKeys(plugin).length > 0;

function pushLayer(kind: "nested" | "confirm", content: HTMLElement, onClose?: () => void) {
    const el = h("div", { class: `layer layer-${kind}` }, content);
    const entry = {
        el,
        close() {
            const index = layers.indexOf(entry);
            if (index >= 0) layers.splice(index, 1);
            el.remove();
            onClose?.();
        },
    };
    el.addEventListener("mousedown", event => event.target === el && entry.close());
    overlay!.root.append(el);
    layers.push(entry);
    return entry;
}

function sheet(title: string, subtitle: string | undefined, onClose: () => void, size: "sm" | "md" = "md") {
    const node = h("div", { class: size === "sm" ? "sheet sheet-sm" : "sheet", role: "dialog", "aria-modal": "true" },
        h("div", { class: "sheet-head" },
            h("h3", { class: "sheet-title" }, title),
            subtitle && h("p", { class: "sheet-desc" }, subtitle)),
    );
    const close = iconButton(Icons.x, t("关闭", "Close"), onClose);
    close.classList.add("close");
    node.prepend(close);
    return node;
}

function confirmDialog(title: string, description: string, confirmText: string, onConfirm: () => void) {
    let layer: ReturnType<typeof pushLayer>;
    const node = sheet(title, description, () => layer.close(), "sm");
    const cancel = button("secondary", t("取消", "Cancel"), () => layer.close());
    node.append(h("div", { class: "footer" }, cancel, button("danger", confirmText, () => {
        layer.close();
        onConfirm();
    })));
    layer = pushLayer("confirm", node);
    node.tabIndex = -1;
    node.focus();
}

/* ---------- setting fields ---------- */

function settingField(plugin: Plugin, key: string, def: OptionDef): HTMLElement {
    const store = plugin.settings!.store as Record<string, unknown>;
    return optionRow(def, store[key], value => setValue(plugin.name, key, value));
}

function openPluginDialog(plugin: Plugin) {
    let layer: ReturnType<typeof pushLayer>;
    const node = sheet(tr(plugin.title), tr(plugin.description), () => layer.close());
    const entries = settingKeys(plugin);
    const list = h("div", { class: "settings-list" });
    const render = () => {
        list.replaceChildren(...entries.map(([key, def]) => settingField(plugin, key, def)));
        list.toggleAttribute("data-off", !isEnabled(plugin));
    };
    render();
    const body = h("div", { class: "sheet-body" },
        section(t("设置", "Settings"), entries.length ? list : h("p", { class: "field-text" }, t("没有可配置的选项。", "No configurable settings."))));
    const storable = entries.filter(([, def]) => def.type !== "action").map(([key]) => key);
    if (storable.length) {
        body.append(section(t("重置", "Reset"), row(
            t("恢复默认设置", "Reset to defaults"),
            t("把这个插件的设置恢复为默认值", "Restore this plugin's settings to their defaults"),
            button("secondary", t("恢复默认", "Reset"), () => confirmDialog(
                t("恢复默认设置", "Reset settings"),
                t("把这个插件的设置恢复为默认值？此操作无法撤销。", "Reset this plugin's settings to defaults? This cannot be undone."),
                t("恢复默认", "Reset"),
                () => {
                    resetValues(plugin.name, storable);
                    render();
                },
            )))));
    }
    node.append(body);
    layer = pushLayer("nested", node);
    node.tabIndex = -1;
    node.focus();
}

/* ---------- plugins tab ---------- */

function pluginCard(plugin: Plugin, refresh: () => void) {
    const enabled = isEnabled(plugin);
    const starred = readList("starred").includes(plugin.name);
    const pinned = readList("pinned").includes(plugin.name);
    const crashed = enabled && !plugin.started && !plugin.required;
    const cls = ["card", plugin.required && "required", crashed && "crashed"].filter(Boolean).join(" ");
    const actions = h("div", { class: "card-controls" },
        iconButton(Icons.star, starred ? t("取消收藏", "Remove from favorites") : t("收藏", "Add to favorites"), () => {
            toggleInList("starred", plugin.name);
            refresh();
        }, { active: starred, filled: starred }),
        !plugin.required && iconButton(Icons.pin, pinned ? t("取消置顶", "Unpin from top") : t("置顶", "Pin to top"), () => {
            toggleInList("pinned", plugin.name);
            refresh();
        }, { active: pinned, filled: pinned }),
        hasSettings(plugin) && iconButton(Icons.sliders, t("配置", "Configure"), () => openPluginDialog(plugin)),
    );
    const toggle = switchControl(enabled, tr(plugin.title), value => {
        setEnabled(plugin, value);
        refresh();
    }, plugin.required);
    // The switch is the only control beside the title, so the title and description show in full.
    return h("div", { class: cls, "data-plugin": plugin.name },
        h("div", { class: "card-body" },
            h("div", { class: "card-head" },
                h("div", { class: "card-name" },
                    h("span", { class: "card-icon" }, icon(plugin.icon ?? Icons.plug)),
                    h("span", { class: "card-title" }, tr(plugin.title)),
                    crashed && h("span", { class: "badge danger", title: t("此插件启动失败", "This plugin failed to start") }, icon(Icons.alert)),
                    plugin.required && h("span", { class: "badge", title: t("NotionAI++ 运行必需", "Required for NotionAI++ to work") }, icon(Icons.lock))),
                toggle),
            h("div", { class: "card-desc" }, tr(plugin.description))),
        h("div", { class: "card-footer" }, h("span", { class: "card-id" }, plugin.name), actions));
}

function pluginsTab() {
    const all = allPlugins().slice().sort((a, b) => tr(a.title).localeCompare(tr(b.title)));
    const user = all.filter(p => !p.required);
    const required = all.filter(p => p.required);
    const state = { category: (readList("starred").length ? "favorites" : "all") as Category, search: "", filter: "all" as Filter };

    const categories = (Object.keys(CATEGORY_LABELS) as Category[])
        .filter(c => c === "favorites" || c === "all" || all.some(p => p.tags?.includes(c as PluginTag)));
    const tabs = h("div", { class: "tabs", role: "tablist" });
    const search = h("input", { type: "search", class: "input", "aria-label": t("搜索插件", "Search plugins") });
    const filter = selectControl(t("筛选", "Filter"), [
        { value: "all", label: t("全部", "All") },
        { value: "enabled", label: t("已启用", "Enabled") },
        { value: "disabled", label: t("已禁用", "Disabled") },
    ], state.filter, value => {
        state.filter = value as Filter;
        render();
    }, "field");
    const list = h("div", { class: "list" });

    const matches = (p: Plugin) => {
        if (state.filter !== "all" && isEnabled(p) !== (state.filter === "enabled")) return false;
        const q = state.search.trim().toLowerCase();
        return !q || [p.title, p.name, p.description].map(both).join(" ").toLowerCase().includes(q);
    };

    const render = () => {
        tabs.replaceChildren(...categories.map(c => h("button", {
            type: "button", role: "tab", class: c === state.category ? "tab active" : "tab", "aria-selected": String(c === state.category),
            onclick: () => { state.category = c; render(); },
        }, CATEGORY_LABELS[c]())));
        const starred = readList("starred");
        const pinned = readList("pinned");
        let top: Plugin[];
        let bottom: Plugin[] = [];
        if (state.category === "favorites") top = all.filter(p => starred.includes(p.name));
        else if (state.category === "all") { top = user; bottom = required; }
        else top = all.filter(p => p.tags?.includes(state.category as PluginTag));
        top = top.filter(matches);
        bottom = bottom.filter(matches);
        if (state.category !== "favorites") {
            const rank = (p: Plugin) => (pinned.includes(p.name) ? pinned.indexOf(p.name) : Infinity);
            top = top.slice().sort((a, b) => rank(a) - rank(b));
        }
        search.placeholder = t(`搜索 ${user.length + required.length} 个插件…`, `Search ${user.length + required.length} plugins...`);
        const grid = (items: Plugin[]) => h("div", { class: "grid" }, ...items.map(p => pluginCard(p, render)));
        const children: HTMLElement[] = [];
        if (top.length) children.push(grid(top));
        if (bottom.length) children.push(h("div", { class: "separator" }), grid(bottom));
        if (!children.length) {
            children.push(h("p", { class: "empty" }, state.search
                ? t("没有匹配的插件。", "No plugins match your search.")
                : state.category === "favorites"
                    ? t("还没有收藏。点星标即可收藏插件。", "No favorites yet. Star a plugin to see it here.")
                    : t("没有插件。", "No plugins available.")));
        }
        list.replaceChildren(...children);
    };

    search.addEventListener("input", () => { state.search = search.value; render(); });
    render();
    return h("div", { class: "tab-root" }, tabs, h("div", { class: "search-bar" }, search, filter), list);
}

export const LANGUAGE_KEY = "language";

function preferencesTab() {
    const current = String(getValue(SELF, LANGUAGE_KEY) ?? "auto");
    const language = selectControl(t("界面语言", "Language"), [
        { value: "auto", label: t("跟随 Notion", "Same as Notion") },
        { value: "zh", label: "中文" },
        { value: "en", label: "English" },
    ], current, value => {
        setValue(SELF, LANGUAGE_KEY, value);
        openSettings("preferences");
    });
    return h("div", { class: "tab-root prefs" },
        section(t("语言", "Language"),
            row(t("界面语言", "Language"), t("NotionAI++ 的设置、提示和面板使用的语言", "The language of NotionAI++'s settings, tooltips and panels"), language)));
}

function aboutTab() {
    const version = typeof VERSION === "string" ? VERSION : "";
    return h("div", { class: "tab-root about" },
        h("p", {}, t(
            "NotionAI++ 是 Notion AI 的增强用户脚本：用量贴在 AI 输入框上，对话目录，以及更多小插件。",
            "NotionAI++ is a userscript for Notion AI: a usage meter docked to the AI composer, a chat outline and more.")),
        h("p", {}, t(
            "只发同源请求，不读取 Cookie、token 或 Authorization；设置只保存在本机浏览器。",
            "Only same-origin requests; never reads cookies, tokens or Authorization. Settings stay in this browser.")),
        h("p", {}, `${t("版本", "Version")} ${version} · `, h("a", { href: REPO_URL, target: "_blank", rel: "noreferrer" }, "GitHub")));
}

/* ---------- shell ---------- */

const TABS = [
    { id: "plugins", icon: Icons.plug, title: () => t("插件", "Plugins"), hint: () => t("开关各项功能；点滑杆图标进行配置。", "Toggle features. Click the sliders icon to configure."), render: pluginsTab },
    { id: "preferences", icon: Icons.sliders, title: () => t("偏好设置", "Preferences"), hint: () => "", render: preferencesTab },
    { id: "about", icon: Icons.info, title: () => t("关于", "About"), hint: () => "", render: aboutTab },
];

function close() {
    for (const layer of layers.splice(0)) layer.el.remove();
    overlay?.destroy();
    overlay = null;
}

export function openSettings(tab = "plugins") {
    close();
    overlay = createOverlay(SETTINGS_HOST_ID, CSS, "");
    const { root } = overlay;
    const content = h("div", { class: "content" });
    const navItems = new Map<string, HTMLButtonElement>();
    const select = (id: string) => {
        const def = TABS.find(t => t.id === id) ?? TABS[0];
        for (const [key, item] of navItems) {
            if (key === def.id) item.setAttribute("aria-current", "page");
            else item.removeAttribute("aria-current");
        }
        const hint = def.hint();
        const closeBtn = iconButton(Icons.x, t("关闭", "Close"), close);
        closeBtn.classList.add("close");
        content.replaceChildren(
            closeBtn,
            h("div", { class: "content-head" }, h("h2", {}, def.title()), hint && h("span", { class: "hint", title: hint }, icon(Icons.info))),
            def.render(),
        );
    };
    const version = typeof VERSION === "string" ? VERSION : "";
    const nav = h("nav", { class: "nav" },
        h("div", { class: "nav-group" }, "NotionAI++"),
        ...TABS.map(def => {
            const item = h("button", { type: "button", class: "nav-item", onclick: () => select(def.id) }, icon(def.icon), def.title());
            navItems.set(def.id, item);
            return item;
        }),
        h("div", { class: "version" },
            h("a", { href: REPO_URL, target: "_blank", rel: "noreferrer" }, "NotionAI++"), version && ` · ${version}`,
            h("br"), t("用户脚本", "Userscript")),
    );
    const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": t("NotionAI++ 设置", "NotionAI++ settings") }, nav, content);
    const backdrop = h("div", { class: "layer layer-root" }, dialog);
    backdrop.addEventListener("mousedown", event => event.target === backdrop && close());
    root.append(backdrop);
    root.addEventListener("keydown", event => {
        if ((event as KeyboardEvent).key !== "Escape") return;
        event.stopPropagation();
        const top = layers.at(-1);
        if (top) top.close();
        else close();
    });
    select(tab);
    dialog.tabIndex = -1;
    dialog.focus();
}

export default definePlugin({
    name: SELF,
    title: { zh: "设置面板", en: "Settings" },
    description: { zh: "NotionAI++ 设置面板与脚本管理器菜单命令。", en: "The NotionAI++ settings panel and its userscript manager menu command." },
    icon: Icons.cog,
    enabledByDefault: true,
    required: true,
    start() {
        cleanups.push(on("openSettings", () => openSettings()));
        if (typeof GM_registerMenuCommand === "function") {
            try {
                GM_registerMenuCommand(t("⚙️ NotionAI++ 设置", "⚙️ NotionAI++ settings"), () => openSettings());
            } catch {}
        }
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        close();
    },
});
