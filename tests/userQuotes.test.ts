/*
 * NotionAI++, a userscript for Notion AI
 * Copyright (c) 2026 NotionAI++ Contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";

import { buildMirror, quoteLines } from "@plugins/userQuotes/index";

describe("quote lines", () => {
    const text = "> F. 引用行样式\n>第二行\n\n完成落地\n  > again\na > not a quote";

    test("finds lines that start with >, with the marker and its space", () => {
        const lines = quoteLines(text);
        expect(lines.map(line => line.line)).toEqual([0, 1, 4]);
        expect(text.slice(lines[0].start, lines[0].body)).toBe("> ");
        expect(text.slice(lines[0].body, lines[0].end)).toBe("F. 引用行样式");
        expect(text.slice(lines[1].start, lines[1].body)).toBe(">");
        expect(text.slice(lines[2].start, lines[2].end)).toBe("> again");
    });

    test("lays quote runs out as indented blocks and keeps blank lines", () => {
        const box = document.createElement("div");
        box.append(buildMirror(text));
        const rows = [...box.children].map(child => child.className === "q" ? `[${[...child.children].map(row => row.textContent).join("|")}]` : child.textContent);
        expect(rows).toEqual(["[F. 引用行样式|第二行]", "", "完成落地", "[again]", "a > not a quote"]);
    });
});
