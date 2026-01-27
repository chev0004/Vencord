/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Dictionary management for Japanese lookups
 * Compatible with Yomichan dictionary format
 */

import * as DataStore from "@api/DataStore";

import { LanguageTransformer, japaneseTransforms } from "./logic";

const DICTIONARY_KEY = "Yomicord_Dictionaries";
const DICTIONARY_INDEX_KEY = "Yomicord_Dictionary_Index";

// Singleton transformer instance for deinflection
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
function getDeinflectionCandidates(text: string): string[] {
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

export interface DictionaryEntry {
    term: string;           // The word itself (e.g., "食べる")
    reading: string;        // Reading in hiragana (e.g., "たべる")
    definitions: string[];  // Array of definitions
    tags: string[];         // Tags like "v1" for verb type
    score: number;          // Frequency/priority score
    dictionary?: string;     // Dictionary name this entry came from
}

export interface DictionaryMetadata {
    title: string;
    revision: string;
    sequenced: boolean;
}

interface DictionaryIndex {
    [dictionaryName: string]: DictionaryMetadata;
}

/**
 * Loads all dictionaries from storage
 */
export async function getDictionaryIndex(): Promise<DictionaryIndex> {
    const index = await DataStore.get(DICTIONARY_INDEX_KEY);
    return index || {};
}

// Cache for recent search results to avoid redundant lookups
const searchCache = new Map<string, { results: DictionaryEntry[], timestamp: number }>();
const CACHE_TTL = 5000; // 5 seconds cache
const MAX_CACHE_SIZE = 100;

/**
 * Searches for a term in all loaded dictionaries
 * Tries: exact match → deinflected forms → partial reading match
 * For kanji terms, also finds all entries with the same term but different readings
 */
export async function lookupTerm(text: string): Promise<DictionaryEntry[]> {
    const startTime = performance.now();
    cacheHits = 0;
    cacheMisses = 0;
    console.log(`[Dictionary] Scanned text: "${text}"`);

    // Check cache first
    const cacheKey = text;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`[Dictionary] Using cached results for "${text}"`);
        return cached.results;
    }

    const results: DictionaryEntry[] = [];
    const seen = new Set<string>(); // Track entries we've already added: "term|reading"
    const kanjiTermsSearched = new Set<string>(); // Track kanji terms we've already searched for all readings

    const indexStartTime = performance.now();
    const index = await getDictionaryIndex();
    console.log(`[Dictionary] ⏱️  getDictionaryIndex took ${(performance.now() - indexStartTime).toFixed(2)}ms`);

    // Check if text contains kanji
    const hasKanji = /[\u4E00-\u9FFF]/.test(text);

    // Helper function to search for all readings of a kanji term
    // Also adds them to resultsWithLength so they get properly sorted and prioritized
    const searchAllReadingsForTerm = async (kanjiTerm: string, originalTextLength: number) => {
        if (kanjiTermsSearched.has(kanjiTerm)) return; // Already searched
        kanjiTermsSearched.add(kanjiTerm);

        for (const dictName in index) {
            const allReadings = await findAllReadingsForTerm(dictName, kanjiTerm);
            for (const entry of allReadings) {
                // Include dictionary name in key to allow same term/reading from different dictionaries
                const key = `${dictName}|${entry.term}|${entry.reading}`;
                if (!seen.has(key)) {
                    // Add to resultsWithLength so it gets properly sorted and filtered
                    // Results array will be rebuilt from filtered resultsWithLength later
                    // Check if reading exactly matches (for entries found via searchAllReadingsForTerm)
                    const readingExactMatch = entry.reading && entry.reading.length === originalTextLength &&
                        text.substring(0, originalTextLength) === entry.reading;
                    resultsWithLength.push({
                        entry: { ...entry, dictionary: dictName },
                        originalTextLength,
                        fromDeinflection: false,
                        readingExactMatch: readingExactMatch || false
                    });
                    seen.add(key);
                    maxOriginalTextLength = Math.max(maxOriginalTextLength, originalTextLength);
                }
            }
        }
    };

    // Yomitan-style lookup: Try progressively shorter substrings, deinflect each, prioritize by originalTextLength
    // This matches Yomitan's exact behavior: _getAlgorithmDeinflections tries progressively shorter strings
    const dictNames = Object.keys(index);

    // Track results with their originalTextLength to prioritize longer matches
    type ResultWithLength = {
        entry: DictionaryEntry;
        originalTextLength: number;
        fromDeinflection: boolean;
        readingExactMatch: boolean; // True if reading exactly equals the search substring
    };
    const resultsWithLength: ResultWithLength[] = [];
    let maxOriginalTextLength = 0;

    // Pre-fetch all DataStore keys we'll need in parallel for the first character
    // This warms up the cache and reduces latency
    const prefetchStartTime = performance.now();
    const firstChar = text[0];
    const prefetchPromises = dictNames.map(dictName => getDataStoreData(dictName, firstChar));
    await Promise.all(prefetchPromises);
    const prefetchTime = performance.now() - prefetchStartTime;
    if (prefetchTime > 10) {
        console.log(`[Dictionary] ⏱️  Pre-fetched ${dictNames.length} dictionaries for first char "${firstChar}" in ${prefetchTime.toFixed(2)}ms`);
    }

    // Try progressively shorter substrings (like Yomitan's _getNextSubstring loop)
    // Search all substrings to find matches at all lengths (like Yomitan does)
    const substringLoopStartTime = performance.now();
    for (let originalTextLength = text.length; originalTextLength > 0; originalTextLength--) {
        const substringStartTime = performance.now();
        const searchText = text.substring(0, originalTextLength);
        let foundAtThisLength = false;

        console.log(`[Dictionary] Trying substring (length ${originalTextLength}): "${searchText}"`);

        // YOMITAN BEHAVIOR: Convert katakana to hiragana BEFORE searching/deinflecting
        // This is what Yomitan does via text preprocessors (convertHiraganaToKatakana with inverse mode)
        const searchTextHiragana = convertKatakanaToHiragana(searchText);
        const searchVariants = searchText !== searchTextHiragana
            ? [searchText, searchTextHiragana]  // Try both katakana and hiragana
            : [searchText];  // Already hiragana or no conversion needed

        // 1. Try exact match first (for both katakana and hiragana variants)
        // Use 'exact' matching since we know the exact term we're searching for
        const exactSearchStartTime = performance.now();
        const exactPromises = searchVariants.flatMap(variant =>
            dictNames.map(async (dictName) => {
                const queryStartTime = performance.now();
                const entries = await searchInDictionary(dictName, variant, 'exact');
                const queryTime = performance.now() - queryStartTime;
                if (queryTime > 10) {
                    console.log(`[Dictionary] ⏱️  searchInDictionary("${dictName}", "${variant}") took ${queryTime.toFixed(2)}ms, found ${entries.length} entries`);
                }
                return { dictName, entries, variant };
            })
        );
        const exactResults = await Promise.all(exactPromises);
        const exactSearchTime = performance.now() - exactSearchStartTime;
        if (exactSearchTime > 10) {
            console.log(`[Dictionary] ⏱️  Exact search for "${searchText}" took ${exactSearchTime.toFixed(2)}ms (${searchVariants.length} variants × ${dictNames.length} dicts)`);
        }

        const exactMatches: string[] = [];

        for (const { dictName, entries, variant } of exactResults) {
            for (const entry of entries) {
                // For kanji terms, check both term and reading
                // Match if term equals variant OR reading equals/starts with variant
                // Progressive shortening handles finding "赤" when searching "赤月"
                if (/[\u4E00-\u9FFF]/.test(entry.term)) {
                    const termMatches = entry.term === variant;
                    const readingMatches = entry.reading && (entry.reading === variant || entry.reading.startsWith(variant));

                    if (termMatches || readingMatches) {
                        // Include dictionary name in key to allow same term/reading from different dictionaries
                        // Different dictionaries may have different definitions for the same term
                        const key = `${dictName}|${entry.term}|${entry.reading}`;
                        if (!seen.has(key)) {
                            // Check if reading exactly matches the search substring (use original searchText for exact match check)
                            // BUT: if the term exactly matches, prioritize it as an exact match (e.g., "ぶりっ子【ぶりっこ】")
                            const readingExactMatch = !!(entry.reading && (entry.reading === searchText || entry.reading === searchTextHiragana));
                            const termExactMatch = !!(entry.term === searchText || entry.term === searchTextHiragana);
                            // Treat as exact match if either term OR reading matches exactly
                            const isExactMatch = termExactMatch || readingExactMatch;
                            const matchInfo = `${entry.term}【${entry.reading || ''}】 (${dictName}, from variant "${variant}", exact=${isExactMatch})`;
                            exactMatches.push(matchInfo);
                            resultsWithLength.push({
                                entry: { ...entry, dictionary: dictName },
                                originalTextLength,
                                fromDeinflection: false,
                                readingExactMatch: isExactMatch // Use termExactMatch OR readingExactMatch
                            });
                            seen.add(key);
                            maxOriginalTextLength = Math.max(maxOriginalTextLength, originalTextLength);
                            foundAtThisLength = true;
                            if (hasKanji) {
                                await searchAllReadingsForTerm(entry.term, originalTextLength);
                            }
                        }
                    }
                } else {
                    // For kana-only terms, require exact match or entry starts with variant and is at least as long
                    if (entry.term === variant || (entry.term.startsWith(variant) && entry.term.length >= variant.length)) {
                        // Include dictionary name in key to allow same term/reading from different dictionaries
                        const key = `${dictName}|${entry.term}|${entry.reading}`;
                        if (!seen.has(key)) {
                            // Check if reading exactly matches the search substring (use original searchText for exact match check)
                            // BUT: if the term exactly matches, prioritize it as an exact match
                            const readingExactMatch = !!(entry.reading && (entry.reading === searchText || entry.reading === searchTextHiragana));
                            const termExactMatch = !!(entry.term === searchText || entry.term === searchTextHiragana);
                            // Treat as exact match if either term OR reading matches exactly
                            const isExactMatch = termExactMatch || readingExactMatch;
                            const matchInfo = `${entry.term}【${entry.reading || ''}】 (${dictName}, from variant "${variant}", exact=${isExactMatch})`;
                            exactMatches.push(matchInfo);
                            resultsWithLength.push({
                                entry: { ...entry, dictionary: dictName },
                                originalTextLength,
                                fromDeinflection: false,
                                readingExactMatch: isExactMatch // Use termExactMatch OR readingExactMatch
                            });
                            seen.add(key);
                            maxOriginalTextLength = Math.max(maxOriginalTextLength, originalTextLength);
                            foundAtThisLength = true;
                        }
                    }
                }
            }
        }

        if (exactMatches.length > 0) {
            console.log(`[Dictionary] Exact matches for "${searchText}":`, exactMatches);
        }

        // EARLY TERMINATION CHECK #1: Only skip deinflections if we have exact matches
        // But don't stop the loop - we want to search all substrings like Yomitan does
        // This allows us to show results from all lengths (お早うございます, お早う, おはよ, おは, お)
        // Only skip deinflections to save time when we already have perfect direct matches
        let shouldSkipDeinflections = false;
        if (originalTextLength >= 4 && foundAtThisLength) {
            const exactDirectMatches = resultsWithLength.filter(r =>
                r.originalTextLength === originalTextLength &&
                r.readingExactMatch &&
                !r.fromDeinflection
            );

            if (exactDirectMatches.length > 0) {
                // Skip deinflections at this length to save time, but continue searching shorter substrings
                shouldSkipDeinflections = true;
                console.log(`[Dictionary] Skipping deinflections at length ${originalTextLength} - found ${exactDirectMatches.length} exact direct match(es)`);
            }
        }

        // 2. Try deinflected forms for this substring (skip if we have perfect direct matches)
        // YOMITAN BEHAVIOR: Deinflect BOTH katakana and hiragana variants
        // This ensures "ゲロ" → "げろ" → deinflect → finds "げろ"
        if (shouldSkipDeinflections) {
            console.log(`[Dictionary] Skipping deinflections for "${searchText}" - already have perfect matches`);
        } else {
        const allDeinflections = new Set<string>();
        for (const variant of searchVariants) {
            const deinflections = getDeinflectionCandidates(variant);
            for (const deinflected of deinflections) {
                allDeinflections.add(deinflected);
            }
        }
        const deinflections = Array.from(allDeinflections);
        const deinflectMatches: string[] = [];
        if (deinflections.length > 1 || (deinflections.length === 1 && !searchVariants.includes(deinflections[0]))) {
            console.log(`[Dictionary] Deinflection candidates for "${searchText}" (variants: ${searchVariants.join(', ')}):`, deinflections);
        }
        for (const deinflected of deinflections) {
            if (searchVariants.includes(deinflected)) continue; // Skip if same as original variants

            // Search all dictionaries in parallel
            // Use 'exact' matching for deinflected forms since we know the exact term
            const deinflectSearchStartTime = performance.now();
            const deinflectPromises = dictNames.map(async (dictName) => {
                const queryStartTime = performance.now();
                const entries = await searchInDictionary(dictName, deinflected, 'exact');
                const queryTime = performance.now() - queryStartTime;
                if (queryTime > 10) {
                    console.log(`[Dictionary] ⏱️  searchInDictionary("${dictName}", "${deinflected}") took ${queryTime.toFixed(2)}ms, found ${entries.length} entries`);
                }
                return { dictName, entries };
            });
            const deinflectResults = await Promise.all(deinflectPromises);
            const deinflectSearchTime = performance.now() - deinflectSearchStartTime;
            if (deinflectSearchTime > 10) {
                console.log(`[Dictionary] ⏱️  Deinflection search for "${deinflected}" took ${deinflectSearchTime.toFixed(2)}ms (${dictNames.length} dicts)`);
            }

            for (const { dictName, entries } of deinflectResults) {
                for (const entry of entries) {
                    // Match by either term OR reading
                    const termMatches = entry.term === deinflected;
                    const readingMatches = entry.reading && entry.reading === deinflected;

                    if (!termMatches && !readingMatches) {
                        continue;
                    }

                    // Include dictionary name in key to allow same term/reading from different dictionaries
                    const key = `${dictName}|${entry.term}|${entry.reading}`;
                    if (!seen.has(key)) {
                        // Check if reading exactly matches the deinflected form
                        const readingExactMatch = entry.reading && entry.reading === deinflected;
                        const matchInfo = `${entry.term}【${entry.reading || ''}】 (${dictName}, from deinflection "${deinflected}", exact=${readingExactMatch})`;
                        deinflectMatches.push(matchInfo);
                        resultsWithLength.push({
                            entry: { ...entry, dictionary: dictName },
                            originalTextLength,
                            fromDeinflection: true,
                            readingExactMatch: readingExactMatch || false
                        });
                        seen.add(key);
                        maxOriginalTextLength = Math.max(maxOriginalTextLength, originalTextLength);
                        foundAtThisLength = true;

                        // If this entry has a kanji term and the deinflected form matches the reading,
                        // search for ALL readings of this kanji term
                        if (hasKanji && /[\u4E00-\u9FFF]/.test(entry.term) &&
                            (entry.term === deinflected || entry.reading === deinflected)) {
                            await searchAllReadingsForTerm(entry.term, originalTextLength);
                        }
                    }
                }
            }
        }

        if (deinflectMatches.length > 0) {
            console.log(`[Dictionary] Deinflection matches for "${searchText}":`, deinflectMatches);
        }
        } // End of deinflection block (only executed if not skipped)

        // EARLY TERMINATION: Only stop if we're at very short lengths (1-2 chars) and already have good matches
        // This prevents processing thousands of single-char entries when we have better matches
        // But we still want to search all reasonable substrings to show all results like Yomitan
        if (originalTextLength <= 2 && maxOriginalTextLength >= 3) {
            console.log(`[Dictionary] *** EARLY TERMINATION *** Skipping very short substring (length ${originalTextLength}) - already have matches at length ${maxOriginalTextLength}`);
            break;
        }

        const substringTime = performance.now() - substringStartTime;
        if (substringTime > 50) {
            console.log(`[Dictionary] ⏱️  Substring length ${originalTextLength} took ${substringTime.toFixed(2)}ms`);
        }
    }
    const substringLoopTime = performance.now() - substringLoopStartTime;
    console.log(`[Dictionary] ⏱️  Substring loop took ${substringLoopTime.toFixed(2)}ms`);
    console.log(`[Dictionary] ⏱️  Cache stats: ${cacheHits} hits, ${cacheMisses} misses (${((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(1)}% hit rate)`);

    // CRITICAL: Prioritize exact reading matches, then by originalTextLength
    // This prevents "家持【いえもち】" from appearing when "家【いえ】" exists (exact match)
    // Yomitan prioritizes exact matches over prefix matches
    const filteringStartTime = performance.now();
    console.log(`[Dictionary] Total results found: ${resultsWithLength.length}`);
    if (resultsWithLength.length > 0) {
        // First, check if we have any exact reading matches
        const exactReadingMatches = resultsWithLength.filter(r => r.readingExactMatch);
        console.log(`[Dictionary] Exact reading matches: ${exactReadingMatches.length}`);

        if (exactReadingMatches.length > 0) {
            // We have exact matches - prioritize these
            // YOMITAN BEHAVIOR:
            // 1. Prefer direct matches over deinflected matches when they're at similar lengths
            // 2. But prefer longer originalTextLength when deinflected matches are from the full text
            // This ensures:
            // - "げろ【げろ】" (direct, length 2) wins over "下郎【げろう】" (deinflected, length 3) for "ゲロい"
            // - "思う【おもう】" (deinflected, length 4) wins over "面【おも】" (direct, length 2) for "おもった"

            // First, separate direct and deinflected matches
            const directExactMatches = exactReadingMatches.filter(r => !r.fromDeinflection);
            const deinflectedExactMatches = exactReadingMatches.filter(r => r.fromDeinflection);

            // Find max lengths
            const maxDirectLength = directExactMatches.length > 0
                ? Math.max(...directExactMatches.map(r => r.originalTextLength))
                : 0;
            const maxDeinflectLength = deinflectedExactMatches.length > 0
                ? Math.max(...deinflectedExactMatches.map(r => r.originalTextLength))
                : 0;

            // YOMITAN BEHAVIOR: Show results from ALL lengths, not just the longest
            // This allows showing: お早うございます (length 8), お早う (length 4), おはよ (length 3), おは (length 2), お (length 1)
            // Group results by length and include all lengths that have exact matches
            const lengthsWithExactMatches = new Set<number>();
            exactReadingMatches.forEach(r => lengthsWithExactMatches.add(r.originalTextLength));

            // Include all results from lengths that have exact matches
            // This mimics Yomitan's behavior of showing all substring matches
            const allExactMatchLengths = Array.from(lengthsWithExactMatches).sort((a, b) => b - a); // Sort descending

            for (const length of allExactMatchLengths) {
                const matchesAtLength = resultsWithLength.filter(r => r.originalTextLength === length);
                // Prioritize exact reading matches, but include all matches at this length
                const exactAtLength = matchesAtLength.filter(r => r.readingExactMatch);
                const inexactAtLength = matchesAtLength.filter(r => !r.readingExactMatch);

                // Add exact matches first, then inexact ones
                results.push(...exactAtLength.map(r => r.entry));
                results.push(...inexactAtLength.map(r => r.entry));
            }

            console.log(`[Dictionary] Included results from ${allExactMatchLengths.length} different lengths:`, allExactMatchLengths);
        } else {
            // No exact reading matches, use prefix matches
            // YOMITAN BEHAVIOR: Show results from multiple lengths if they're meaningful
            // Group by length and include results from all reasonable lengths
            const allLengths = new Set<number>();
            resultsWithLength.forEach(r => allLengths.add(r.originalTextLength));
            const sortedLengths = Array.from(allLengths).sort((a, b) => b - a); // Sort descending

            // Filter out single-char matches if we have multi-char matches (unless single char is the only match)
            const meaningfulLengths = sortedLengths.filter(len => {
                if (len === 1 && sortedLengths.length > 1 && sortedLengths[0] > 1) {
                    return false; // Skip single char if we have longer matches
                }
                return true;
            });

            // Include results from all meaningful lengths
            for (const length of meaningfulLengths) {
                const matchesAtLength = resultsWithLength.filter(r => r.originalTextLength === length);
                results.push(...matchesAtLength.map(r => r.entry));
            }

            console.log(`[Dictionary] Included prefix matches from ${meaningfulLengths.length} different lengths:`, meaningfulLengths);
        }

        // Sort by: 1) full word matches (has reading), 2) exact length match, 3) score (frequency)
        // This prioritizes actual words over kanji-only dictionary entries
        // Also track which results came from deinflection to prioritize them
        const resultsWithInfo = results.map(entry => {
            // Find the originalTextLength for this entry
            const resultInfo = resultsWithLength.find(r => r.entry.term === entry.term && r.entry.reading === entry.reading);
            return {
                entry,
                originalTextLength: resultInfo?.originalTextLength || 0,
                fromDeinflection: resultInfo?.fromDeinflection || false,
                readingExactMatch: resultInfo?.readingExactMatch || false
            };
        });

        resultsWithInfo.sort((a, b) => {
            // Prioritize entries with exact reading matches (already filtered above, but sort within)
            if (a.readingExactMatch && !b.readingExactMatch) return -1;
            if (!a.readingExactMatch && b.readingExactMatch) return 1;

            // Then prioritize entries from longer originalTextLength (better matches)
            if (a.originalTextLength !== b.originalTextLength) {
                return b.originalTextLength - a.originalTextLength;
            }

            // Prioritize entries that have a reading (actual words) over kanji-only entries
            const aHasReading = a.entry.reading && a.entry.reading !== a.entry.term;
            const bHasReading = b.entry.reading && b.entry.reading !== b.entry.term;
            if (aHasReading && !bHasReading) return -1;
            if (!aHasReading && bHasReading) return 1;

            // Prioritize entries from deinflection (verbs/nouns/adjectives) over exact matches
            // This helps "たしかに" → "確か" and "分かってた" → "分かる"
            if (a.fromDeinflection && !b.fromDeinflection) return -1;
            if (!a.fromDeinflection && b.fromDeinflection) return 1;

            // Prioritize shorter terms when readings match - "家" over "家持ち", "ゲロ" over "ゲラ刷り"
            if (a.entry.reading && b.entry.reading && a.entry.reading === b.entry.reading) {
                if (a.entry.term.length !== b.entry.term.length) {
                    return a.entry.term.length - b.entry.term.length;
                }
            }

            // Then prioritize entries where reading exactly matches the search substring
            const searchSubstring = text.substring(0, a.originalTextLength);
            const aReadingExact = a.entry.reading && a.entry.reading === searchSubstring;
            const bReadingExact = b.entry.reading && b.entry.reading === searchSubstring;
            if (aReadingExact && !bReadingExact) return -1;
            if (!aReadingExact && bReadingExact) return 1;

            // Finally sort by score (frequency) - higher score = more common
            return (b.entry.score || 0) - (a.entry.score || 0);
        });

        // Extract just the entries
        results.length = 0;
        results.push(...resultsWithInfo.map(r => r.entry));

        console.log(`[Dictionary] Final sorted results for "${text}":`, results.map(r => `${r.term}【${r.reading || ''}】`));
        const filteringTime = performance.now() - filteringStartTime;
        console.log(`[Dictionary] ⏱️  Filtering and sorting took ${filteringTime.toFixed(2)}ms`);

        // Only return results if we found meaningful matches (not filtered out single-char matches)
        if (results.length > 0) {
            const totalTime = performance.now() - startTime;
            console.log(`[Dictionary] ⏱️  TOTAL lookup time: ${totalTime.toFixed(2)}ms`);
            return results;
        }
        // If we filtered out single-char matches and have no results, fall through to partial reading match
    }

    // 4. Final fallback: try partial reading match (for katakana words not in dictionary)
    // This is what finds "綿糸" (めんし) when searching "メンション"
    // Also finds "論" (ろん) when searching "ろん" if exact match didn't work
    if (results.length === 0 && text.length >= 2) {
        console.log(`[Dictionary] Trying partial reading match for "${text}"`);
        for (const dictName in index) {
            const partialMatches = await searchByPartialReading(dictName, text);
            console.log(`[Dictionary] Partial reading matches from ${dictName}: ${partialMatches.length}`);
            for (const entry of partialMatches) {
                // Include dictionary name in key to allow same term/reading from different dictionaries
                const key = `${dictName}|${entry.term}|${entry.reading}`;
                if (!seen.has(key)) {
                    // For kana-only search text, prefer entries where reading matches exactly or starts with search text
                    // This ensures "ろん" finds "論" (ろん) not just entries that happen to share a prefix
                    const readingMatches = entry.reading && (
                        entry.reading === text ||
                        entry.reading.startsWith(text) ||
                        text.startsWith(entry.reading)
                    );

                    // Only add if reading matches well (exact or prefix match)
                    // This filters out unrelated entries that just happen to share a character
                    if (readingMatches) {
                        results.push({ ...entry, dictionary: dictName });
                        seen.add(key);

                        // If this entry has a kanji term and reading matches search text, search for ALL readings
                        if (hasKanji && /[\u4E00-\u9FFF]/.test(entry.term) && readingMatches) {
                            await searchAllReadingsForTerm(entry.term, text.length);
                        }
                    }
                }
            }
        }
    }

    // Sort by score (frequency) - higher score = more common
    results.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Cache the results
    if (searchCache.size >= MAX_CACHE_SIZE) {
        // Remove oldest entry
        const oldestKey = searchCache.keys().next().value;
        searchCache.delete(oldestKey);
    }
    searchCache.set(cacheKey, { results, timestamp: Date.now() });

    const totalTime = performance.now() - startTime;
    if (results.length === 0) {
        console.log(`[Dictionary] No results found for "${text}"`);
    } else {
        console.log(`[Dictionary] Final results for "${text}" (${results.length} entries):`, results.map(r => `${r.term}【${r.reading || ''}】`));
    }
    console.log(`[Dictionary] ⏱️  TOTAL lookup time: ${totalTime.toFixed(2)}ms`);

    return results;
}

