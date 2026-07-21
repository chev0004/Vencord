/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { japaneseTransforms,LanguageTransformer } from "./logic";

const DICTIONARY_KEY = "Yomicord_Dictionaries";
const DICTIONARY_INDEX_KEY = "Yomicord_Dictionary_Index";
const DICTIONARY_ORDER_KEY = "Yomicord_Dictionary_Order";
const DICTIONARY_PRIORITIES_KEY = "Yomicord_Dictionary_Priorities";

const KANJI_REGEX = /[一-鿿]/;

let transformer: LanguageTransformer | null = null;

function getTransformer(): LanguageTransformer {
    if (!transformer) {
        transformer = new LanguageTransformer();
        transformer.addDescriptor(japaneseTransforms);
    }
    return transformer;
}

function mergeConditions(a: number, b: number): number {
    return a === 0 || b === 0 ? 0 : a | b;
}

function getDeinflectionCandidates(text: string): Map<string, number> {
    const candidates = new Map<string, number>();
    for (const result of getTransformer().transform(text)) {
        if (result.text === text) continue;
        const existing = candidates.get(result.text);
        candidates.set(result.text, existing === undefined ? result.conditions : mergeConditions(existing, result.conditions));
    }
    return candidates;
}

function deinflectionMatchesEntry(conditions: number, entry: DictionaryEntry): boolean {
    if (entry.rules === undefined) return true;
    const entryFlags = getTransformer().getConditionFlagsFromPartsOfSpeech(entry.rules);
    return LanguageTransformer.conditionsMatch(conditions, entryFlags);
}

export interface DictionaryEntry {
    term: string;
    reading: string;
    definitions: string[];
    tags: string[];
    rules?: string[];
    score: number;
    dictionary?: string;
}

interface DictionaryMetadata {
    title: string;
    revision: string;
    sequenced: boolean;
}

interface DictionaryIndex {
    [dictionaryName: string]: DictionaryMetadata;
}

type BucketItem = DictionaryEntry | string;
type Bucket = { [key: string]: BucketItem[]; };

async function getDictionaryIndex(): Promise<DictionaryIndex> {
    return await DataStore.get(DICTIONARY_INDEX_KEY) || {};
}

export async function getDictionaryPriorities(): Promise<Record<string, number>> {
    const stored = await DataStore.get<Record<string, number>>(DICTIONARY_PRIORITIES_KEY);
    if (stored && Object.keys(stored).length > 0) return stored;
    const legacy = await DataStore.get<string[]>(DICTIONARY_ORDER_KEY);
    if (legacy && legacy.length > 0) {
        const migrated: Record<string, number> = {};
        for (let i = 0; i < legacy.length; i++) migrated[legacy[i]] = i;
        await setDictionaryPriorities(migrated);
        await DataStore.del(DICTIONARY_ORDER_KEY);
        return migrated;
    }
    return {};
}

async function setDictionaryPriorities(priorities: Record<string, number>): Promise<void> {
    await DataStore.set(DICTIONARY_PRIORITIES_KEY, priorities);
}

export async function updateDictionaryPriority(name: string, priority: number): Promise<void> {
    const priorities = await getDictionaryPriorities();
    priorities[name] = priority;
    await setDictionaryPriorities(priorities);
}

export function sortDictionariesByPriority(dictNames: string[], priorities: Record<string, number>): string[] {
    if (Object.keys(priorities).length === 0) return dictNames;
    const defaultValue = Math.max(0, ...Object.values(priorities)) + 1;
    return [...dictNames].sort((a, b) => (priorities[a] ?? defaultValue) - (priorities[b] ?? defaultValue));
}

const searchCache = new Map<string, { results: DictionaryEntry[]; timestamp: number; }>();
const CACHE_TTL = 5000;
const MAX_CACHE_SIZE = 100;

const dataStoreCache = new Map<string, { data: Bucket | undefined; timestamp: number; }>();
const DATASTORE_CACHE_TTL = 10000;

async function getBucket(dictionaryName: string, firstChar: string): Promise<Bucket | undefined> {
    const cacheKey = `${dictionaryName}_${firstChar}`;
    const cached = dataStoreCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < DATASTORE_CACHE_TTL) return cached.data;

    const data = await DataStore.get<Bucket>(`${DICTIONARY_KEY}_${dictionaryName}_${firstChar}`);
    dataStoreCache.set(cacheKey, { data, timestamp: Date.now() });
    if (dataStoreCache.size > 50) {
        const oldestKey = dataStoreCache.keys().next().value;
        if (oldestKey !== undefined) dataStoreCache.delete(oldestKey);
    }
    return data;
}

