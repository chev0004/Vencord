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
import { findByCodeLazy } from "@webpack";
import { createRoot, React, scrollerClasses } from "@webpack/common";

import { cleanupOrphanedDictionaryKeys, type DictionaryEntry, getDictionaryPriorities, lookupTerm, sortDictionariesByPriority } from "./dictionary";
import { DictionarySettings } from "./DictionarySettings";
import { getTextAtPoint } from "./textScanner";
import { normalizeDefinition } from "./utils";

const logger = new Logger("Yomicord");
const Spinner = findByCodeLazy("wanderingCubes");

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
    showReadings: {
        type: OptionType.BOOLEAN,
        description: "Show readings (furigana) in tooltip",
        default: true
    },
    maxDefinitions: {
        type: OptionType.NUMBER,
        description: "Maximum number of definitions to show",
        default: 3
    },
    scanPopupContent: {
        type: OptionType.BOOLEAN,
        description: "Allow scanning text in popup tooltips (enables nested tooltips)",
        default: false
    },
    maxPopupNesting: {
        type: OptionType.NUMBER,
        description: "Maximum number of nested popup tooltips",
        default: 1
    },
    dictionarySettings: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => <DictionarySettings />
    }
});

interface Tooltip {
    container: HTMLDivElement;
    header: HTMLDivElement;
    tabs: HTMLDivElement;
    content: HTMLDivElement;
    removalTimeout: number | null;
    reactRoot: ReturnType<typeof createRoot> | null;
    lookupId: number;
    anchor: { x: number; y: number; } | null;
}

const tooltips = new Map<number, Tooltip>();
let currentText: string | null = null;
let lookupSeq = 0;
let mouseMoveTimeout: number | null = null;

const SCAN_KEY_NAMES: Record<string, string> = { alt: "Alt", ctrl: "Control", shift: "Shift" };

function isScanKeyPressed(e: MouseEvent): boolean {
    switch (settings.store.scanKey) {
        case "ctrl": return e.ctrlKey;
        case "shift": return e.shiftKey;
        default: return e.altKey;
    }
}

function createTooltip(level: number): Tooltip {
    const container = document.createElement("div");
    container.className = "yomicord-tooltip";
    container.setAttribute("data-popup-level", String(level));
    container.style.zIndex = String(10000 + level);
    container.addEventListener("mousedown", () => hideTooltipsAtLevel(level + 1));

    const header = document.createElement("div");
    header.className = "yomicord-header";

    const tabs = document.createElement("div");
    tabs.className = "yomicord-tabs";
    tabs.addEventListener("wheel", e => {
        if (e.deltaY !== 0) tabs.scrollLeft += e.deltaY;
    });

    const closeButton = document.createElement("button");
    closeButton.className = "yomicord-close";
    closeButton.textContent = "✕";
    closeButton.onclick = e => {
        e.stopPropagation();
        hideTooltipsAtLevel(level);
    };

    header.append(tabs, closeButton);

    const content = document.createElement("div");
    content.className = `yomicord-content ${scrollerClasses.thin ?? ""}`;

    container.append(header, content);
    document.body.appendChild(container);

    return { container, header, tabs, content, removalTimeout: null, reactRoot: null, lookupId: 0, anchor: null };
}

function showTooltip(x: number, y: number, content: string | HTMLElement, level: number, activeDict?: string, dictNames?: string[], onSwapDictionary?: (dict: string) => void) {
    let tooltip = tooltips.get(level);
    if (tooltip) {
        if (tooltip.removalTimeout !== null) {
            clearTimeout(tooltip.removalTimeout);
            tooltip.removalTimeout = null;
        }
    } else {
        hideTooltipsAtLevel(level + 1);
        tooltip = createTooltip(level);
        tooltips.set(level, tooltip);
    }

    tooltip.tabs.innerHTML = "";
    if (dictNames) {
        const clickable = dictNames.length > 1;
        for (const dictName of dictNames) {
            const tab = document.createElement("button");
            tab.className = "yomicord-tab";
            tab.textContent = dictName;
            if (dictName === activeDict) tab.classList.add("active");
            else if (clickable) tab.classList.add("clickable");
            if (clickable && onSwapDictionary) {
                tab.onclick = e => {
                    e.stopPropagation();
                    onSwapDictionary(dictName);
                };
            }
            tooltip.tabs.appendChild(tab);
        }
    }

    tooltip.reactRoot?.unmount();
    tooltip.reactRoot = null;
    tooltip.content.innerHTML = "";
    if (typeof content === "string") tooltip.content.textContent = content;
    else tooltip.content.appendChild(content);

    const isLoading = content instanceof HTMLElement && content.classList.contains("yomicord-loading");
    tooltip.header.style.display = isLoading ? "none" : "flex";

    const { container } = tooltip;
    container.style.display = "block";
    container.style.opacity = "1";

    let left = x + 15;
    let top = y + 15;
    const rect = container.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - 10) left = x - rect.width - 15;
    if (top + rect.height > window.innerHeight - 10) top = y - rect.height - 15;
    container.style.left = `${Math.max(10, left)}px`;
    container.style.top = `${Math.max(10, top)}px`;
}