/**
 * Finds all entries that have the same term (kanji) but potentially different readings
 * This allows finding all readings for a kanji word like 昨日 (さくじつ, きのう, etc.)
 * Since entries are stored in arrays indexed by term, we just need to search the primary bucket
 */
async function findAllReadingsForTerm(dictionaryName: string, term: string): Promise<DictionaryEntry[]> {
    // Entries with the same term are stored in the same array, indexed by the first character
    // Use exact matching for better performance - we want the exact term, not prefix matches
    const entries = await searchInDictionary(dictionaryName, term, 'exact');

    // Filter to only entries that match the term exactly (should already be all of them with exact matching)
    return entries.filter(entry => entry.term === term);
}

/**
 * Searches for a term in a specific dictionary
 * Uses prefix matching like Yomitan: finds entries where term OR reading starts with the search text
 *
 * Since entries are indexed by first character, we need to search ALL buckets when doing prefix matching
 * on readings, because an entry with reading "あか" is indexed under "あ", not "赤"
 */
// Cache for DataStore.get() results to avoid redundant fetches
// Key: dictionary name + first character, Value: data object
const dataStoreCache = new Map<string, { data: any, timestamp: number }>();
const DATASTORE_CACHE_TTL = 10000; // 10 seconds cache for DataStore results