async function searchInDictionary(dictionaryName: string, term: string): Promise<DictionaryEntry[]> {
    if (term.length === 0) return [];
    const bucket = await getBucket(dictionaryName, term[0]);
    const items = bucket?.[term];
    if (!Array.isArray(items)) return [];

    const results: DictionaryEntry[] = [];
    const seen = new Set<string>();
    const add = (entry: DictionaryEntry) => {
        if (entry.term !== term && entry.reading !== term) return;
        const key = `${entry.term}|${entry.reading}`;
        if (!seen.has(key)) {
            seen.add(key);
            results.push(entry);
        }
    };

    for (const item of items) {
        if (typeof item === "string") {
            const refBucket = await getBucket(dictionaryName, item[0]);
            const refEntries = refBucket?.[item];
            if (!Array.isArray(refEntries)) continue;
            for (const refEntry of refEntries) {
                if (typeof refEntry !== "string") add(refEntry);
            }
        } else {
            add(item);
        }
    }

    return results;
}

async function findAllReadingsForTerm(dictionaryName: string, term: string): Promise<DictionaryEntry[]> {
    return (await searchInDictionary(dictionaryName, term)).filter(entry => entry.term === term);
}

export async function lookupTerm(text: string): Promise<DictionaryEntry[]> {
    const cached = searchCache.get(text);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results;

    const seen = new Set<string>();
    const kanjiTermsSearched = new Set<string>();
    const hasKanji = KANJI_REGEX.test(text);
    const dictNames = await getInstalledDictionaries();

    type ResultWithLength = {
        entry: DictionaryEntry;
        originalTextLength: number;
        fromDeinflection: boolean;
        readingExactMatch: boolean;
    };
    const resultsWithLength: ResultWithLength[] = [];
    let maxOriginalTextLength = 0;

    const addResult = (dictName: string, entry: DictionaryEntry, originalTextLength: number, fromDeinflection: boolean, readingExactMatch: boolean): boolean => {
        const key = `${dictName}|${entry.term}|${entry.reading}`;
        if (seen.has(key)) return false;
        seen.add(key);
        resultsWithLength.push({
            entry: { ...entry, dictionary: dictName },
            originalTextLength,
            fromDeinflection,
            readingExactMatch
        });
        maxOriginalTextLength = Math.max(maxOriginalTextLength, originalTextLength);
        return true;
    };

    const searchAllReadingsForTerm = async (kanjiTerm: string, originalTextLength: number) => {
        if (kanjiTermsSearched.has(kanjiTerm)) return;
        kanjiTermsSearched.add(kanjiTerm);
        await Promise.all(dictNames.map(async dictName => {
            for (const entry of await findAllReadingsForTerm(dictName, kanjiTerm)) {
                const readingExactMatch = !!entry.reading &&
                    entry.reading.length === originalTextLength &&
                    text.substring(0, originalTextLength) === entry.reading;
                addResult(dictName, entry, originalTextLength, false, readingExactMatch);
            }
        }));
    };

    await Promise.all(dictNames.map(dictName => getBucket(dictName, text[0])));

    for (let originalTextLength = text.length; originalTextLength > 0; originalTextLength--) {
        const searchText = text.substring(0, originalTextLength);
        const searchTextHiragana = convertKatakanaToHiragana(searchText);
        const variants = [searchText, searchTextHiragana];
        if (!isEmphaticChar(searchText[searchText.length - 1])) {
            variants.push(
                collapseEmphaticSequences(searchText),
                collapseEmphaticSequences(searchTextHiragana)
            );
        }
        const searchVariants = [...new Set(variants)].filter(v => v.length > 0);
        let foundAtThisLength = false;

        const exactResults = await Promise.all(searchVariants.flatMap(variant =>
            dictNames.map(async dictName => ({ dictName, variant, entries: await searchInDictionary(dictName, variant) }))
        ));

        for (const { dictName, variant, entries } of exactResults) {
            for (const entry of entries) {
                const matches = KANJI_REGEX.test(entry.term)
                    ? entry.term === variant || !!entry.reading?.startsWith(variant)
                    : entry.term.startsWith(variant);
                if (!matches) continue;

                const isExactMatch = searchVariants.includes(entry.term) ||
                    (!!entry.reading && searchVariants.includes(entry.reading));
                if (addResult(dictName, entry, originalTextLength, false, isExactMatch)) {
                    foundAtThisLength = true;
                    if (hasKanji && KANJI_REGEX.test(entry.term)) {
                        await searchAllReadingsForTerm(entry.term, originalTextLength);
                    }
                }
            }
        }

        const shouldSkipDeinflections = originalTextLength >= 4 && foundAtThisLength &&
            resultsWithLength.some(r => r.originalTextLength === originalTextLength && r.readingExactMatch && !r.fromDeinflection);

        if (!shouldSkipDeinflections) {
            const deinflections = new Map<string, number>();
            for (const variant of searchVariants) {
                for (const [deinflected, conditions] of getDeinflectionCandidates(variant)) {
                    const existing = deinflections.get(deinflected);
                    deinflections.set(deinflected, existing === undefined ? conditions : mergeConditions(existing, conditions));
                }
            }

            for (const [deinflected, conditions] of deinflections) {
                if (searchVariants.includes(deinflected)) continue;

                const deinflectResults = await Promise.all(dictNames.map(async dictName =>
                    ({ dictName, entries: await searchInDictionary(dictName, deinflected) })
                ));

                for (const { dictName, entries } of deinflectResults) {
                    for (const entry of entries) {
                        if (entry.term !== deinflected && entry.reading !== deinflected) continue;
                        if (!deinflectionMatchesEntry(conditions, entry)) continue;
                        if (addResult(dictName, entry, originalTextLength, true, entry.reading === deinflected)) {
                            foundAtThisLength = true;
                            if (hasKanji && KANJI_REGEX.test(entry.term)) {
                                await searchAllReadingsForTerm(entry.term, originalTextLength);
                            }
                        }
                    }
                }
            }
        }

        if (originalTextLength <= 2 && maxOriginalTextLength >= 3) break;
    }

    let results: DictionaryEntry[] = [];

    if (resultsWithLength.length > 0) {
        const exactLengths = new Set(resultsWithLength.filter(r => r.readingExactMatch).map(r => r.originalTextLength));
        let included: ResultWithLength[];
        if (exactLengths.size > 0) {
            included = resultsWithLength.filter(r => exactLengths.has(r.originalTextLength));
        } else {
            const maxLength = Math.max(...resultsWithLength.map(r => r.originalTextLength));
            included = resultsWithLength.filter(r => r.originalTextLength > 1 || maxLength === 1);
        }

        included.sort((a, b) => {
            if (a.readingExactMatch !== b.readingExactMatch) return a.readingExactMatch ? -1 : 1;
            if (a.originalTextLength !== b.originalTextLength) return b.originalTextLength - a.originalTextLength;

            const aHasReading = !!a.entry.reading && a.entry.reading !== a.entry.term;
            const bHasReading = !!b.entry.reading && b.entry.reading !== b.entry.term;
            if (aHasReading !== bHasReading) return aHasReading ? -1 : 1;

            if (a.fromDeinflection !== b.fromDeinflection) return a.fromDeinflection ? -1 : 1;

            if (a.entry.reading && a.entry.reading === b.entry.reading && a.entry.term.length !== b.entry.term.length) {
                return a.entry.term.length - b.entry.term.length;
            }

            const searchSubstring = text.substring(0, a.originalTextLength);
            const aReadingExact = a.entry.reading === searchSubstring;
            const bReadingExact = b.entry.reading === searchSubstring;
            if (aReadingExact !== bReadingExact) return aReadingExact ? -1 : 1;

            return (b.entry.score || 0) - (a.entry.score || 0);
        });

        results = included.map(r => r.entry);
    } else if (text.length >= 2) {
        for (const dictName of dictNames) {
            for (const entry of await searchByPartialReading(dictName, text)) {
                const key = `${dictName}|${entry.term}|${entry.reading}`;
                if (seen.has(key)) continue;
                const readingMatches = !!entry.reading &&
                    (entry.reading === text || entry.reading.startsWith(text) || text.startsWith(entry.reading));
                if (readingMatches) {
                    seen.add(key);
                    results.push({ ...entry, dictionary: dictName });
                }
            }
        }
        results.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    if (searchCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = searchCache.keys().next().value;
        if (oldestKey !== undefined) searchCache.delete(oldestKey);
    }
    searchCache.set(text, { results, timestamp: Date.now() });

    return results;
}

async function searchByPartialReading(dictionaryName: string, searchTerm: string, minMatchLength = 2): Promise<DictionaryEntry[]> {
    const searchReading = convertKatakanaToHiragana(searchTerm);
    if (searchReading.length < minMatchLength) return [];

    const bucket = await getBucket(dictionaryName, searchReading[0]);
    if (!bucket) return [];

    const results: Array<{ entry: DictionaryEntry; score: number; }> = [];
    const seen = new Set<string>();
    const addIfMatch = (entry: DictionaryEntry) => {
        const key = `${entry.term}|${entry.reading}`;
        if (seen.has(key)) return;
        const common = getCommonPrefix(searchReading, convertKatakanaToHiragana(entry.reading));
        if (common.length >= minMatchLength) {
            seen.add(key);
            results.push({ entry, score: common.length });
        }
    };

    for (const indexKey in bucket) {
        const items = bucket[indexKey];
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            if (typeof item === "string") {
                if (getCommonPrefix(searchReading, convertKatakanaToHiragana(indexKey)).length < minMatchLength) continue;
                const refBucket = await getBucket(dictionaryName, item[0]);
                const refEntries = refBucket?.[item];
                if (!Array.isArray(refEntries)) continue;
                for (const refEntry of refEntries) {
                    if (typeof refEntry !== "string" && refEntry.reading === indexKey) addIfMatch(refEntry);
                }
            } else {
                addIfMatch(item);
            }
        }
    }

    results.sort((a, b) => b.score - a.score);
    return results.map(r => r.entry);
}

