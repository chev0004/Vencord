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
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { React, createRoot } from "@webpack/common";

import { DictionarySettings } from "./DictionarySettings";
import { lookupTerm } from "./dictionary";
import { getTextAtPoint, getTextCandidates } from "./textScanner";

const logger = new Logger("Yomicord");

const ScrollerClasses = findByPropsLazy("thin", "auto", "customTheme");
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

const tooltips = new Map<number, { container: HTMLDivElement; header: HTMLDivElement; content: HTMLDivElement; }>();
let isKeyPressed = false;
let currentText: string | null = null;
let lastTooltipPosition: { x: number; y: number; } | null = null;
const lastTooltipPositionsByLevel = new Map<number, { x: number; y: number; }>();

// Debouncing and cancellation
let mouseMoveTimeout: number | null = null;
let pendingLookupAborted = false;
let globalClickHandler: ((e: MouseEvent) => void) | null = null;

function createTooltip(popupLevel: number = 0): { container: HTMLDivElement; header: HTMLDivElement; content: HTMLDivElement; } {
    const tooltip = document.createElement("div");
    tooltip.className = "yomicord-tooltip";
    tooltip.setAttribute("data-popup-level", popupLevel.toString());
    tooltip.style.cssText = `
        position: fixed;
        background: rgb(24, 25, 28);
        border: 1px solid var(--background-modifier-accent);
        border-radius: 8px;
        color: var(--text-muted);
        font-family: var(--font-primary);
        pointer-events: auto;
        z-index: ${10000 + popupLevel};
        display: none;
        max-width: 450px;
        max-height: 70vh;
        box-shadow: var(--elevation-high);
        transition: opacity 0.15s ease;
        opacity: 1;
        overflow: hidden;
        cursor: default;
    `;

    // Create header with dictionary tabs and buttons
    const header = document.createElement("div");
    header.style.cssText = `
        display: flex;
        align-items: center;
        padding: 8px 12px;
        border-bottom: 1px solid var(--background-modifier-accent);
        background: var(--background-secondary);
        gap: 8px;
    `;

    // Dictionary tabs container
    const tabsContainer = document.createElement("div");
    tabsContainer.style.cssText = `
        flex: 1;
        display: flex;
        gap: 4px;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
        -ms-overflow-style: none;
    `;
    tabsContainer.setAttribute("data-tabs-container", "true");
    // Hide scrollbar
    tabsContainer.addEventListener("wheel", (e) => {
        if (e.deltaY !== 0) {
            tabsContainer.scrollLeft += e.deltaY;
        }
    });
    header.appendChild(tabsContainer);

    // Close button
    const closeButton = document.createElement("button");
    closeButton.innerHTML = "✕";
    closeButton.style.cssText = `
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: var(--text-muted);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: background-color 0.1s ease, color 0.1s ease;
    `;
    closeButton.onmouseenter = () => {
        closeButton.style.backgroundColor = "var(--background-modifier-hover)";
        closeButton.style.color = "var(--text-normal)";
    };
    closeButton.onmouseleave = () => {
        closeButton.style.backgroundColor = "transparent";
        closeButton.style.color = "var(--text-muted)";
    };
    closeButton.onclick = (e) => {
        e.stopPropagation();
        hideTooltipsAtLevel(popupLevel, "close button clicked");
    };
    header.appendChild(closeButton);
    tooltip.appendChild(header);

    // Create scrollable content container
    const tooltipContent = document.createElement("div");
    tooltipContent.style.cssText = `
        padding: 12px 16px;
        font-size: 15px;
        line-height: 1.6;
        word-wrap: break-word;
        overflow-y: auto;
        max-height: calc(70vh - 50px);
    `;
    // Apply Discord's thin scrollbar styling
    if (ScrollerClasses?.thin) {
        tooltipContent.className = ScrollerClasses.thin;
    }
    tooltip.appendChild(tooltipContent);

    document.body.appendChild(tooltip);
    return { container: tooltip, header, content: tooltipContent };
}

