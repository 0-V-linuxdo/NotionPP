/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import type { OptionDef, OptionValue } from "@api/Settings";
import { Icons, svgIcon } from "@utils/icons";
import { tr } from "@utils/page";

/*
 * Notion-style controls shared by every NotionAI++ panel. They expect the settings CSS
 * (@plugins/settings/styles) in the same shadow root.
 */

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === "class") node.className = String(value);
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value as EventListener);
        else if (key in node && !key.includes("-")) (node as any)[key] = value;
        else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children) if (child != null && child !== false) node.append(child);
    return node;
}

export const icon = (markup: string, filled = false) => svgIcon(markup, filled);

export function button(variant: "primary" | "secondary" | "tertiary" | "danger", label: Child, onclick: () => void, extra = "") {
    return h("button", { type: "button", class: `btn btn-${variant} ${extra}`.trim(), onclick }, label);
}

export function iconButton(markup: string, label: string, onclick: () => void, { active = false, filled = false } = {}) {
    return h("button", { type: "button", class: active ? "icon-btn active" : "icon-btn", title: label, "aria-label": label, onclick }, icon(markup, filled));
}

export function switchControl(checked: boolean, label: string, onChange: (value: boolean) => void, disabled = false) {
    const el = h("button", { type: "button", role: "switch", class: "switch", "aria-label": label, disabled });
    el.setAttribute("aria-checked", String(checked));
    el.addEventListener("click", () => {
        const next = el.getAttribute("aria-checked") !== "true";
        el.setAttribute("aria-checked", String(next));
        onChange(next);
    });
    return el;
}

/** One Notion-style settings row: title and description on the left, the control on the right. */
export function row(title: string, description: string | undefined, control: HTMLElement) {
    return h("div", { class: "row" },
        h("div", { class: "row-body" },
            h("div", { class: "s-title" }, title),
            description && h("div", { class: "s-desc" }, description)),
        h("div", { class: "row-control" }, control));
}

export function section(title: string, ...children: Child[]) {
    return h("section", { class: "section" }, h("h4", { class: "section-title" }, title), ...children);
}

/**
 * Notion's settings dropdown: a borderless button showing only the chosen value, opening a
 * menu with every option in full. A native <select> is as wide as its longest option, which
 * a settings row cannot fit.
 */
export function selectControl(label: string, options: { value: string; label: string }[], value: string, onChange: (value: string) => void, variant: "plain" | "field" = "plain") {
    let current = value;
    const text = h("span", { class: "dropdown-value" });
    const trigger = h("button", { type: "button", class: variant === "field" ? "dropdown dropdown-field" : "dropdown", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": label },
        text, icon(Icons.chevronDown));
    const sync = () => {
        const chosen = options.find(o => o.value === current) ?? options[0];
        text.textContent = chosen?.label ?? "";
        trigger.title = chosen?.label ?? "";
    };
    sync();
    trigger.addEventListener("click", () => {
        const pick = (next: string) => {
            close();
            trigger.focus();
            if (next === current) return;
            current = next;
            sync();
            onChange(next);
        };
        const items = options.map(o => h("button", {
            type: "button", role: "option", class: "menu-item", "aria-selected": String(o.value === current), "data-value": o.value,
            onclick: () => pick(o.value),
        }, h("span", { class: "menu-label" }, o.label), o.value === current && icon(Icons.check)));
        const menu = h("div", { class: "menu", role: "listbox", "aria-label": label }, ...items);
        const layer = h("div", { class: "layer layer-menu" }, menu);
        const close = () => {
            layer.remove();
            trigger.setAttribute("aria-expanded", "false");
        };
        layer.addEventListener("mousedown", event => event.target === layer && close());
        menu.addEventListener("keydown", event => {
            const { key } = event as KeyboardEvent;
            if (key === "Escape" || key === "Tab") {
                // Escape closes only the menu, not the dialog under it.
                event.preventDefault();
                event.stopPropagation();
                close();
                trigger.focus();
                return;
            }
            if (key !== "ArrowDown" && key !== "ArrowUp") return;
            event.preventDefault();
            const index = items.indexOf(menu.querySelector<HTMLButtonElement>(".menu-item:focus") ?? items[0]);
            items[(index + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
        });
        (trigger.getRootNode() as ShadowRoot | Document).append?.(layer);
        if (!layer.isConnected) document.body.append(layer);
        trigger.setAttribute("aria-expanded", "true");
        placeMenu(menu, trigger.getBoundingClientRect());
        (items.find(item => item.getAttribute("aria-selected") === "true") ?? items[0])?.focus();
    });
    return trigger;
}

const MENU_GAP = 4;

/** Right-aligns the menu under its button, or above it when there is no room below. */
function placeMenu(menu: HTMLElement, anchor: DOMRect) {
    const width = Math.max(anchor.width, menu.offsetWidth);
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
    const below = anchor.bottom + MENU_GAP;
    const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, anchor.top - MENU_GAP - menu.offsetHeight) : below;
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px`, minWidth: `${anchor.width}px` });
}


/** A settings row for one option definition, with the control its type calls for. */
export function optionRow(def: OptionDef, value: unknown, set: (value: OptionValue) => void): HTMLElement {
    const title = tr(def.label);
    const description = def.description && tr(def.description);
    switch (def.type) {
        case "boolean":
            return row(title, description, switchControl(Boolean(value), title, set));
        case "select":
            return row(title, description, selectControl(title, def.options.map(o => ({ value: o.value, label: tr(o.label) })), String(value), set));
        case "color": {
            const text = h("span", { class: "color-value" }, String(value));
            const input = h("input", { type: "color", value: String(value), "aria-label": title });
            input.addEventListener("input", () => {
                text.textContent = input.value.toLowerCase();
                set(input.value.toLowerCase());
            });
            return row(title, description, h("div", { class: "color" }, text, input));
        }
        case "number": {
            const input = h("input", { type: "number", class: "input number", min: String(def.min), max: String(def.max), step: "1", value: String(value), "aria-label": title });
            input.addEventListener("change", () => {
                const next = Math.min(def.max, Math.max(def.min, Math.round(Number(input.value) || def.default)));
                input.value = String(next);
                set(next);
            });
            return row(title, description, input);
        }
        case "action":
            return row(title, description, button("secondary", tr(def.button), () => def.run()));
    }
}