let cacheHits = 0;
let cacheMisses = 0;

async function getDataStoreData(dictionaryName: string, firstChar: string): Promise<any> {
    const cacheKey = `${dictionaryName}_${firstChar}`;
    const cached = dataStoreCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < DATASTORE_CACHE_TTL) {
        cacheHits++;
        return cached.data; // Cache hit - return immediately (no DataStore call needed)
    }
    cacheMisses++;

    const dataKey = `${DICTIONARY_KEY}_${dictionaryName}_${firstChar}`;
    const dataKeyStartTime = performance.now();
    const data = await DataStore.get(dataKey);
    const dataKeyTime = performance.now() - dataKeyStartTime;
    if (dataKeyTime > 10) {
        console.log(`[Dictionary] ⏱️  DataStore.get("${dataKey}") took ${dataKeyTime.toFixed(2)}ms (cache miss)`);
    }

    // Cache the result
    dataStoreCache.set(cacheKey, { data, timestamp: Date.now() });

    // Limit cache size
    if (dataStoreCache.size > 50) {
        // Remove oldest entry
        const oldestKey = dataStoreCache.keys().next().value;
        dataStoreCache.delete(oldestKey);
    }

    return data;
}

export async function searchInDictionary(dictionaryName: string, term: string, matchType: 'exact' | 'prefix' = 'prefix'): Promise<DictionaryEntry[]> {
    const queryStartTime = performance.now();
    const results: DictionaryEntry[] = [];
    const seen = new Set<string>(); // Track entries by "term|reading" to avoid duplicates

    if (term.length === 0) return results;

    // For exact matching, we can directly access the term if it exists in the index
    // This is much faster than iterating through all entries
    if (matchType === 'exact') {
        // Use cached DataStore.get() to avoid redundant fetches
        const data = await getDataStoreData(dictionaryName, term[0]);

        if (data) {
            // The data object contains both term and reading indexes
            // Terms are stored keyed by term, readings are stored keyed by reading
            // Since we're searching for "term", check if it exists as either a term key or reading key
            // Both could be in the same bucket if they start with the same character

            // Check if search term exists as a term key
            if (data[term]) {
                const entries = data[term] as DictionaryEntry[];
                if (Array.isArray(entries)) {
                    for (const entry of entries) {
                        // Match if term OR reading equals the search term
                        const termMatches = entry.term === term;
                        const readingMatches = entry.reading && entry.reading === term;

                        if (termMatches || readingMatches) {
                            const key = `${entry.term}|${entry.reading}`;
                            if (!seen.has(key)) {
                                results.push(entry);
                                seen.add(key);
                            }
                        }
                    }
                }
            }
        }

        const queryTime = performance.now() - queryStartTime;
        if (queryTime > 20) {
            console.log(`[Dictionary] ⏱️  searchInDictionary("${dictionaryName}", "${term}", exact) took ${queryTime.toFixed(2)}ms, found ${results.length} entries`);
        }

        return results;
    }

    // For prefix matching, search through all entries (original behavior)
    // Search by first character of term (expression index)
    // This finds entries where the TERM or READING starts with the search text
    // Combined into a single loop to avoid iterating the same data twice
    const termData = await getDataStoreData(dictionaryName, term[0]);

    if (termData) {
        // Single loop that checks both term and reading matches
        for (const indexKey in termData) {
            const entries = termData[indexKey] as DictionaryEntry[];
            if (!Array.isArray(entries)) continue;

            for (const entry of entries) {
                if (!entry || typeof entry.term !== 'string') continue;

                const key = `${entry.term}|${entry.reading}`;
                let shouldAdd = false;

                // Check if term matches (prefix matching)
                // Progressive shortening in lookupTerm handles finding substrings
                if (entry.term.startsWith(term)) {
                    shouldAdd = true;
                }

                // Check if reading matches (prefix matching)
                if (!shouldAdd && entry.reading && typeof entry.reading === 'string') {
                    // For prefix matching: entry reading must start with search text
                    // Progressive shortening in lookupTerm handles finding substrings
                    if (entry.reading.startsWith(term)) {
                        shouldAdd = true;
                    }
                }

                if (shouldAdd && !seen.has(key)) {
                    results.push(entry);
                    seen.add(key);
                }
            }
        }
    }

    return results;
}