function showTooltip(x: number, y: number, content: string | HTMLElement, popupLevel: number = 0, dictionaryName?: string, dictionaries?: string[], onSwapDictionary?: (dictName: string) => void) {
    // Get existing tooltip first
    let tooltip = tooltips.get(popupLevel);
    const isUpdating = !!tooltip;

    // If we're updating an existing tooltip, cancel any pending removal
    if (isUpdating && tooltip) {
        const container = tooltip.container;
        const existingTimeout = (container as any)._removalTimeout;
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            (container as any)._removalTimeout = null;
        }
        // Make sure it's visible
        container.style.opacity = "1";
        container.style.display = "block";
    }

    // Only hide tooltips at HIGHER levels (not same level or lower)
    // If we're updating the same level, don't hide it - just update the content
    if (popupLevel > 0 && !isUpdating) {
        // Only hide tooltips at levels higher than this one
        hideTooltipsAtLevel(popupLevel + 1, "showing tooltip at lower level");
    } else if (popupLevel === 0 && !isUpdating) {
        // Only hide tooltips at level 0 if we're creating a new one (not updating)
        // This prevents flickering when updating content
        hideTooltipsAtLevel(popupLevel, "creating new tooltip at level 0");
    }

    // Create new tooltip if it doesn't exist for this level
    if (!tooltip) {
        tooltip = createTooltip(popupLevel);
        tooltips.set(popupLevel, tooltip);
    }

    const { container: tooltipContainer, header, content: tooltipContent } = tooltip;

    // Reduced logging for performance
    // logger.info(`[Tooltip] showTooltip called: popupLevel=${popupLevel}, isUpdating=${isUpdating}, dict=${dictionaryName || 'none'}`);

    // Update header with tabs
    const tabsContainer = header.querySelector('[data-tabs-container]') as HTMLElement;

    if (tabsContainer) {
        // Clear existing tabs
        tabsContainer.innerHTML = "";

        // Always show tabs if we have dictionaries (even if only one)
        if (dictionaries && dictionaries.length > 0) {
            // Create tabs for each dictionary
            dictionaries.forEach((dictName) => {
                const tab = document.createElement("button");
                tab.textContent = dictName;
                const isActive = dictName === dictionaryName;
                tab.style.cssText = `
                    padding: 4px 8px;
                    border: none;
                    background: ${isActive
                        ? 'var(--background-modifier-accent)'
                        : 'transparent'};
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: ${isActive ? '500' : '400'};
                    color: ${isActive
                        ? 'var(--text-normal)'
                        : 'var(--text-muted)'};
                    cursor: ${dictionaries.length > 1 ? 'pointer' : 'default'};
                    white-space: nowrap;
                    transition: background-color 0.1s ease, color 0.1s ease;
                    flex-shrink: 0;
                `;

                if (isActive) {
                    tab.setAttribute("data-active-tab", "true");
                }

                tab.onmouseenter = () => {
                    if (!isActive && dictionaries.length > 1) {
                        tab.style.backgroundColor = "var(--background-modifier-hover)";
                        tab.style.color = "var(--text-normal)";
                    }
                };

                tab.onmouseleave = () => {
                    if (!isActive) {
                        tab.style.backgroundColor = "transparent";
                        tab.style.color = "var(--text-muted)";
                    }
                };

                if (onSwapDictionary && dictionaries.length > 1) {
                    tab.onclick = (e) => {
                        e.stopPropagation();
                        onSwapDictionary(dictName);
                    };
                }

                tabsContainer.appendChild(tab);
            });
        }
    }

    // Clear previous content
    tooltipContent.innerHTML = "";

    // Set new content
    if (typeof content === "string") {
        tooltipContent.textContent = content;
    } else {
        tooltipContent.appendChild(content);
    }

    // Check if this is a loading indicator and hide header if so
    const isLoading = content instanceof HTMLElement && content.classList.contains("yomicord-loading");
    if (isLoading) {
        header.style.display = "none";
    } else {
        header.style.display = "flex";
    }

    tooltipContainer.style.display = "block";
    tooltipContainer.style.opacity = "1";

    // Position below and to the right of cursor
    let left = x + 15;
    let top = y + 15;

    // Get tooltip dimensions after setting content
    const rect = tooltipContainer.getBoundingClientRect();

    // Adjust if tooltip goes off screen
    if (left + rect.width > window.innerWidth - 10) {
        left = x - rect.width - 15;
    }
    if (top + rect.height > window.innerHeight - 10) {
        top = y - rect.height - 15;
    }

    // Keep it on screen
    left = Math.max(10, left);
    top = Math.max(10, top);

    tooltipContainer.style.left = `${left}px`;
    tooltipContainer.style.top = `${top}px`;

    // Add click handler to this tooltip - clicking anywhere removes all child tooltips
    const handleTooltipClick = (e: MouseEvent) => {
        // Check if the click is inside this tooltip
        const target = e.target as Element;
        if (tooltipContainer.contains(target)) {
            // Hide all tooltips at levels higher than this one
            // (scanning happens on hover, not click, so this won't interfere)
            hideTooltipsAtLevel(popupLevel + 1, "tooltip clicked (nested tooltips)");
        }
    };

    // Remove any existing click handler first
    const existingClickHandler = (tooltipContainer as any)._clickHandler;
    if (existingClickHandler) {
        tooltipContainer.removeEventListener("mousedown", existingClickHandler);
    }

    // Add click handler
    (tooltipContainer as any)._clickHandler = handleTooltipClick;
    tooltipContainer.addEventListener("mousedown", handleTooltipClick);

    // Use a single global click handler instead of per-tooltip handlers
    // This prevents accumulation of event listeners
    if (!globalClickHandler) {
        globalClickHandler = (e: MouseEvent) => {
            // Only hide if click is outside all tooltips AND the scan key is not pressed
            const scanKey = settings.store.scanKey;
            let keyPressed = false;
            switch (scanKey) {
                case "alt":
                    keyPressed = e.altKey;
                    break;
                case "ctrl":
                    keyPressed = e.ctrlKey;
                    break;
                case "shift":
                    keyPressed = e.shiftKey;
                    break;
            }

            // Don't hide if the scan key is still pressed
            if (keyPressed) {
                return;
            }

            let clickedInsideAnyTooltip = false;
            for (const { container } of tooltips.values()) {
                if (container.contains(e.target as Node)) {
                    clickedInsideAnyTooltip = true;
                    break;
                }
            }
            if (!clickedInsideAnyTooltip) {
                // Only log occasionally to avoid spam
                if (Math.random() < 0.01) {  // Log ~1% of clicks to avoid spam
                }
                hideAllTooltips("click outside tooltip");
            }
        };
        document.addEventListener("mousedown", globalClickHandler);
    }
}

