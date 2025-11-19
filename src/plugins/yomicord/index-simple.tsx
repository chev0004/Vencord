/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";

const logger = new Logger("Yomicord");

const settings = definePluginSettings({
    scanKey: {
        type: OptionType.SELECT,
        description: "Key to hold while hovering to scan text",
        options: [
            { label: "Alt", value: "alt", default: true },
            { label: "Ctrl", value: "ctrl" },
            { label: "Shift", value: "shift" },
        ],
        default: "alt"
    },
});

let tooltipContainer: HTMLDivElement | null = null;
let isKeyPressed = false;
let currentText: string | null = null;

function createTooltip(): HTMLDivElement {
    const tooltip = document.createElement("div");
    tooltip.id = "yomicord-tooltip";
    tooltip.style.cssText = `
        position: fixed;
        background: var(--background-floating);
        border: 1px solid var(--background-modifier-accent);
        border-radius: 4px;
        padding: 8px 12px;
        color: var(--text-normal);
        font-size: 14px;
        pointer-events: none;
        z-index: 10000;
        display: none;
        max-width: 400px;
        word-wrap: break-word;
        box-shadow: var(--elevation-high);
    `;
    document.body.appendChild(tooltip);
    return tooltip;
}

function showTooltip(x: number, y: number, text: string) {
    logger.info(`showTooltip called with text: "${text}" at (${x}, ${y})`);
    
    if (!tooltipContainer) {
        logger.info("Creating tooltip container");
        tooltipContainer = createTooltip();
    }

    tooltipContainer.textContent = text;
    tooltipContainer.style.display = "block";
    
    let left = x + 10;
    let top = y + 10;

    tooltipContainer.style.left = `${left}px`;
    tooltipContainer.style.top = `${top}px`;
    
    logger.info(`Tooltip positioned at (${left}, ${top})`);
}

function hideTooltip() {
    if (tooltipContainer) {
        tooltipContainer.style.display = "none";
    }
}

function getTextAtPoint(x: number, y: number): string | null {
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return null;
    
    const textNode = range.startContainer;
    if (textNode.nodeType !== Node.TEXT_NODE) return null;
    
    const text = textNode.textContent || "";
    const offset = range.startOffset;
    
    // Get a chunk of text around the cursor
    const start = Math.max(0, offset - 20);
    const end = Math.min(text.length, offset + 20);
    
    return text.substring(start, end);
}

function handleMouseMove(e: MouseEvent) {
    if (!isKeyPressed) {
        hideTooltip();
        return;
    }

    const text = getTextAtPoint(e.clientX, e.clientY);
    
    if (text && text.trim().length > 0) {
        logger.info("Found text at point:", text);
        showTooltip(e.clientX, e.clientY, text);
        currentText = text;
    } else {
        hideTooltip();
        currentText = null;
    }
}

function handleKeyDown(e: KeyboardEvent) {
    const scanKey = settings.store.scanKey;
    logger.info(`Key down: ${e.key}, scanKey: ${scanKey}, matches: ${checkKeyMatch(e, scanKey)}`);
    
    if (checkKeyMatch(e, scanKey)) {
        isKeyPressed = true;
        logger.info("Scan key pressed, isKeyPressed:", isKeyPressed);
    }
}

function handleKeyUp(e: KeyboardEvent) {
    const scanKey = settings.store.scanKey;
    
    if (checkKeyMatch(e, scanKey)) {
        isKeyPressed = false;
        hideTooltip();
        currentText = null;
        logger.info("Scan key released");
    }
}

function checkKeyMatch(e: KeyboardEvent, scanKey: string): boolean {
    switch (scanKey) {
        case "alt":
            return e.key === "Alt" || e.altKey;
        case "ctrl":
            return e.key === "Control" || e.ctrlKey;
        case "shift":
            return e.key === "Shift" || e.shiftKey;
        default:
            return false;
    }
}

function initializeSimple() {
    logger.info("Initializing simple scanner");
    
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("mousemove", handleMouseMove, true);
    
    logger.info("Event listeners attached");
}

function cleanup() {
    logger.info("Cleaning up");
    
    document.removeEventListener("keydown", handleKeyDown, true);
    document.removeEventListener("keyup", handleKeyUp, true);
    document.removeEventListener("mousemove", handleMouseMove, true);
    
    if (tooltipContainer) {
        tooltipContainer.remove();
        tooltipContainer = null;
    }
    
    isKeyPressed = false;
    currentText = null;
}

export default definePlugin({
    name: "Yomicord",
    description: "Hover over text while holding Alt to see a tooltip (simple version for testing)",
    authors: [Devs.chev],
    settings,

    start() {
        logger.info("=== YOMICORD STARTING (SIMPLE) ===");
        logger.info("Settings:", settings.store);
        initializeSimple();
    },

    stop() {
        logger.info("=== YOMICORD STOPPING ===");
        cleanup();
    },
});

