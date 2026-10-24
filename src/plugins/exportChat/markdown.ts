/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

/*
 * Turns a rendered reply back into Markdown. Notion draws a reply with its own blocks
 * (`notion-header-block`, `notion-bulleted_list-block`, …) and sometimes with plain HTML
 * (h2, ul, pre); both are read. Anything not recognised keeps its text, so nothing is lost.
 */

const SKIP = "button, [role='button'], svg, style, script, noscript, template, [aria-hidden='true'], [data-npp-star], [data-npp-star-list], [data-npp-fold-bar], [data-npp-quote-mirror]";

const BLOCK_RE = /\bnotion-([a-z_]+)-block\b/;

function blockType(el: Element): string {
    return el.className && typeof el.className === "string" ? el.className.match(BLOCK_RE)?.[1] ?? "" : "";
}

const isBold = (el: HTMLElement) => /^(?:b|strong)$/i.test(el.tagName) || /font-weight:\s*(?:[6-9]00|bold)/.test(el.getAttribute("style") ?? "");
const isItalic = (el: HTMLElement) => /^(?:i|em)$/i.test(el.tagName) || /font-style:\s*italic/.test(el.getAttribute("style") ?? "");
const isStrike = (el: HTMLElement) => /^(?:s|del|strike)$/i.test(el.tagName) || /line-through/.test(el.getAttribute("style") ?? "");
const isInlineCode = (el: HTMLElement) => el.tagName === "CODE" || /\binline-code\b/.test(String(el.className)) || /font-family:[^;]*mono/i.test(el.getAttribute("style") ?? "");

const wrap = (text: string, mark: string) => {
    const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return match[2] ? `${match[1]}${mark}${match[2]}${mark}${match[3]}` : text;
};

/** The inline Markdown of a run of text: bold, italic, strike, code and links. */
export function inline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200b/g, "");
    if (!(node instanceof HTMLElement) || node.matches(SKIP)) return "";
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "IMG") {
        const alt = node.getAttribute("alt") ?? "";
        const src = node.getAttribute("src") ?? "";
        return src && !src.startsWith("data:") ? `![${alt}](${src})` : alt ? `[${alt}]` : "";
    }
    if (isInlineCode(node)) {
        const code = node.textContent ?? "";
        return code ? `\`${code.replace(/`/g, "\\`")}\`` : "";
    }
    let text = [...node.childNodes].map(inline).join("");
    if (node.tagName === "A") {
        const href = node.getAttribute("href") ?? "";
        if (href && !href.startsWith("javascript:") && text.trim()) text = `[${text.trim()}](${href})`;
        return text;
    }
    if (isBold(node)) text = wrap(text, "**");
    if (isItalic(node)) text = wrap(text, "*");
    if (isStrike(node)) text = wrap(text, "~~");
    return text;
}

const clean = (text: string) => text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

const indent = (text: string, by: string) => text.split("\n").map(line => (line ? by + line : line)).join("\n");

/** The block's own line(s): the content that is not a nested block. */
function ownText(block: Element): string {
    const leaf = block.querySelector<HTMLElement>("[data-content-editable-leaf]");
    if (leaf && leaf.closest("[class*='-block']") === block) return inline(leaf);
    const parts: string[] = [];
    for (const child of block.childNodes) {
        if (child instanceof Element && (blockType(child) || isBlockTag(child))) continue;
        if (child instanceof Element && child.querySelector("[class*='notion-'][class*='-block']")) {
            parts.push(ownText(child));
            continue;
        }
        parts.push(inline(child));
    }
    return parts.join("");
}

function childBlocks(block: Element): Element[] {
    const out: Element[] = [];
    const visit = (node: Element) => {
        for (const child of node.children) {
            if (blockType(child) || isBlockTag(child)) out.push(child);
            else if (!child.matches(SKIP)) visit(child);
        }
    };
    visit(block);
    return out;
}

const BLOCK_TAGS = /^(?:H[1-6]|P|UL|OL|LI|PRE|BLOCKQUOTE|TABLE|HR|DETAILS)$/;
const isBlockTag = (el: Element) => BLOCK_TAGS.test(el.tagName);

function codeBlock(el: Element): string {
    const code = el.querySelector("code, [data-content-editable-leaf]") ?? el;
    const language = (el.querySelector("[class*='language-']")?.className.match(/language-([\w+-]+)/)?.[1]
        ?? el.getAttribute("data-language") ?? "").toLowerCase();
    const text = ((code as HTMLElement).innerText ?? code.textContent ?? "").replace(/\n$/, "");
    const fence = text.includes("```") ? "````" : "```";
    return `${fence}${language}\n${text}\n${fence}`;
}

