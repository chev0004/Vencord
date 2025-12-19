/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Japanese deinflection using Yomitan's actual transformer
 */

import { LanguageTransformer } from './language-transformer';
import { japaneseTransforms } from './japanese-transforms';

// Create and initialize the transformer
let transformer: LanguageTransformer | null = null;

function getTransformer(): LanguageTransformer {
    if (!transformer) {
        transformer = new LanguageTransformer();
        transformer.addDescriptor(japaneseTransforms);
    }
    return transformer;
}

/**
 * Generates deinflection candidates for a Japanese term
 * Uses Yomitan's actual transformation rules (1700+ lines of rules!)
 * Returns array of possible dictionary forms to search
 */
export function getDeinflectionCandidates(text: string): string[] {
    const candidates: string[] = [text]; // Always try the original text first

    try {
        const transformer = getTransformer();
        const results = transformer.transform(text);

        // Extract unique text forms from the results
        for (const result of results) {
            if (result.text !== text && !candidates.includes(result.text)) {
                candidates.push(result.text);
            }
        }
    } catch (error) {
        console.error('Deinflection error:', error);
        // Fall back to just returning the original text
    }

    return candidates;
}