/**
 * Searches for entries with readings that partially match the search term
 * Used as a fallback when exact matches fail
 *
 * Finds entries where the reading shares a common prefix with the search term
 * Example: "メンション" (めんしょん) → finds "綿糸" (めんし) because they share "めんし"
 */
export async function searchByPartialReading(dictionaryName: string, searchTerm: string, minMatchLength: number = 2): Promise<DictionaryEntry[]> {
    const results: Array<{ entry: DictionaryEntry, score: number; }> = [];
    const seen = new Set<string>(); // Track entries we've already added

    // Convert katakana to hiragana for comparison
    const searchReading = convertKatakanaToHiragana(searchTerm);

    // Only search if we have enough characters
    if (searchReading.length < minMatchLength) return [];

    // Try progressively shorter prefixes of the search term
    // This ensures we find "めんし" when searching "めんしょん"
    // DON'T stop early - collect ALL matching entries from ALL prefix lengths
    for (let prefixLength = searchReading.length; prefixLength >= minMatchLength; prefixLength--) {
        const prefix = searchReading.substring(0, prefixLength);

        // Get all entries indexed by the first character of this prefix
        // Use cached getDataStoreData to avoid redundant fetches
        const data = await getDataStoreData(dictionaryName, prefix[0]);

        if (!data) continue;

        // Search through all entries for partial reading matches
        for (const indexKey in data) {
            const entries = data[indexKey] as DictionaryEntry[];
            for (const entry of entries) {
                // Create unique key to avoid duplicates
                const entryKey = `${entry.term}|${entry.reading}`;
                if (seen.has(entryKey)) continue;

                const entryReading = convertKatakanaToHiragana(entry.reading);

                // Check if they share a meaningful prefix
                const commonPrefix = getCommonPrefix(prefix, entryReading);
                if (commonPrefix.length >= minMatchLength) {
                    // Found a match - add it with a score (longer prefix = higher score)
                    // This helps us sort by relevance later
                    const score = commonPrefix.length * 1000 + prefixLength; // Longer matches first
                    results.push({ entry, score });
                    seen.add(entryKey);
                }
            }
        }
    }

    // Sort by score (longer common prefix = more relevant)
    results.sort((a, b) => b.score - a.score);

    // Return just the entries
    return results.map(r => r.entry);
}

