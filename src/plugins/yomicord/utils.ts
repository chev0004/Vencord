/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

const logger = new Logger("Yomicord");

const SAFE_TAGS = new Set(["span", "div", "ruby", "rt", "rp", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "ol", "ul", "li", "details", "summary"]);

function renderStructuredContent(content: any): HTMLElement | null {
    if (typeof content === "string") {
        const span = document.createElement("span");
        span.textContent = content;
        return span;
    }

    if (typeof content !== "object" || content === null) return null;

    if (Array.isArray(content)) {
        const container = document.createElement("span");
        for (const item of content) {
            const rendered = renderStructuredContent(item);
            if (rendered) container.appendChild(rendered);
        }
        return container;
    }

    const { tag } = content;
    if (!tag) return null;
    if (tag === "br") return document.createElement("br");

    let element: HTMLElement;
    if (tag === "a") {
        const anchor = document.createElement("a");
        if (typeof content.href === "string" && /^https?:\/\//.test(content.href)) {
            anchor.href = content.href;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
        }
        element = anchor;
    } else {
        element = document.createElement(SAFE_TAGS.has(tag) ? tag : "span");
    }

    const { style } = content;
    if (style && typeof style === "object") {
        if (style.fontSize) element.style.fontSize = style.fontSize;
        if (style.color) element.style.color = style.color;
        if (style.backgroundColor || style.background) {
            element.style.backgroundColor = style.backgroundColor || style.background;
        }
        if (style.fontWeight) element.style.fontWeight = style.fontWeight;
        if (style.fontStyle) element.style.fontStyle = style.fontStyle;
        if (style.textDecorationLine) {
            element.style.textDecorationLine = Array.isArray(style.textDecorationLine)
                ? style.textDecorationLine.join(" ")
                : style.textDecorationLine;
        }
        if (style.textAlign) element.style.textAlign = style.textAlign;
        if (style.verticalAlign) element.style.verticalAlign = style.verticalAlign;
        if (style.margin) element.style.margin = style.margin;
        if (style.padding) element.style.padding = style.padding;
    }

    if (content.lang) element.lang = content.lang;
    if (content.title) element.title = content.title;

    if (content.content !== undefined) {
        const child = renderStructuredContent(content.content);
        if (child) element.appendChild(child);
    }

    return element;
}

function extractTextFromStructuredContent(content: any): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map(extractTextFromStructuredContent).filter(s => s.trim()).join(" ");
    }
    if (typeof content === "object" && content !== null) {
        if (content.content !== undefined) return extractTextFromStructuredContent(content.content);
        if (content.text !== undefined) return String(content.text);
    }
    return "";
}

export function normalizeDefinition(def: any): string | HTMLElement {
    if (typeof def === "string") return def;

    if (typeof def === "object" && def !== null) {
        if (def.tag && typeof def.tag === "string") {
            const rendered = renderStructuredContent(def);
            if (rendered) return rendered;
            const extracted = extractTextFromStructuredContent(def);
            if (extracted) return extracted;
        }

        if (def.type === "structured-content" && def.content) {
            const rendered = renderStructuredContent(def.content);
            if (rendered) return rendered;
            return extractTextFromStructuredContent(def.content);
        }

        if (def.text !== undefined) return String(def.text);

        if (Array.isArray(def)) {
            const hasStructured = def.some(item => item && typeof item === "object" && (item.type === "structured-content" || item.tag));
            if (hasStructured) {
                const container = document.createElement("span");
                for (const item of def) {
                    const normalized = normalizeDefinition(item);
                    if (typeof normalized === "string") {
                        const span = document.createElement("span");
                        span.textContent = normalized;
                        container.appendChild(span);
                    } else {
                        container.appendChild(normalized);
                    }
                }
                return container;
            }
            return def.map(d => {
                const normalized = normalizeDefinition(d);
                return typeof normalized === "string" ? normalized : normalized.textContent ?? "";
            }).join(", ");
        }

        if (def.content !== undefined) {
            if (typeof def.content === "string") return def.content;
            const rendered = normalizeDefinition(def.content);
            if (rendered) return rendered;
        }

        if (def.value !== undefined) return String(def.value);

        const extracted = extractTextFromStructuredContent(def);
        if (extracted) return extracted;

        logger.warn("Unhandled definition format, stringifying:", def);
        return JSON.stringify(def, null, 2);
    }

    return String(def);
}