function getCommonPrefix(str1: string, str2: string): string {
    let i = 0;
    while (i < str1.length && i < str2.length && str1[i] === str2[i]) i++;
    return str1.substring(0, i);
}

const isEmphaticChar = (char: string) => char === "っ" || char === "ッ" || char === "ー";

function collapseEmphaticSequences(text: string): string {
    let result = "";
    let prev = "";
    for (const char of text) {
        if (!(isEmphaticChar(char) && char === prev)) result += char;
        prev = char;
    }
    return result;
}

function convertKatakanaToHiragana(text: string): string {
    return text.replace(/[゠-ヿ]/g, char => {
        const code = char.charCodeAt(0);
        return code >= 0x30A1 && code <= 0x30F6 ? String.fromCharCode(code - 0x60) : char;
    });
}

export type ProgressCallback = (current: number, total: number, stage: string) => void;

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
        const index = await getDictionaryIndex();
        if (!index[dictionaryName]) {
            index[dictionaryName] = { title: dictionaryName, revision: "imported", sequenced: false };
            await DataStore.set(DICTIONARY_INDEX_KEY, index);
            const priorities = await getDictionaryPriorities();
            const maxPriority = Object.values(priorities).length > 0 ? Math.max(...Object.values(priorities)) : -1;
            priorities[dictionaryName] = maxPriority + 1;
            await setDictionaryPriorities(priorities);
        }

        await processTermBank(dictionaryName, termBank, onProgress);

        dataStoreCache.clear();
        searchCache.clear();
        onProgress?.(100, 100, "Complete!");
        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
}