function hideTooltipsAtLevel(level: number, reason: string = "unknown") {
    // Hide all tooltips at this level or higher
    for (const [tooltipLevel, { container }] of tooltips.entries()) {
        if (tooltipLevel >= level) {
            // Cancel any pending removal timeout
            const existingTimeout = (container as any)._removalTimeout;
            if (existingTimeout) {
                clearTimeout(existingTimeout);
                (container as any)._removalTimeout = null;
            }

            // Remove event handlers
            const clickHandler = (container as any)._clickHandler;
            if (clickHandler) {
                container.removeEventListener("mousedown", clickHandler);
                (container as any)._clickHandler = null;
            }

            container.style.opacity = "0";
            const timeout = setTimeout(() => {
                // Unmount any React roots before removing
                const reactRoot = (container as any)._reactRoot;
                if (reactRoot) {
                    reactRoot.unmount();
                    (container as any)._reactRoot = null;
                }
                container.style.display = "none";
                tooltips.delete(tooltipLevel);
                container.remove();
            }, 100);
            (container as any)._removalTimeout = timeout;
        }
    }
}

function hideAllTooltips(reason: string = "unknown") {
    // Abort any pending lookup
    pendingLookupAborted = true;

    // Remove all event handlers first
    for (const { container } of tooltips.values()) {
        const clickHandler = (container as any)._clickHandler;
        if (clickHandler) {
            container.removeEventListener("mousedown", clickHandler);
            (container as any)._clickHandler = null;
        }
        container.style.opacity = "0";
    }
    setTimeout(() => {
        for (const { container } of tooltips.values()) {
            // Unmount any React roots before removing
            const reactRoot = (container as any)._reactRoot;
            if (reactRoot) {
                reactRoot.unmount();
                (container as any)._reactRoot = null;
            }
            container.style.display = "none";
            container.remove();
        }
        tooltips.clear();
        lastTooltipPosition = null;
        lastTooltipPositionsByLevel.clear();
    }, 100);
}