/**
 * Gets the longest common prefix between two strings
 */
function getCommonPrefix(str1: string, str2: string): string {
    let i = 0;
    while (i < str1.length && i < str2.length && str1[i] === str2[i]) {
        i++;
    }
    return str1.substring(0, i);
}

/**
 * Converts katakana to hiragana for reading comparison
 */
function convertKatakanaToHiragana(text: string): string {
    return text.replace(/[\u30A0-\u30FF]/g, (char) => {
        const code = char.charCodeAt(0);
        // Katakana range: 0x30A0-0x30FF
        // Hiragana range: 0x3040-0x309F
        // Offset: 0x60
        if (code >= 0x30A1 && code <= 0x30F6) {
            return String.fromCharCode(code - 0x60);
        }
        return char;
    });
}

/**
 * Progress callback type for dictionary import
 */
export type ProgressCallback = (current: number, total: number, stage: string) => void;

/**
 * Imports a dictionary from JSON file(s)
 * Supports: term_bank_N.json files from extracted Yomichan dictionaries
 */
export async function importDictionaryJSON(file: File, dictionaryName: string, onProgress?: ProgressCallback): Promise<{ success: boolean; error?: string; }> {
    try {
        onProgress?.(0, 100, "Reading file...");
        const text = await file.text();

        onProgress?.(10, 100, "Parsing JSON...");
        const termBank = JSON.parse(text);

        if (!Array.isArray(termBank)) {
            return { success: false, error: "Invalid format: expected array of terms" };
        }

        onProgress?.(20, 100, "Updating dictionary index...");
        // Add to dictionary index if not exists
        const index = await getDictionaryIndex();
        if (!index[dictionaryName]) {
            index[dictionaryName] = {
                title: dictionaryName,
                revision: "imported",
                sequenced: false
            };
            await DataStore.set(DICTIONARY_INDEX_KEY, index);
        }

        // Process and store the term bank
        await processTermBank(dictionaryName, termBank, onProgress);

        onProgress?.(100, 100, "Complete!");
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error"
        };
    }
}