function hideTooltipsAtLevel(level: number) {
    for (const [tooltipLevel, tooltip] of tooltips) {
        if (tooltipLevel < level) continue;
        if (tooltip.removalTimeout !== null) clearTimeout(tooltip.removalTimeout);
        tooltip.container.style.opacity = "0";
        tooltip.removalTimeout = window.setTimeout(() => {
            tooltip.reactRoot?.unmount();
            tooltip.reactRoot = null;
            tooltips.delete(tooltipLevel);
            tooltip.container.remove();
        }, 100);
    }
}

function hideAllTooltips() {
    lookupSeq++;
    hideTooltipsAtLevel(0);
}

function isInsideTooltip(element: Element | null): { isInside: boolean; popupLevel: number; } {
    const tooltip = element?.closest(".yomicord-tooltip");
    if (!tooltip) return { isInside: false, popupLevel: 0 };
    return { isInside: true, popupLevel: parseInt(tooltip.getAttribute("data-popup-level") ?? "0", 10) + 1 };
}

function handleMouseMove(e: MouseEvent) {
    if (mouseMoveTimeout !== null) clearTimeout(mouseMoveTimeout);
    mouseMoveTimeout = window.setTimeout(() => {
        mouseMoveTimeout = null;
        void handleMouseMoveDebounced(e);
    }, 50);
}

async function handleMouseMoveDebounced(e: MouseEvent) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const { isInside, popupLevel } = isInsideTooltip(target);

    if (isInside) {
        if (!settings.store.scanPopupContent) return;
        if (popupLevel > settings.store.maxPopupNesting) return;
        if (target?.closest('[data-yomicord-entry="true"]')) return;
    }
    if (!isScanKeyPressed(e)) return;

    const currentLevel = isInside ? popupLevel - 1 : 0;
    let anchor = tooltips.get(currentLevel)?.anchor ?? null;
    if (!anchor) {
        for (const t of tooltips.values()) anchor = t.anchor ?? anchor;
    }
    const isNearLastPosition = !!anchor && Math.abs(e.clientX - anchor.x) < 100 && Math.abs(e.clientY - anchor.y) < 100;

    const scanned = getTextAtPoint(e.clientX, e.clientY, isInside ? 25 : 15);
    if (!scanned) {
        if (!isInside && !isNearLastPosition) {
            hideAllTooltips();
            currentText = null;
        }
        return;
    }

    if (scanned.text === currentText && (isInside || isNearLastPosition)) return;
    currentText = scanned.text;

    const level = isInside ? popupLevel : 0;
    const myLookup = ++lookupSeq;
    const loading = createLoadingIndicator();
    showTooltip(scanned.rect.left, scanned.rect.bottom, loading.element, level);

    const tooltip = tooltips.get(level)!;
    tooltip.reactRoot = loading.root;
    tooltip.lookupId = myLookup;
    tooltip.anchor = { x: e.clientX, y: e.clientY };

    const entries = await lookupTerm(scanned.text);

    if (myLookup !== lookupSeq) {
        if (tooltips.get(level)?.lookupId === myLookup) hideAllTooltips();
        return;
    }

    if (entries.length === 0) {
        logger.info(`No results found for: "${scanned.text}"`);
        hideTooltipsAtLevel(level);
        return;
    }

    const entriesByDict = new Map<string, DictionaryEntry[]>();
    for (const entry of entries) {
        const dictName = entry.dictionary || "Unknown";
        let list = entriesByDict.get(dictName);
        if (!list) entriesByDict.set(dictName, list = []);
        list.push(entry);
    }

    const priorities = await getDictionaryPriorities();
    const dictNames = sortDictionariesByPriority([...entriesByDict.keys()], priorities);

    const updateTooltip = (dictName: string) => {
        const dictEntries = entriesByDict.get(dictName);
        if (!dictEntries) return;
        showTooltip(scanned.rect.left, scanned.rect.bottom, formatDictionaryResults(dictEntries), level, dictName, dictNames, updateTooltip);
    };
    updateTooltip(dictNames[0]);
}