function hideTooltip(reason: string = "unknown") {
    hideAllTooltips(reason);
}

/**
 * Checks if an element is inside a Yomicord tooltip
 */
function isInsideTooltip(element: Element | null): { isInside: boolean; popupLevel: number; } {
    if (!element) return { isInside: false, popupLevel: 0 };

    let current: Element | null = element;
    let maxLevel = 0;

    while (current) {
        if (current.classList.contains("yomicord-tooltip") || current.getAttribute("data-popup-level") !== null) {
            const level = parseInt(current.getAttribute("data-popup-level") || "0", 10);
            maxLevel = Math.max(maxLevel, level);
            return { isInside: true, popupLevel: maxLevel + 1 };
        }
        current = current.parentElement;
    }

    return { isInside: false, popupLevel: 0 };
}

/**
 * Checks if the element is a main entry word (term or reading) that should not be scannable
 */
function isMainEntryWord(element: Element | null): boolean {
    if (!element) return false;

    let current: Element | null = element;
    while (current) {
        // Check if this element has the data attribute marking it as a main entry (term or reading)
        if (current.getAttribute("data-yomicord-entry") === "true") {
            return true;
        }
        // Stop checking if we've left the tooltip
        if (current.classList.contains("yomicord-tooltip")) {
            break;
        }
        current = current.parentElement;
    }

    return false;
}

/**
 * Checks if the element is definition text that should be scannable
 */
function isDefinitionText(element: Element | null): boolean {
    if (!element) return false;

    let current: Element | null = element;
    while (current) {
        // Check if this element has the data attribute marking it as a definition
        if (current.getAttribute("data-yomicord-definition") === "true") {
            return true;
        }
        // Stop checking if we've left the tooltip
        if (current.classList.contains("yomicord-tooltip")) {
            break;
        }
        current = current.parentElement;
    }

    return false;
}

// Debounced mouse move handler
function handleMouseMove(e: MouseEvent) {
    // Clear any pending mouse move handler
    if (mouseMoveTimeout !== null) {
        clearTimeout(mouseMoveTimeout);
        mouseMoveTimeout = null;
    }

    // Debounce: wait 50ms before processing
    // This prevents rapid-fire scans when mouse moves quickly
    mouseMoveTimeout = window.setTimeout(() => {
        mouseMoveTimeout = null;
        handleMouseMoveDebounced(e);
    }, 50);
}

