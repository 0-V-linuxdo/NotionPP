/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { onDomChange } from "@api/DomWatch";
import { on } from "@api/Events";
import { definePlugin } from "@api/PluginManager";
import { currentChatId } from "@api/Reply";
import { Icons, svgIcon } from "@utils/icons";
import { pageWindow, t } from "@utils/page";
import { debounce } from "@utils/time";

import { copyRole, USER_STEP } from "../navigator/messages";
import { setStarsActive, STARS_KEY, starsOf, toggleStar } from "./store";

/*
 * Like Void++'s messageStars: a star joins the hover toolbar under every prompt and reply.
 * Starred messages turn orange in the chat navigator's rail and list.
 */

const MARK = "data-npp-star";
const STAR_COLOR = "#d9730d";
const RESCAN_MS = 200;

let cleanups: (() => void)[] = [];

function topSteps(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`[${USER_STEP}]`)].filter(step => !step.parentElement?.closest(`[${USER_STEP}]`));
}

/** The navigator's id for the message a copy button belongs to. */
export function messageIdFor(button: Element, steps: HTMLElement[]): string | null {
    const role = copyRole(button);
    if (role === "user") return button.closest(`[${USER_STEP}]`)?.getAttribute(USER_STEP) ?? null;
    if (role !== "assistant") return null;
    let owner: HTMLElement | null = null;
    for (const step of steps) {
        if (step.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) owner = step;
        else break;
    }
    const id = owner?.getAttribute(USER_STEP);
    return id ? `${id}:assistant` : null;
}

function paint(button: HTMLElement, starred: boolean) {
    button.setAttribute("aria-pressed", String(starred));
    const label = starred ? t("取消星标", "Unstar") : t("加星标", "Star");
    button.setAttribute("aria-label", label);
    button.title = label;
    button.style.color = starred ? STAR_COLOR : "";
    button.querySelector("svg")?.setAttribute("fill", starred ? "currentColor" : "none");
}

const mirrors = new WeakMap<HTMLElement, MutationObserver>();

/**
 * Notion hides the prompt toolbar's copy button (an inline opacity: 0) until the prompt is
 * hovered; the star follows the copy button's classes and opacity so it shows and hides with it.
 */
function mirror(copy: HTMLElement, button: HTMLElement) {
    const sync = () => {
        if (button.className !== copy.className) button.className = copy.className;
        if (button.style.opacity !== copy.style.opacity) button.style.opacity = copy.style.opacity;
    };
    sync();
    const observer = new MutationObserver(() => {
        if (!button.isConnected) return observer.disconnect();
        sync();
    });
    observer.observe(copy, { attributes: true, attributeFilter: ["class", "style"] });
    mirrors.get(button)?.disconnect();
    mirrors.set(button, observer);
}

function makeButton(copy: HTMLElement, id: string): HTMLElement {
    const wrapper = (copy.parentElement?.cloneNode(false) ?? document.createElement("div")) as HTMLElement;
    wrapper.removeAttribute("data-popup-origin");
    wrapper.setAttribute(MARK, id);
    const button = copy.cloneNode(false) as HTMLElement;
    button.removeAttribute("id");
    const svg = svgIcon(Icons.star);
    const size = copy.querySelector("svg")?.getBoundingClientRect();
    const px = size && size.width ? Math.round(size.width) : 16;
    svg.style.cssText = `width:${px}px;height:${px}px;display:block;flex-shrink:0`;
    button.append(svg);
    button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        paint(button, toggleStar(currentChatId(), id));
    });
    button.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        button.click();
    });
    wrapper.append(button);
    mirror(copy, button);
    return wrapper;
}

/**
 * Right after Notion's own icon buttons (copy, save, feedback), before anything that stretches
 * to fill the row, such as the "Undo" group, which would otherwise push the star to the far end.
 */
export function place(row: HTMLElement, copyWrapper: HTMLElement, star: HTMLElement) {
    let after: Element = copyWrapper;
    for (let next = after.nextElementSibling; next && next !== star; next = next.nextElementSibling) {
        if (!isIconWrapper(next)) break;
        after = next;
    }
    if (after.nextElementSibling !== star) row.insertBefore(star, after.nextElementSibling);
    // The prompt toolbar is sized for the copy button alone (an inline 24px width); let it grow.
    if (row.style.width.endsWith("px")) row.style.width = "auto";
}

const isIconWrapper = (node: Element) =>
    !(node instanceof HTMLElement && /flex:\s*1/.test(node.getAttribute("style") ?? ""))
    && !!node.querySelector("[role='button'][aria-label], button[aria-label]")
    && !node.textContent?.trim();

export function scan() {
    const chatId = currentChatId();
    const stars = starsOf(chatId);
    const steps = topSteps();
    for (const copy of document.querySelectorAll<HTMLElement>("[role='button'][aria-label], button[aria-label]")) {
        if (copy.closest(`[${MARK}]`)) continue;
        const row = copy.parentElement?.parentElement;
        if (!row || !copyRole(copy)) continue;
        const id = chatId ? messageIdFor(copy, steps) : null;
        let ours = ([...row.children] as HTMLElement[]).find(child => child.hasAttribute(MARK)) ?? null;
        if (ours && (!id || ours.getAttribute(MARK) !== id)) {
            ours.remove();
            ours = null;
        }
        if (!id) continue;
        if (ours) {
            const button = ours.firstElementChild as HTMLElement;
            if (button.className !== copy.className || button.style.opacity !== copy.style.opacity) mirror(copy, button);
        }
        ours ??= makeButton(copy, id);
        place(row, copy.parentElement!, ours);
        paint(ours.firstElementChild as HTMLElement, stars.has(id));
    }
}

function removeAll() {
    for (const node of document.querySelectorAll(`[${MARK}]`)) node.remove();
}

export default definePlugin({
    name: "messageStars",
    title: { zh: "消息星标", en: "Message stars" },
    description: {
        zh: "在每条提问和回复的悬停工具栏里加一个星标按钮。加星的消息在右侧对话目录里显示为橙色，方便回头找。",
        en: "Adds a star to the hover toolbar of every prompt and reply. Starred messages show in orange in the chat navigator.",
    },
    icon: Icons.star,
    tags: ["chat"],
    enabledByDefault: true,
    start() {
        setStarsActive(true);
        const rescan = debounce(scan, RESCAN_MS, RESCAN_MS * 4);
        const onStorage = (event: StorageEvent) => event.key === STARS_KEY && scan();
        pageWindow.addEventListener("storage", onStorage);
        cleanups = [
            onDomChange(mutations => {
                // Our own buttons going in would otherwise wake the scan again.
                if (mutations.every(m => [...m.addedNodes, ...m.removedNodes].every(node => node instanceof Element && node.hasAttribute(MARK)))) return;
                rescan();
            }),
            on("starsChanged", scan),
            () => rescan.cancel(),
            () => pageWindow.removeEventListener("storage", onStorage),
        ];
        scan();
    },
    stop() {
        for (const cleanup of cleanups.splice(0)) cleanup();
        removeAll();
        setStarsActive(false);
    },
});