function tableRows(el: Element): string[][] {
    const rows = [...el.querySelectorAll("tr")];
    if (rows.length) return rows.map(row => [...row.querySelectorAll("th, td")].map(cell => clean(inline(cell)).replace(/\n/g, " ").replace(/\|/g, "\\|")));
    // Notion's simple table: rows of cells drawn with divs.
    return [...el.querySelectorAll("[class*='table_row']")].map(row => [...row.children].map(cell => clean(inline(cell)).replace(/\n/g, " ").replace(/\|/g, "\\|")));
}

function table(el: Element): string {
    const rows = tableRows(el).filter(row => row.length);
    if (!rows.length) return clean(inline(el));
    const width = Math.max(...rows.map(row => row.length));
    const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")];
    const line = (row: string[]) => `| ${pad(row).join(" | ")} |`;
    return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function list(el: Element, ordered: boolean): string {
    return [...el.children].filter(child => child.tagName === "LI").map((item, index) => {
        const marker = ordered ? `${index + 1}. ` : "- ";
        const nested = [...item.children].filter(child => /^(?:UL|OL)$/.test(child.tagName));
        const own = clean([...item.childNodes].filter(child => !(child instanceof Element && nested.includes(child))).map(inline).join(""));
        const sub = nested.map(child => indent(list(child, child.tagName === "OL"), "   ")).join("\n");
        return `${marker}${own}${sub ? `\n${sub}` : ""}`;
    }).join("\n");
}

/** One block and whatever is nested under it, as Markdown. */
function block(el: Element, number = 1): string {
    const type = blockType(el);
    const nested = () => blocks(childBlocks(el));
    switch (type || el.tagName) {
        case "header": case "H1": return `# ${clean(type ? ownText(el) : inline(el))}`;
        case "sub_header": case "H2": return `## ${clean(type ? ownText(el) : inline(el))}`;
        case "sub_sub_header": case "H3": return `### ${clean(type ? ownText(el) : inline(el))}`;
        case "H4": case "H5": case "H6": return `#### ${clean(inline(el))}`;
        case "divider": case "HR": return "---";
        case "code": case "PRE": return codeBlock(el);
        case "table": case "TABLE": return table(el);
        case "equation": return `$$\n${clean(el.textContent ?? "")}\n$$`;
        case "UL": return list(el, false);
        case "OL": return list(el, true);
        case "BLOCKQUOTE": return indent(clean(blocks(childBlocks(el)) || inline(el)), "> ").replace(/^$/gm, ">");
        case "quote": case "callout": {
            const body = [clean(ownText(el)), nested()].filter(Boolean).join("\n\n");
            return indent(body, "> ").replace(/^$/gm, ">");
        }
        case "bulleted_list": case "numbered_list": case "to_do": case "toggle": {
            const checked = el.querySelector("[role='checkbox'][aria-checked='true'], input[type='checkbox']:checked");
            const marker = type === "numbered_list" ? `${number}. ` : type === "to_do" ? (checked ? "- [x] " : "- [ ] ") : "- ";
            const sub = nested();
            return `${marker}${clean(ownText(el))}${sub ? `\n${indent(sub, "   ")}` : ""}`;
        }
        case "text": case "P": {
            const sub = type ? nested() : "";
            const own = clean(type ? ownText(el) : inline(el));
            return [own, sub && indent(sub, "   ")].filter(Boolean).join("\n");
        }
        default: {
            const inner = childBlocks(el);
            return inner.length ? blocks(inner) : clean(inline(el));
        }
    }
}

const LIST_TYPES = new Set(["bulleted_list", "numbered_list", "to_do"]);

/** Blocks in order; consecutive list items stay together, other blocks get a blank line between. */
function blocks(list: Element[]): string {
    const out: string[] = [];
    let number = 0;
    let previous = "";
    for (const el of list) {
        const type = blockType(el);
        number = type === "numbered_list" ? (previous === "numbered_list" ? number + 1 : 1) : 0;
        const text = block(el, number);
        if (!text.trim()) continue;
        // Bullets and to-dos share a list; a numbered list after them starts a new one.
        const together = LIST_TYPES.has(type) && LIST_TYPES.has(previous) && (type === "numbered_list") === (previous === "numbered_list");
        out.push(together ? `\n${text}` : `\n\n${text}`);
        previous = type;
    }
    return out.join("").trim();
}

/** A reply's element as Markdown; its plain text when it holds no blocks at all. */
export function toMarkdown(root: Element): string {
    const top = childBlocks(root);
    const text = top.length ? blocks(top) : clean(inline(root));
    return clean(text);
}