async function handleMouseMoveDebounced(e: MouseEvent) {
    // Abort any previous lookup that might still be pending
    pendingLookupAborted = false;

    // Check if we're hovering over a tooltip FIRST, before any other logic
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const { isInside, popupLevel } = isInsideTooltip(target);

    // Verify the key is actually pressed by checking the event (needed for inside-tooltip checks)
    const scanKey = settings.store.scanKey;
    let keyActuallyPressed = false;

    switch (scanKey) {
        case "alt":
            keyActuallyPressed = e.altKey;
            break;
        case "ctrl":
            keyActuallyPressed = e.ctrlKey;
            break;
        case "shift":
            keyActuallyPressed = e.shiftKey;
            break;
    }

    // If we're hovering over a tooltip, handle it specially
    if (isInside) {
        // If scanning popup content is disabled, completely ignore mouse moves over tooltips
        if (!settings.store.scanPopupContent) {
            return; // Don't do anything, let tooltip stay visible
        }

        // Check if we've exceeded max nesting level
        if (popupLevel > settings.store.maxPopupNesting) {
            return; // Don't scan, but keep tooltip visible
        }

        // Prevent scanning main entry words (to avoid infinite loops)
        if (isMainEntryWord(target)) {
            return; // Don't scan, but keep tooltip visible
        }

        // If key is pressed and we're inside a tooltip, allow scanning to continue
        // This enables scanning text within tooltips
        if (!keyActuallyPressed) {
            // Key not pressed, just protect the tooltip from being hidden
            return;
        }
        // If we get here, key is pressed and we're inside a tooltip - continue with scanning
    }

    // Key state already checked above if we're inside a tooltip

    // Check if we have an active tooltip and are still near the original scan position
    // For nested tooltips, check position relative to their level
    const hasActiveTooltip = tooltips.size > 0;
    const currentLevel = isInside ? popupLevel - 1 : 0;
    const lastPosForLevel = lastTooltipPositionsByLevel.get(currentLevel) || lastTooltipPosition;
    const isNearLastPosition = lastPosForLevel &&
        Math.abs(e.clientX - lastPosForLevel.x) < 100 &&
        Math.abs(e.clientY - lastPosForLevel.y) < 100;

    // CRITICAL: If we're near where we showed the tooltip (but not inside it), protect it from being hidden
    // If we're inside the tooltip, we already handled that above and only continue if key is pressed
    if (hasActiveTooltip && isNearLastPosition && !isInside) {
        // Only continue if key is pressed - allow re-scanning nearby text
        if (keyActuallyPressed) {
            // Allow scanning if key is pressed and we're not inside tooltip
            // But we'll still protect against hiding below
            // (Logging removed - too verbose on mouse move)
        } else {
            // Key not pressed, just protect the tooltip from being hidden
            return;
        }
    }

    // Update our internal state to match reality
    if (!keyActuallyPressed && isKeyPressed) {
        // Key state is out of sync - reset it
        isKeyPressed = false;
        currentText = null;
        // Only hide tooltip if we're not hovering over it AND not near the position
        if (!isInside && !isNearLastPosition) {
            hideTooltip("key released");
            lastTooltipPosition = null;
        } else {
        }
    }

    // Only scan when key is actually pressed
    if (!keyActuallyPressed) {
        return; // Don't hide tooltip - let it stay visible
    }

    // Update internal state
    if (!isKeyPressed) {
        isKeyPressed = true;
    }

    // Get text candidates - progressively longer strings from cursor position
    // Use a larger radius when tooltip is visible to avoid issues
    const radius = isInside ? 25 : 15;
    const candidates = getTextCandidates(e.clientX, e.clientY, radius);

    if (!candidates || candidates.length === 0) {
        // Only hide tooltip if we're not inside a tooltip and not hovering over it
        // Also don't hide if we're still near the last tooltip position
        if (!isInside && !isNearLastPosition) {
            hideTooltip("no text candidates found");
            currentText = null;
            lastTooltipPosition = null;
            lastTooltipPositionsByLevel.delete(currentLevel);
        } else {
            // (Logging removed - too verbose)
        }
        return;
    }

    // Use the longest candidate as cache key
    const longestText = candidates[candidates.length - 1].text;

    // Debounce: if we're scanning the same text, don't re-process immediately
    // This prevents redundant searches when mouse moves slightly
    if (longestText === currentText) {
        // If we're inside a tooltip or near the last position, don't re-search
        if (isInside || isNearLastPosition) {
            return;
        }
        // For same text outside tooltip, allow re-search but with a small delay check
        // (the cache will handle this efficiently)
    }
    currentText = longestText;

    // Get position for tooltip
    const result = getTextAtPoint(e.clientX, e.clientY, radius);
    if (!result) {
        // If we can't get text position but we're inside a tooltip or near last position, don't hide it
        if (!isInside && !isNearLastPosition) {
            hideTooltip("no text position result");
            lastTooltipPosition = null;
            lastTooltipPositionsByLevel.delete(currentLevel);
        } else {
            // (Logging removed - too verbose)
        }
        return;
    }

    // Show loading indicator immediately
    const newPopupLevel = isInside ? popupLevel : 0;
    let tooltip = tooltips.get(newPopupLevel);
    if (!tooltip) {
        tooltip = createTooltip(newPopupLevel);
        tooltips.set(newPopupLevel, tooltip);
    }

    // Show loading state
    const loadingIndicator = createLoadingIndicator();
    showTooltip(
        result.rect.left,
        result.rect.bottom,
        loadingIndicator,
        newPopupLevel,
        undefined,
        [],
        undefined
    );

    // Store position for tooltip
    lastTooltipPosition = { x: e.clientX, y: e.clientY };
    lastTooltipPositionsByLevel.set(newPopupLevel, { x: e.clientX, y: e.clientY });

    // lookupTerm already does progressive shortening internally
    // Just call it once with the longest text
    // (Logging removed for performance - only log if no results found)
    const entries = await lookupTerm(longestText);

    // Check if this lookup was aborted (mouse moved to new position)
    if (pendingLookupAborted) {
        // Hide loading indicator if lookup was aborted
        if (tooltip && tooltip.container.querySelector('.yomicord-loading')) {
            hideTooltip("lookup aborted");
            lastTooltipPosition = null;
            lastTooltipPositionsByLevel.delete(newPopupLevel);
        }
        return;
    }

    if (entries.length === 0) {
        logger.info(`No results found for: "${longestText}"`);
    }

    if (entries.length > 0) {
        // Found a dictionary match!
        // Group entries by dictionary
        const entriesByDict = new Map<string, typeof entries>();
        for (const entry of entries) {
            const dictName = entry.dictionary || "Unknown";
            if (!entriesByDict.has(dictName)) {
                entriesByDict.set(dictName, []);
            }
            entriesByDict.get(dictName)!.push(entry);
        }

        const dictionaries = Array.from(entriesByDict.keys());
        const matchedTerm = entries[0].term;

        // Tooltip already exists from loading state
        // Reduced logging for performance - only log once per unique term
        if (!(tooltip.container as any)._lastMatchedTerm || (tooltip.container as any)._lastMatchedTerm !== matchedTerm) {
            logger.info(`Matched term: "${matchedTerm}", found dictionaries: ${dictionaries.join(", ")}, total entries: ${entries.length}`);

            // Log what each dictionary found
            for (const dictName of dictionaries) {
                const dictEntries = entriesByDict.get(dictName)!;
                const entryTerms = dictEntries.map(e => `${e.term}【${e.reading || ''}】`).join(", ");
                logger.info(`  Dictionary "${dictName}" found ${dictEntries.length} entries: ${entryTerms}`);
            }

            (tooltip.container as any)._lastMatchedTerm = matchedTerm;
        }

        // Store dictionary data on the tooltip container
        (tooltip.container as any)._dictData = {
            entriesByDict,
            dictionaries,
            matchedTerm,
            result,
            popupLevel: newPopupLevel,
            mouseX: e.clientX,
            mouseY: e.clientY
        };

        // Initial display - show first dictionary
        let currentDictName = dictionaries[0];
        let currentEntries = entriesByDict.get(currentDictName)!;
        (tooltip.container as any)._currentDict = currentDictName;

        const updateTooltip = (dictName: string) => {
            const data = (tooltip!.container as any)._dictData;
            const entries = data.entriesByDict.get(dictName);
            if (!entries) return;

            (tooltip!.container as any)._currentDict = dictName;
            const content = formatDictionaryResults(data.matchedTerm, entries);

            showTooltip(
                data.result.rect.left,
                data.result.rect.bottom,
                content,
                data.popupLevel,
                dictName,
                data.dictionaries,
                (newDictName: string) => {
                    updateTooltip(newDictName);
                }
            );
        };

        updateTooltip(currentDictName);
    } else {
        // No dictionary match - only hide if we're not inside a tooltip
        if (!isInside) {
            hideTooltip("no dictionary entries found");
            lastTooltipPosition = null;
            lastTooltipPositionsByLevel.delete(currentLevel);
        } else {
        }
    }
}