export async function importMultipleDictionaryFiles(files: File[], dictionaryName: string, onProgress?: ProgressCallback): Promise<{ success: boolean; error?: string; imported: number; }> {
    let imported = 0;
    let lastError: string | undefined;

    for (let i = 0; i < files.length; i++) {
        const result = await importDictionaryJSON(files[i], dictionaryName, (current, total, stage) => {
            const overall = (i / files.length) * 100 + (current / total) * 100 / files.length;
            onProgress?.(Math.round(overall), 100, `File ${i + 1}/${files.length}: ${stage}`);
        });
        if (result.success) imported++;
        else lastError = result.error;
    }

    if (imported === 0) {
        return { success: false, error: lastError ?? "No files were imported successfully", imported: 0 };
    }
    return { success: true, imported };
}

const itemKey = (item: BucketItem) => typeof item === "string" ? item : `${item.term}|${item.reading}`;

async function processTermBank(dictionaryName: string, termBank: any[], onProgress?: ProgressCallback) {
    const totalEntries = termBank.length;
    const REPORT_INTERVAL = Math.max(1, Math.floor(totalEntries / 100));
    const grouped: Record<string, Record<string, BucketItem[]>> = {};

    onProgress?.(25, 100, "Processing entries...");

    for (let i = 0; i < termBank.length; i++) {
        if (i % REPORT_INTERVAL === 0 || i === totalEntries - 1) {
            onProgress?.(25 + Math.floor((i / totalEntries) * 50), 100, `Processing entries... (${i + 1}/${totalEntries})`);
        }

        const [term, reading, , rules, score, definitions, , termTags] = termBank[i];
        const dictEntry: DictionaryEntry = {
            term,
            reading: reading || term,
            definitions: Array.isArray(definitions) ? definitions : [definitions],
            tags: termTags || [],
            rules: typeof rules === "string" ? rules.split(" ").filter(Boolean) : [],
            score: score || 0
        };

        const termBucket = grouped[term[0]] ??= {};
        (termBucket[term] ??= []).push(dictEntry);

        if (reading && reading !== term) {
            const readingBucket = grouped[reading[0]] ??= {};
            const refs = readingBucket[reading] ??= [];
            if (!refs.includes(term)) refs.push(term);
        }
    }

    onProgress?.(75, 100, "Storing to database...");

    const firstChars = Object.keys(grouped);
    for (let i = 0; i < firstChars.length; i++) {
        const firstChar = firstChars[i];
        if (i % Math.max(1, Math.floor(firstChars.length / 10)) === 0 || i === firstChars.length - 1) {
            onProgress?.(75 + Math.floor((i / firstChars.length) * 20), 100, `Storing to database... (${i + 1}/${firstChars.length} groups)`);
        }

        const key = `${DICTIONARY_KEY}_${dictionaryName}_${firstChar}`;
        const merged: Bucket = { ...await DataStore.get<Bucket>(key) };

        for (const groupKey in grouped[firstChar]) {
            const existing = merged[groupKey];
            if (Array.isArray(existing)) {
                const seenItems = new Map(existing.map((item, idx) => [itemKey(item), idx]));
                for (const item of grouped[firstChar][groupKey]) {
                    const k = itemKey(item);
                    const idx = seenItems.get(k);
                    if (idx === undefined) {
                        seenItems.set(k, existing.length);
                        existing.push(item);
                    } else {
                        existing[idx] = item;
                    }
                }
            } else {
                merged[groupKey] = grouped[firstChar][groupKey];
            }
        }

        await DataStore.set(key, merged);
    }
}

