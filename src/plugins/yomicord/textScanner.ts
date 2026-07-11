/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const JAPANESE_REGEX = /[぀-ゟ゠-ヿ一-鿿]/;

export interface ScannedText {
    text: string;
    rect: DOMRect;
}

function isJapaneseCharacter(code: number): boolean {
    return (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF) ||
        (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x31F0 && code <= 0x31FF);
}

function normalizeOffsetToCharacterStart(textNode: Text, offset: number, x: number, y: number): number {
    const textContent = textNode.textContent || "";
    if (textContent.length === 0) return offset;

    let bestOffset = offset;
    let minDistance = Infinity;

    for (let i = Math.max(0, offset - 3); i <= Math.min(textContent.length - 1, offset + 3); i++) {
        const testRange = document.createRange();
        testRange.setStart(textNode, i);
        testRange.setEnd(textNode, Math.min(i + 1, textContent.length));
        const rect = testRange.getBoundingClientRect();

        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return i;

        const distance = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
        if (distance < minDistance) {
            minDistance = distance;
            bestOffset = i;
        }
    }

    return bestOffset;
}

export function getTextAtPoint(x: number, y: number, maxLength = 20): ScannedText | null {
    const range = document.caretRangeFromPoint?.(x, y);
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

    const textNode = range.startContainer as Text;
    const textContent = textNode.textContent || "";
    if (!JAPANESE_REGEX.test(textContent)) return null;

    const start = normalizeOffsetToCharacterStart(textNode, range.startOffset, x, y);
    let end = start;
    while (end < textContent.length && end - start < maxLength && isJapaneseCharacter(textContent.charCodeAt(end))) {
        end++;
    }
    if (end === start) return null;

    const textRange = document.createRange();
    textRange.setStart(textNode, start);
    textRange.setEnd(textNode, end);
    const rect = textRange.getBoundingClientRect();

    return { text: textContent.substring(start, end), rect };
}
