/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Text scanning logic inspired by Yomichan
 */

export interface TextRange {
    text: string;
    rect: DOMRect;
}

export interface TextCandidate {
    text: string;
    length: number;
}

/**
 * Normalizes the offset to the start of the character the cursor is actually over
 * This fixes issues where cursor position within a character causes inconsistent offsets
 */
function normalizeOffsetToCharacterStart(textNode: Text, offset: number, x: number, y: number): number {
    const textContent = textNode.textContent || "";
    if (textContent.length === 0) return offset;

    // Check if we're dealing with Japanese text (full-width characters)
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(textContent);
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

/**
 * Gets text at a specific point in the document
 * For Japanese text, extracts from cursor position forward to get word candidates
 */
export function getTextAtPoint(x: number, y: number, maxLength: number = 100): TextRange | null {
    // Get the range at the point
    const range = document.caretRangeFromPoint?.(x, y);
    if (!range) return null;

    const startNode = range.startContainer;
    if (startNode.nodeType !== Node.TEXT_NODE) {
        // Try to get text from element's textContent
        if (startNode.nodeType === Node.ELEMENT_NODE) {
            const element = startNode as Element;
            const text = element.textContent?.trim();
            if (text && text.length > 0) {
                const rect = element.getBoundingClientRect();
                return {
                    text: text.substring(0, maxLength),
                    rect
                };
            }
        }
        return null;
    }

    const textNode = startNode as Text;
    let offset = range.startOffset;
    const textContent = textNode.textContent || "";

    // Check if we're dealing with Japanese text
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(textContent);

    if (hasJapanese) {
        // Normalize offset to the start of the character the cursor is actually over
        offset = normalizeOffsetToCharacterStart(textNode, offset, x, y);
        // For Japanese: extract from cursor forward, up to maxLength characters
        // This is how dictionary lookup works - we try progressively longer strings
        return extractJapaneseText(textNode, offset, textContent, maxLength);
    } else {
        // For non-Japanese: extract the word at cursor
        return extractWordAtCursor(textNode, offset, textContent);
    }
}

/**
 * Extracts Japanese text starting from the cursor position
 * Extracts forward from cursor, up to maxLength characters
 * Stops ONLY at clear boundaries: punctuation, whitespace, non-Japanese text
 *
 * Like Yomitan's DOMTextScanner: just extract text, don't try to detect word boundaries.
 * Word boundary detection requires a dictionary and is done during the lookup phase.
 */
function extractJapaneseText(textNode: Text, offset: number, textContent: string, maxLength: number): TextRange | null {
    const start = offset;
    let end = offset;

    // Start from cursor position and go forward
    // Extract Japanese characters until we hit a clear boundary
    while (end < textContent.length && end - start < maxLength) {
        const char = textContent[end];
        const code = char.charCodeAt(0);

        // Stop at Japanese punctuation (clear sentence boundaries)
        if (isJapanesePunctuation(code)) {
            break;
        }

        // Stop at whitespace
        if (/\s/.test(char)) {
            break;
        }

        // Stop at English/Latin characters or numbers (clear word boundary)
        if (/[a-zA-Z0-9]/.test(char)) {
            break;
        }

        // Stop if we've left Japanese characters
        if (!isJapaneseCharacter(code)) {
            break;
        }

        // No particle or suffix detection - just extract the characters
        // The dictionary will determine actual word boundaries
        end++;
    }

    // Make sure we got at least one character
    if (end === start) {
        end = Math.min(start + 1, textContent.length);
    }

    const text = textContent.substring(start, end);

    if (text.length === 0) return null;

    // Create a range for the extracted text to get its position
    const textRange = document.createRange();
    textRange.setStart(textNode, start);
    textRange.setEnd(textNode, end);

    const rect = textRange.getBoundingClientRect();
    textRange.detach();

    return { text, rect };
}

/**
 * Extracts a word at the cursor position for non-Japanese text
 */
function extractWordAtCursor(textNode: Text, offset: number, textContent: string): TextRange | null {
    let start = offset;
    let end = offset;

    // Expand forward to word boundary
    while (end < textContent.length) {
        const char = textContent[end];
        if (/[\s.,!?;:()\[\]{}]/.test(char)) {
            break;
        }
        end++;
    }

    // Expand backward to word boundary
    while (start > 0) {
        const char = textContent[start - 1];
        if (/[\s.,!?;:()\[\]{}]/.test(char)) {
            break;
        }
        start--;
    }

    const text = textContent.substring(start, end).trim();

    if (text.length === 0) return null;

    // Create a range for the extracted text
    const textRange = document.createRange();
    textRange.setStart(textNode, start);
    textRange.setEnd(textNode, end);

    const rect = textRange.getBoundingClientRect();
    textRange.detach();

    return { text, rect };
}

/**
 * Checks if a character code is Japanese
 */
function isJapaneseCharacter(code: number): boolean {
    // Hiragana: 0x3040-0x309F
    // Katakana: 0x30A0-0x30FF
    // CJK Unified Ideographs: 0x4E00-0x9FFF
    // Katakana Phonetic Extensions: 0x31F0-0x31FF
    return (
        (code >= 0x3040 && code <= 0x309F) ||  // Hiragana
        (code >= 0x30A0 && code <= 0x30FF) ||  // Katakana
        (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Ideographs
        (code >= 0x31F0 && code <= 0x31FF)     // Katakana Extensions
    );
}

/**
 * Checks if a character is Japanese punctuation
 */
function isJapanesePunctuation(code: number): boolean {
    // Common Japanese punctuation
    const japanesePunctuation = [
        0x3001, // 、 (comma)
        0x3002, // 。 (period)
        0x300C, // 「 (left quote)
        0x300D, // 」 (right quote)
        0x300E, // 『 (left double quote)
        0x300F, // 』 (right double quote)
        0xFF01, // ！ (exclamation)
        0xFF1F, // ？ (question)
    ];

    return japanesePunctuation.includes(code);
}

/**
 * Gets multiple text candidates of different lengths for dictionary lookup
 * Returns progressively longer strings starting from the cursor position
 * This is used for finding the best dictionary match
 *
 * Like Yomitan's approach: extract text candidates without trying to detect
 * word boundaries. The dictionary will determine the actual word.
 */
export function getTextCandidates(x: number, y: number, maxLength: number = 20): TextCandidate[] | null {
    const range = document.caretRangeFromPoint?.(x, y);
    if (!range) return null;

    const startNode = range.startContainer;
    if (startNode.nodeType !== Node.TEXT_NODE) return null;

    const textNode = startNode as Text;
    let offset = range.startOffset;
    const textContent = textNode.textContent || "";

    // Check if we're dealing with Japanese text
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(textContent);
    if (!hasJapanese) return null;

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

    return candidates.length > 0 ? candidates : null;
}

/**
 * Expands a selection to include more context for better scanning
 */
export function getExpandedTextAtPoint(x: number, y: number): TextRange | null {
    const range = document.caretRangeFromPoint?.(x, y);
    if (!range) return null;

    const startNode = range.startContainer;
    if (startNode.nodeType !== Node.TEXT_NODE) return null;

    const textNode = startNode as Text;

    // Get the entire text node content for better context
    const text = textNode.textContent || "";
    const offset = range.startOffset;

    // For Japanese text, we want to get a larger window
    let windowSize = 200;

    // Check if this looks like Japanese text
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text);
    if (hasJapanese) {
        windowSize = 400; // Larger window for Japanese
    }

    const start = Math.max(0, offset - windowSize / 2);
    const end = Math.min(text.length, offset + windowSize / 2);

    const extractedText = text.substring(start, end).trim();

    if (extractedText.length === 0) return null;

    // Get bounding rect for the text
    const textRange = document.createRange();
    textRange.setStart(textNode, start);
    textRange.setEnd(textNode, Math.min(end, textNode.length));

    const rect = textRange.getBoundingClientRect();
    textRange.detach();

    return { text: extractedText, rect };
}