/**
 * Imports multiple dictionary files at once
 */
export async function importMultipleDictionaryFiles(files: File[], dictionaryName: string, onProgress?: ProgressCallback): Promise<{ success: boolean; error?: string; imported: number; }> {
    let imported = 0;
    const totalFiles = files.length;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileProgress = (current: number, total: number, stage: string) => {
            // Calculate overall progress across all files
            const fileProgressPercent = (current / total) * 100;
            const overallProgress = ((i / totalFiles) * 100) + (fileProgressPercent / totalFiles);
            onProgress?.(Math.round(overallProgress), 100, `File ${i + 1}/${totalFiles}: ${stage}`);
        };

        const result = await importDictionaryJSON(file, dictionaryName, fileProgress);
        if (result.success) {
            imported++;
        }
    }

    if (imported === 0) {
        return { success: false, error: "No files were imported successfully", imported: 0 };
    }

    return { success: true, imported };
}

/**
 * Processes a term bank and stores entries indexed by first character
 * Indexes by BOTH term and reading for comprehensive lookups
 */
async function processTermBank(dictionaryName: string, termBank: any[], onProgress?: ProgressCallback) {
    const totalEntries = termBank.length;
    const REPORT_INTERVAL = Math.max(1, Math.floor(totalEntries / 100)); // Report progress every ~1%

    // Group terms by first character for efficient lookup
    const grouped: { [firstChar: string]: { [term: string]: DictionaryEntry[]; }; } = {};

    onProgress?.(25, 100, "Processing entries...");
    console.log(`[Yomicord] Processing ${totalEntries} dictionary entries...`);

    for (let i = 0; i < termBank.length; i++) {
        const entry = termBank[i];

        // Report progress periodically
        if (i % REPORT_INTERVAL === 0 || i === termBank.length - 1) {
            const progress = 25 + Math.floor((i / totalEntries) * 50); // 25-75% range
            onProgress?.(progress, 100, `Processing entries... (${i + 1}/${totalEntries})`);
            console.log(`[Yomicord] Progress: ${i + 1}/${totalEntries} entries processed (${Math.round((i / totalEntries) * 100)}%)`);
        }

        // Yomichan format: [term, reading, definitionTags, ruleIdentifiers, score, definitions, sequence, termTags]
        const [term, reading, defTags, rules, score, definitions, sequence, termTags] = entry;

        const dictEntry: DictionaryEntry = {
            term,
            reading: reading || term,
            definitions: Array.isArray(definitions) ? definitions : [definitions],
            tags: termTags || [],
            score: score || 0
        };

        // Index by term (e.g., "御早" or "おはよう")
        const termFirstChar = term[0];
        if (!grouped[termFirstChar]) {
            grouped[termFirstChar] = {};
        }
        if (!grouped[termFirstChar][term]) {
            grouped[termFirstChar][term] = [];
        }
        grouped[termFirstChar][term].push(dictEntry);

        // ALSO index by reading if different from term
        // This allows searching "おはよう" to find "御早"
        if (reading && reading !== term) {
            const readingFirstChar = reading[0];
            if (!grouped[readingFirstChar]) {
                grouped[readingFirstChar] = {};
            }
            if (!grouped[readingFirstChar][reading]) {
                grouped[readingFirstChar][reading] = [];
            }
            grouped[readingFirstChar][reading].push(dictEntry);
        }
    }

    console.log(`[Yomicord] Finished processing entries. Storing to database...`);
    onProgress?.(75, 100, "Storing to database...");

    // Store each group
    const firstChars = Object.keys(grouped);
    for (let i = 0; i < firstChars.length; i++) {
        const firstChar = firstChars[i];
        const key = `${DICTIONARY_KEY}_${dictionaryName}_${firstChar}`;

        // Report progress for storage
        if (i % Math.max(1, Math.floor(firstChars.length / 10)) === 0 || i === firstChars.length - 1) {
            const progress = 75 + Math.floor((i / firstChars.length) * 20); // 75-95% range
            onProgress?.(progress, 100, `Storing to database... (${i + 1}/${firstChars.length} groups)`);
        }

        // Merge with existing data if any
        const existing = await DataStore.get(key) || {};
        const merged: { [term: string]: DictionaryEntry[]; } = { ...existing };

        // Properly merge arrays for terms that exist in both
        for (const term in grouped[firstChar]) {
            if (merged[term] && Array.isArray(merged[term])) {
                // Merge arrays: combine existing entries with new ones
                const existingEntries = merged[term] as DictionaryEntry[];
                const newEntries = grouped[firstChar][term] as DictionaryEntry[];

                // Create a Set to track unique entries (term|reading pairs)
                const seen = new Set<string>();
                const combined: DictionaryEntry[] = [];

                // Add existing entries
                for (const entry of existingEntries) {
                    const entryKey = `${entry.term}|${entry.reading}`;
                    if (!seen.has(entryKey)) {
                        seen.add(entryKey);
                        combined.push(entry);
                    }
                }

                // Add new entries
                for (const entry of newEntries) {
                    const entryKey = `${entry.term}|${entry.reading}`;
                    if (!seen.has(entryKey)) {
                        seen.add(entryKey);
                        combined.push(entry);
                    }
                }

                merged[term] = combined;
            } else {
                // New term, just assign it
                merged[term] = grouped[firstChar][term];
            }
        }

        await DataStore.set(key, merged);
    }

    console.log(`[Yomicord] Dictionary import complete!`);
}