export async function deleteDictionary(dictionaryName: string): Promise<void> {
    const index = await getDictionaryIndex();
    delete index[dictionaryName];
    await DataStore.set(DICTIONARY_INDEX_KEY, index);

    const priorities = await getDictionaryPriorities();
    if (dictionaryName in priorities) {
        delete priorities[dictionaryName];
        await setDictionaryPriorities(priorities);
    }

    const prefix = `${DICTIONARY_KEY}_${dictionaryName}_`;
    const allKeys = await DataStore.keys<string>();
    const keysToDelete = allKeys.filter(key => key.startsWith(prefix));
    if (keysToDelete.length > 0) {
        await DataStore.delMany(keysToDelete);
    }

    dataStoreCache.clear();
    searchCache.clear();
}

export async function getInstalledDictionaries(): Promise<string[]> {
    const index = await getDictionaryIndex();
    const priorities = await getDictionaryPriorities();
    return sortDictionariesByPriority(Object.keys(index), priorities);
}

export async function cleanupOrphanedDictionaryKeys(): Promise<number> {
    const index = await getDictionaryIndex();
    const installed = new Set(Object.keys(index));
    const prefix = `${DICTIONARY_KEY}_`;
    const allKeys = await DataStore.keys<string>();

    const orphaned = allKeys.filter(key => {
        if (!key.startsWith(prefix)) return false;
        const afterPrefix = key.substring(prefix.length);
        const sep = afterPrefix.lastIndexOf("_");
        return sep !== -1 && !installed.has(afterPrefix.substring(0, sep));
    });

    if (orphaned.length > 0) {
        await DataStore.delMany(orphaned);
    }
    return orphaned.length;
}
