/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Text scanning logic inspired by Yomichan
 */

const JAPANESE_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
const JAPANESE_PUNCTUATION = new Set([0x3001, 0x3002, 0x300C, 0x300D, 0x300E, 0x300F, 0xFF01, 0xFF1F]);

export interface TextCandidate {
    text: string;
    length: number;
}

export interface TextCandidatesResult {
    candidates: TextCandidate[];
    rect: DOMRect;
}

/**
 * Normalizes the offset to the start of the character the cursor is actually over
 * This fixes issues where cursor position within a character causes inconsistent offsets
 */
function normalizeOffsetToCharacterStart(textNode: Text, offset: number, x: number, y: number): number {
    const textContent = textNode.textContent || "";
    if (textContent.length === 0) return offset;

    const hasJapanese = JAPANESE_REGEX.test(textContent);
    if (!hasJapanese) return offset;

    // For Japanese text, find which character the cursor is actually over
    // by checking which character's bounding box contains the cursor position
    let bestOffset = offset;
    let minDistance = Infinity;

    // Check offsets around the cursor position (expanding range if needed)
    const searchRange = 3;
    for (let i = Math.max(0, offset - searchRange); i <= Math.min(textContent.length - 1, offset + searchRange); i++) {
        // Create a range for this character
        const testRange = document.createRange();
        testRange.setStart(textNode, i);
        testRange.setEnd(textNode, Math.min(i + 1, textContent.length));

        const rect = testRange.getBoundingClientRect();
        testRange.detach();

        // Check if cursor is within this character's bounding box
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            // Cursor is directly over this character
            return i;
        }

        // Calculate distance from cursor to this character's center
        const charCenterX = rect.left + rect.width / 2;
        const charCenterY = rect.top + rect.height / 2;
        const distance = Math.sqrt(Math.pow(x - charCenterX, 2) + Math.pow(y - charCenterY, 2));

        if (distance < minDistance) {
            minDistance = distance;
            bestOffset = i;
        }
    }

    return bestOffset;
}

function isJapaneseCharacter(code: number): boolean {
    return (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF) ||
        (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x31F0 && code <= 0x31FF);
}

function isJapanesePunctuation(code: number): boolean {
    return JAPANESE_PUNCTUATION.has(code);
}

/**
 * Gets multiple text candidates of different lengths for dictionary lookup
 * Returns progressively longer strings starting from the cursor position
 * This is used for finding the best dictionary match
 *
 * Like Yomitan's approach: extract text candidates without trying to detect
 * word boundaries. The dictionary will determine the actual word.
 *
 * Also returns the bounding rect to avoid redundant DOM lookups.
 */
export function getTextCandidates(x: number, y: number, maxLength: number = 20): TextCandidatesResult | null {
    const range = document.caretRangeFromPoint?.(x, y);
    if (!range) return null;

    const startNode = range.startContainer;
    if (startNode.nodeType !== Node.TEXT_NODE) return null;

    const textNode = startNode as Text;
    let offset = range.startOffset;
    const textContent = textNode.textContent || "";
    if (!JAPANESE_REGEX.test(textContent)) return null;

    // Normalize offset to the start of the character the cursor is actually over
    offset = normalizeOffsetToCharacterStart(textNode, offset, x, y);

    const start = offset;
    const candidates: TextCandidate[] = [];

    // Generate candidates of increasing length
    // Dictionary lookup tries longest matches first
    for (let len = 1; len <= maxLength; len++) {
        const end = Math.min(start + len, textContent.length);
        if (end <= start) break;

        const text = textContent.substring(start, end);
        const lastChar = text[text.length - 1];
        const code = lastChar.charCodeAt(0);

        // Stop if we hit punctuation
        if (isJapanesePunctuation(code)) {
            break;
        }

        // Stop at whitespace
        if (/\s/.test(lastChar)) {
            break;
        }

        // Stop if we hit non-Japanese alphanumeric (numbers, English words)
        if (/[a-zA-Z0-9]/.test(lastChar)) {
            break;
        }

        // Stop if we've left Japanese characters
        if (!isJapaneseCharacter(code)) {
            break;
        }

        // Add this candidate - no particle detection
        candidates.push({ text, length: len });
    }

    if (candidates.length === 0) return null;

    // Create a range for the longest candidate to get its position
    const longestCandidate = candidates[candidates.length - 1];
    const end = Math.min(start + longestCandidate.length, textContent.length);
    const textRange = document.createRange();
    textRange.setStart(textNode, start);
    textRange.setEnd(textNode, end);
    const rect = textRange.getBoundingClientRect();
    textRange.detach();

    return { candidates, rect };
}