function createLoadingIndicator(): { element: HTMLElement; root: ReturnType<typeof createRoot> | null; } {
    const element = document.createElement("div");
    element.className = "yomicord-loading";

    const wrapper = document.createElement("div");
    wrapper.className = "yomicord-spinner";
    element.appendChild(wrapper);

    let root: ReturnType<typeof createRoot> | null = null;
    try {
        root = createRoot(wrapper);
        root.render(React.createElement(Spinner, { type: Spinner.Type.WANDERING_CUBES }));
    } catch {
        root?.unmount();
        root = null;
        wrapper.textContent = "Loading...";
    }

    return { element, root };
}

function formatDictionaryResults(entries: DictionaryEntry[]): HTMLElement {
    const container = document.createElement("div");
    const sorted = [...entries].sort((a, b) => (b.score || 0) - (a.score || 0));
    const maxDefs = entries.length > 10 ? 30 : settings.store.maxDefinitions;

    for (const entry of sorted.slice(0, maxDefs)) {
        const entryDiv = document.createElement("div");
        entryDiv.className = "yomicord-entry";

        const termLine = document.createElement("div");
        termLine.className = "yomicord-term-line";

        const termSpan = document.createElement("span");
        termSpan.className = "yomicord-term";
        termSpan.setAttribute("data-yomicord-entry", "true");
        termSpan.textContent = entry.term;
        termLine.appendChild(termSpan);

        if (settings.store.showReadings && entry.reading && entry.reading !== entry.term) {
            const readingSpan = document.createElement("span");
            readingSpan.className = "yomicord-reading";
            readingSpan.setAttribute("data-yomicord-entry", "true");
            readingSpan.textContent = `【${entry.reading}】`;
            termLine.appendChild(readingSpan);
        }
        entryDiv.appendChild(termLine);

        entry.definitions.slice(0, 3).forEach((def, i) => {
            const defDiv = document.createElement("div");
            defDiv.className = "yomicord-def";
            const normalized = normalizeDefinition(def);
            if (typeof normalized === "string") defDiv.textContent = `${i + 1}. ${normalized}`;
            else defDiv.append(`${i + 1}. `, normalized);
            entryDiv.appendChild(defDiv);
        });

        container.appendChild(entryDiv);
    }

    return container;
}

function handleKeyUp(e: KeyboardEvent) {
    if (e.key === SCAN_KEY_NAMES[settings.store.scanKey]) {
        lookupSeq++;
        currentText = null;
    }
}

function handleWindowBlur() {
    lookupSeq++;
    currentText = null;
}

function handleGlobalMouseDown(e: MouseEvent) {
    if (tooltips.size === 0 || isScanKeyPressed(e)) return;
    for (const { container } of tooltips.values()) {
        if (container.contains(e.target as Node)) return;
    }
    hideAllTooltips();
}

export default definePlugin({
    name: "Yomicord",
    description: "Hover over Japanese text while holding Alt to see a tooltip (inspired by Yomichan)",
    authors: [Devs.chev],
    settings,

    start() {
        document.addEventListener("keyup", handleKeyUp, true);
        document.addEventListener("mousemove", handleMouseMove, true);
        document.addEventListener("mousedown", handleGlobalMouseDown);
        window.addEventListener("blur", handleWindowBlur);
        void cleanupOrphanedDictionaryKeys();
    },

    stop() {
        document.removeEventListener("keyup", handleKeyUp, true);
        document.removeEventListener("mousemove", handleMouseMove, true);
        document.removeEventListener("mousedown", handleGlobalMouseDown);
        window.removeEventListener("blur", handleWindowBlur);

        if (mouseMoveTimeout !== null) {
            clearTimeout(mouseMoveTimeout);
            mouseMoveTimeout = null;
        }
        lookupSeq++;

        for (const tooltip of tooltips.values()) {
            if (tooltip.removalTimeout !== null) clearTimeout(tooltip.removalTimeout);
            tooltip.reactRoot?.unmount();
            tooltip.container.remove();
        }
        tooltips.clear();
        currentText = null;
    },
});
