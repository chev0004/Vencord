/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Utilities for rendering Yomichan dictionary structured content
 */

import { Logger } from "@utils/Logger";

const logger = new Logger("Yomicord");

/**
 * Renders structured-content as DOM elements (similar to Yomitan's StructuredContentGenerator)
 * Handles elements with tag, content, style, href, etc.
 */
export function renderStructuredContent(content: any): HTMLElement | null {
    if (typeof content === "string") {
        const span = document.createElement("span");
        span.textContent = content;
        return span;
    }

    if (!(typeof content === "object" && content !== null)) {
        return null;
    }

    if (Array.isArray(content)) {
        const container = document.createElement("span");
        for (const item of content) {
            const rendered = renderStructuredContent(item);
            if (rendered) {
                container.appendChild(rendered);
            }
        }
        return container;
    }

    // Handle structured-content element
    const tag = content.tag;
    if (!tag) {
        return null;
    }

    let element: HTMLElement;

    switch (tag) {
        case 'br':
            return document.createElement("br");
        case 'a':
            element = document.createElement("a");
            if (content.href) {
                const anchor = element as HTMLAnchorElement;
                // Internal links (starting with ?) should be handled specially
                // For now, just show as text but could be made clickable later
                if (content.href.startsWith('?')) {
                    // Internal dictionary link - just render as text for now
                    anchor.style.cursor = "pointer";
                    anchor.style.textDecoration = "underline";
                } else {
                    anchor.href = content.href;
                    anchor.target = "_blank";
                    anchor.rel = "noopener noreferrer";
                }
            }
            break;
        case 'span':
        case 'div':
            element = document.createElement(tag);
            break;
        default:
            // For other tags, try to create them (fallback to span if invalid)
            try {
                element = document.createElement(tag);
            } catch {
                element = document.createElement("span");
            }
            break;
    }

    // Apply style
    if (content.style && typeof content.style === "object") {
        const style = content.style;
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

    // Set language attribute
    if (content.lang) {
        element.lang = content.lang;
    }

    // Set title attribute
    if (content.title) {
        element.title = content.title;
    }

    // Recursively render children
    if (content.content !== undefined) {
        const childContent = renderStructuredContent(content.content);
        if (childContent) {
            element.appendChild(childContent);
        }
    }

    return element;
}

/**
 * Extracts plain text from structured content as fallback
 */
export function extractTextFromStructuredContent(content: any): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(extractTextFromStructuredContent).filter((s: string) => s && s.trim()).join(" ");
    }
    if (typeof content === "object" && content !== null) {
        if (content.content !== undefined) {
            return extractTextFromStructuredContent(content.content);
        }
        if (content.text !== undefined) {
            return String(content.text);
        }
    }
    return "";
}

/**
 * Normalizes a definition to either a string or DOM element, handling various Yomichan dictionary formats:
 * - Simple strings: "definition"
 * - Objects with text property: {text: "definition"}
 * - Structured content: {type: 'structured-content', content: {...}} -> returns HTMLElement
 * - Arrays: ["definition1", "definition2"]
 * - Nested structures: [["definition1"], ["definition2"]]
 */
export function normalizeDefinition(def: any): string | HTMLElement {
    if (typeof def === "string") {
        return def;
    }
    if (typeof def === "object" && def !== null) {
        // Check for structured content element FIRST (most common case)
        // Structured content can be either:
        // 1. Direct element: {tag: "span", content: [...]}
        // 2. Wrapped: {type: 'structured-content', content: {tag: "span", ...}}
        if (def.tag && typeof def.tag === "string") {
            // Direct structured content element
            const rendered = renderStructuredContent(def);
            if (rendered) {
                return rendered;
            }
            // If rendering failed but we have a tag, try to extract text instead of stringifying
            const extracted = extractTextFromStructuredContent(def);
            if (extracted) {
                return extracted;
            }
        }

        // Handle wrapped structured content (type: 'structured-content')
        if (def.type === 'structured-content' && def.content) {
            const content = def.content;
            const rendered = renderStructuredContent(content);
            if (rendered) {
                return rendered;
            }
            // Fallback: try to extract text
            return extractTextFromStructuredContent(content);
        }

        // Handle objects with text property (common in bilingual dictionaries)
        if (def.text !== undefined) {
            return String(def.text);
        }
        // Handle arrays - join them (but check for structured content first)
        if (Array.isArray(def)) {
            // Check if any items are structured content
            const hasStructured = def.some((item: any) =>
                (item && typeof item === "object" && (item.type === 'structured-content' || item.tag))
            );
            if (hasStructured) {
                // Render as DOM elements
                const container = document.createElement("span");
                for (const item of def) {
                    const rendered = normalizeDefinition(item);
                    if (typeof rendered === "string") {
                        const span = document.createElement("span");
                        span.textContent = rendered;
                        container.appendChild(span);
                    } else {
                        container.appendChild(rendered);
                    }
                }
                return container;
            }
            // For arrays of plain strings, join them
            return def.map((d: any) => {
                const normalized = normalizeDefinition(d);
                return typeof normalized === "string" ? normalized : extractTextFromStructuredContent(normalized);
            }).join(", ");
        }
        // Handle other object types - try common properties
        if (def.content !== undefined) {
            const content = def.content;
            if (typeof content === "string") {
                return content;
            }
            // If content is an object, recursively normalize it
            const rendered = normalizeDefinition(content);
            if (rendered) {
                return rendered;
            }
        }
        if (def.value !== undefined) {
            return String(def.value);
        }
        // If we have any recognizable properties, try to extract text
        if (def.text !== undefined) {
            return String(def.text);
        }
        // Last resort: try to extract text from structured content
        const extracted = extractTextFromStructuredContent(def);
        if (extracted) {
            return extracted;
        }
        // Final fallback: stringify (shouldn't happen with proper dictionaries)
        logger.warn(`[Dictionary] Unhandled definition format, stringifying:`, def);
        return JSON.stringify(def, null, 2);
    }
    return String(def);
}