/**
 * Deletes a dictionary
 */
export async function deleteDictionary(dictionaryName: string): Promise<void> {
    // Remove from index
    const index = await getDictionaryIndex();
    delete index[dictionaryName];
    await DataStore.set(DICTIONARY_INDEX_KEY, index);

    // Delete all stored data for this dictionary
    // Keys are in format: Yomicord_Dictionaries_${dictionaryName}_${firstChar}
    const prefix = `${DICTIONARY_KEY}_${dictionaryName}_`;
    const allKeys = await DataStore.keys<string>();
    const keysToDelete = allKeys.filter(key => key.startsWith(prefix));

    if (keysToDelete.length > 0) {
        await DataStore.delMany(keysToDelete);
        console.log(`[Yomicord] Deleted ${keysToDelete.length} data keys for dictionary "${dictionaryName}"`);
    }
}

/**
 * Gets list of installed dictionaries
 */
export async function getInstalledDictionaries(): Promise<string[]> {
    const index = await getDictionaryIndex();
    return Object.keys(index);
}

/**
 * Finds all orphaned dictionary keys (keys that don't match any dictionary in the index)
 * Useful for cleaning up data from deleted dictionaries
 */
export async function findOrphanedDictionaryKeys(): Promise<string[]> {
    const index = await getDictionaryIndex();
    const installedDictNames = new Set(Object.keys(index));
    const allKeys = await DataStore.keys<string>();
    const prefix = `${DICTIONARY_KEY}_`;

    // Find all dictionary-related keys
    const dictKeys = allKeys.filter(key => key.startsWith(prefix));

    // Find keys that don't belong to any installed dictionary
    const orphaned: string[] = [];
    for (const key of dictKeys) {
        // Extract dictionary name from key: Yomicord_Dictionaries_${dictName}_${firstChar}
        const afterPrefix = key.substring(prefix.length);
        const underscoreIndex = afterPrefix.indexOf('_');
        if (underscoreIndex === -1) continue;

        const dictName = afterPrefix.substring(0, underscoreIndex);
        if (!installedDictNames.has(dictName)) {
            orphaned.push(key);
        }
    }

    return orphaned;
}

/**
 * Cleans up all orphaned dictionary keys
 * Returns the number of keys deleted
 */
export async function cleanupOrphanedDictionaryKeys(): Promise<number> {
    const orphaned = await findOrphanedDictionaryKeys();
    if (orphaned.length > 0) {
        await DataStore.delMany(orphaned);
        console.log(`[Yomicord] Cleaned up ${orphaned.length} orphaned dictionary keys`);
    }
    return orphaned.length;
}