/**
 * Renders structured-content as DOM elements (similar to Yomitan's StructuredContentGenerator)
 * Handles elements with tag, content, style, href, etc.
 */
function renderStructuredContent(content: any): HTMLElement | null {
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
 * Normalizes a definition to either a string or DOM element, handling various Yomichan dictionary formats:
 * - Simple strings: "definition"
 * - Objects with text property: {text: "definition"}
 * - Structured content: {type: 'structured-content', content: {...}} -> returns HTMLElement
 * - Arrays: ["definition1", "definition2"]
 * - Nested structures: [["definition1"], ["definition2"]]
 */
function normalizeDefinition(def: any): string | HTMLElement {
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

/**
 * Extracts plain text from structured content as fallback
 */
function extractTextFromStructuredContent(content: any): string {
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

function createLoadingIndicator(): HTMLElement {
    const container = document.createElement("div");
    container.className = "yomicord-loading";
    container.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 8px 20px;
        min-height: 32px;
        width: fit-content;
    `;

    const spinnerWrapper = document.createElement("div");
    spinnerWrapper.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        transform: scale(0.7);
    `;

    // Render the Spinner component using React
    const spinnerElement = React.createElement(Spinner, { type: Spinner.Type.WANDERING_CUBES });
    const root = createRoot(spinnerWrapper);
    root.render(spinnerElement);

    // Store root reference for cleanup (on container so cleanup code can find it)
    (container as any)._reactRoot = root;

    container.appendChild(spinnerWrapper);

    return container;
}

function formatDictionaryResults(searchTerm: string, entries: any[]): HTMLElement {
    const container = document.createElement("div");

    // Sort all entries by score (frequency) - most common first
    // This ensures entries with the same term but different readings are sorted by popularity
    const sortedEntries = [...entries].sort((a: any, b: any) => (b.score || 0) - (a.score || 0));

    // For partial reading matches, show more results (up to 30)
    // For exact matches, use the user's setting (default 3)
    const isPartialMatch = entries.length > 10; // Heuristic: many results = likely partial match
    const maxDefs = isPartialMatch ? 30 : settings.store.maxDefinitions;
    const limitedEntries = sortedEntries.slice(0, maxDefs);

    // Display each entry separately (each term+reading combination gets its own entry)
    for (let i = 0; i < limitedEntries.length; i++) {
        const entry = limitedEntries[i];

        const entryDiv = document.createElement("div");
        entryDiv.style.cssText = i > 0 ? "margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--background-modifier-accent);" : "";

        // Term line
        const termLine = document.createElement("div");
        termLine.style.cssText = "margin-bottom: 4px;";

        const termSpan = document.createElement("span");
        termSpan.style.cssText = "font-weight: 600; font-size: 17px; color: #fff;";
        termSpan.setAttribute("data-yomicord-entry", "true");
        termSpan.textContent = entry.term;
        termLine.appendChild(termSpan);

        // Show reading for this specific entry
        if (settings.store.showReadings && entry.reading && entry.reading !== entry.term) {
            const readingSpan = document.createElement("span");
            readingSpan.style.cssText = "margin-left: 8px; color: var(--text-muted); font-size: 14px;";
            readingSpan.setAttribute("data-yomicord-entry", "true");
            readingSpan.textContent = `【${entry.reading}】`;
            termLine.appendChild(readingSpan);
        }

        entryDiv.appendChild(termLine);

        // Definitions for this specific entry
        // Normalize definitions to handle different dictionary formats
        const normalizedDefs = entry.definitions.map((def: any) => {
            return normalizeDefinition(def);
        });
        for (let j = 0; j < Math.min(normalizedDefs.length, 3); j++) {
            const defDiv = document.createElement("div");
            defDiv.style.cssText = "margin-left: 4px; margin-top: 2px; color: var(--text-muted);";
            defDiv.setAttribute("data-yomicord-definition", "true");

            const normalized = normalizedDefs[j];
            if (typeof normalized === "string") {
                // Plain text definition
                const displayText = `${j + 1}. ${normalized}`;
                defDiv.textContent = displayText;
            } else {
                // DOM element (structured content)
                const numberSpan = document.createElement("span");
                numberSpan.textContent = `${j + 1}. `;
                defDiv.appendChild(numberSpan);
                defDiv.appendChild(normalized);
            }
            entryDiv.appendChild(defDiv);
        }

        container.appendChild(entryDiv);
    }

    return container;
}

function handleKeyDown(e: KeyboardEvent) {
    const scanKey = settings.store.scanKey;

    if (checkKeyMatch(e, scanKey) && !isKeyPressed) {
        isKeyPressed = true;
    }
}

function handleKeyUp(e: KeyboardEvent) {
    const scanKey = settings.store.scanKey;

    if (checkKeyMatch(e, scanKey)) {
        isKeyPressed = false;
        // Abort any pending lookup when key is released
        pendingLookupAborted = true;
        // Don't hide tooltip - let it stay visible so user can scroll through results
        currentText = null;
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

function handleWindowBlur() {
    // When window loses focus (e.g., Alt+Tab), reset key state
    isKeyPressed = false;
    currentText = null;
    // Abort any pending lookup
    pendingLookupAborted = true;
    // Note: We don't hide tooltips on blur - let them stay visible
}

function handleWindowFocus() {
    // When window regains focus, verify key state is correct
    isKeyPressed = false;
    currentText = null;
}

function initialize() {
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("mousemove", handleMouseMove, true);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
}

function cleanup() {
    document.removeEventListener("keydown", handleKeyDown, true);
    document.removeEventListener("keyup", handleKeyUp, true);
    document.removeEventListener("mousemove", handleMouseMove, true);
    window.removeEventListener("blur", handleWindowBlur);
    window.removeEventListener("focus", handleWindowFocus);

    // Remove global click handler
    if (globalClickHandler) {
        document.removeEventListener("mousedown", globalClickHandler);
        globalClickHandler = null;
    }

    // Clear any pending mouse move timeout
    if (mouseMoveTimeout !== null) {
        clearTimeout(mouseMoveTimeout);
        mouseMoveTimeout = null;
    }

    // Abort any pending lookup
    pendingLookupAborted = true;

    // Remove all tooltips
    for (const { container } of tooltips.values()) {
        container.remove();
    }
    tooltips.clear();

    isKeyPressed = false;
    currentText = null;
}

export default definePlugin({
    name: "Yomicord",
    description: "Hover over Japanese text while holding Alt to see a tooltip (inspired by Yomichan)",
    authors: [Devs.chev],
    settings,

    start() {
        logger.info("Yomicord started");
        initialize();
    },

    stop() {
        logger.info("Yomicord stopped");
        cleanup();
    },
});

