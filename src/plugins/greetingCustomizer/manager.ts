/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { createOverlay, type Overlay } from "@api/Overlay";
import type { OptionDef, OptionValue } from "@api/Settings";
import { CSS as SETTINGS_CSS } from "@plugins/settings/styles";
import { Icons } from "@utils/icons";
import { button, h, iconButton, optionRow, section } from "@utils/kit";

import { tr } from "./lang";
import { loadGreetings, MAX_COUNT, MAX_LEN, normalizeGreeting, saveGreetings, validateGreeting } from "./store";

export const MANAGER_HOST_ID = "notionai-pp-greetings";

type RotationKey = "mode" | "order" | "intervalSec";

export interface RotationControls {
    /** The plugin's own option definitions, so these rows read exactly like its settings dialog. */
    defs: Record<RotationKey, OptionDef>;
    get(key: RotationKey): OptionValue;
    set(key: RotationKey, value: OptionValue): void;
}

/** Laid out like the plugin settings dialog, with the same Notion-style controls. */
const CSS = `${SETTINGS_CSS}
.layer-root { background: var(--overlay); }
.textarea { width: 100%; min-height: 84px; resize: vertical; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-l2);
  background: var(--surface-field); color: var(--fg-primary); font: inherit; font-size: 14px; line-height: 20px; }
.textarea::placeholder { color: var(--fg-tertiary); }
.textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.editor { display: flex; flex-direction: column; gap: 8px; }
.editor-actions { display: flex; align-items: center; gap: 8px; }
.counter { margin-right: auto; font-size: 12px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; }
.error { font-size: 13px; line-height: 18px; color: var(--fg-danger); }
.greetings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.greetings li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 4px 8px 0; border-bottom: 1px solid var(--border-l1); }
.greetings li:last-child { border-bottom: 0; }
.greetings li[data-editing] { background: var(--surface-hover); border-radius: 6px; padding-left: 8px; }
.greeting-text { flex: 1; min-width: 0; padding-top: 4px; font-size: 14px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tag { flex-shrink: 0; margin-top: 4px; padding: 0 6px; border-radius: 4px; font-size: 12px; line-height: 20px;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.greetings .icon-btn { flex-shrink: 0; }
`;

let overlay: Overlay | null = null;

export function closeManager() {
    overlay?.destroy();
    overlay = null;
}

export const isManagerOpen = () => !!overlay;

export function openManager(rotation: RotationControls, currentIndex: () => number) {
    closeManager();
    overlay = createOverlay(MANAGER_HOST_ID, CSS, "");
    const { root } = overlay;
    root.addEventListener("keydown", event => (event as KeyboardEvent).key === "Escape" && closeManager());

    let greetings = loadGreetings();
    let editing = -1;

    const textarea = h("textarea", { class: "textarea", placeholder: tr("placeholder"), maxLength: MAX_LEN, "aria-label": tr("newSection") });
    const error = h("div", { class: "error", role: "alert" });
    const counter = h("span", { class: "counter" });
    const submit = button("primary", tr("add"), () => submitGreeting());
    const cancel = button("secondary", tr("cancelEdit"), () => {
        stopEditing();
        setError(null);
        render();
    });
    const editorTitle = h("h4", { class: "section-title" });
    const editor = h("section", { class: "section" }, editorTitle,
        h("div", { class: "editor" }, textarea, error, h("div", { class: "editor-actions" }, counter, cancel, submit)));
    const listTitle = h("h4", { class: "section-title" });
    const list = h("ul", { class: "greetings" });

    const setError = (key: "empty" | "tooLong" | "tooMany" | null) => {
        error.textContent = key ? tr(key) : "";
        error.hidden = !key;
    };
    const syncCounter = () => void (counter.textContent = `${textarea.value.length}/${MAX_LEN}`);
    const stopEditing = () => {
        editing = -1;
        textarea.value = "";
        syncEditor();
    };
    const syncEditor = () => {
        editorTitle.textContent = tr(editing >= 0 ? "editSection" : "newSection");
        submit.textContent = tr(editing >= 0 ? "saveEdit" : "add");
        cancel.hidden = editing < 0;
        syncCounter();
    };

    function persist() {
        saveGreetings(greetings);
        greetings = loadGreetings();
    }

    function render() {
        listTitle.textContent = tr("listSection", { count: greetings.length, max: MAX_COUNT });
        const current = currentIndex();
        list.replaceChildren(...greetings.map((greeting, index) => {
            const item = h("li", {},
                h("div", { class: "greeting-text" }, greeting),
                index === current && h("span", { class: "tag" }, tr("current")),
                iconButton(Icons.pencil, tr("edit"), () => {
                    editing = index;
                    textarea.value = greetings[index];
                    setError(null);
                    syncEditor();
                    render();
                    textarea.focus();
                }),
                iconButton(Icons.trash, tr("delete"), () => {
                    greetings.splice(index, 1);
                    if (editing === index) stopEditing();
                    else if (editing > index) editing--;
                    persist();
                    render();
                }));
            item.toggleAttribute("data-editing", index === editing);
            return item;
        }));
    }

    function submitGreeting() {
        const problem = validateGreeting(textarea.value);
        if (problem) return setError(problem);
        if (editing < 0 && greetings.length >= MAX_COUNT) return setError("tooMany");
        const text = normalizeGreeting(textarea.value);
        if (editing >= 0) greetings[editing] = text;
        else greetings.push(text);
        setError(null);
        stopEditing();
        persist();
        render();
    }

    textarea.addEventListener("input", syncCounter);
    textarea.addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitGreeting();
    });

    // Rotation rows share the plugin's option definitions and storage with its settings dialog.
    const rotationList = h("div", { class: "settings-list" });
    const renderRotation = () => {
        const keys: RotationKey[] = ["mode", "order", "intervalSec"];
        rotationList.replaceChildren(...keys.map(key => optionRow(rotation.defs[key], rotation.get(key), value => {
            rotation.set(key, value);
            if (key === "mode") renderRotation();
        })));
        const interval = rotationList.querySelector<HTMLInputElement>("input[type=number]");
        if (interval) interval.disabled = rotation.get("mode") !== "interval";
    };
    renderRotation();

    const close = iconButton(Icons.x, tr("close"), closeManager);
    close.classList.add("close");
    const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": tr("title") },
        close,
        h("div", { class: "sheet-head" },
            h("h3", { class: "sheet-title" }, tr("title")),
            h("p", { class: "sheet-desc" }, tr("subtitle"))),
        h("div", { class: "sheet-body" },
            editor,
            h("section", { class: "section" }, listTitle, list),
            section(tr("rotation"), rotationList),
            h("div", { class: "footer" }, button("primary", tr("done"), closeManager))));
    const layer = h("div", { class: "layer layer-root" }, sheet);
    layer.addEventListener("mousedown", event => event.target === layer && closeManager());
    root.append(layer);

    stopEditing();
    setError(null);
    render();
    textarea.focus();
}
