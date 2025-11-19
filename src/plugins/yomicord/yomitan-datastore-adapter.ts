/*
 * Adapter to make Yomitan's DictionaryDatabase work with Vencord DataStore
 * Instead of IndexedDB, we use DataStore
 */

import * as DataStore from "@api/DataStore";

const DICTIONARY_KEY = "Yomicord_Dictionaries";

/**
 * Adapts Yomitan's dictionary database interface to use DataStore
 * Implements the same methods that Translator expects
 */
export class DataStoreDictionaryAdapter {
    /**
     * Find terms using prefix/exact/suffix matching
     * Mimics dictionary-database.js findTermsBulk
     */
    async findTermsBulk(termList: string[], dictionaries: Set<string>, matchType: 'exact' | 'prefix' | 'suffix'): Promise<any[]> {
        const results: any[] = [];
        const visited = new Set<number>();

        for (const term of termList) {
            const termResults = await this._findTerms(term, dictionaries, matchType);
            for (const entry of termResults) {
                // Generate a unique ID for deduplication
                const id = this._generateId(entry.term, entry.reading);
                if (!visited.has(id)) {
                    visited.add(id);
                    results.push({
                        ...entry,
                        index: termList.indexOf(term),
                        id
                    });
                }
            }
        }

        return results;
    }

    /**
     * Find a single term
     */
    async _findTerms(term: string, dictionaries: Set<string>, matchType: 'exact' | 'prefix' | 'suffix'): Promise<any[]> {
        const results: any[] = [];

        for (const dictName of dictionaries) {
            const entries = await this._searchDictionary(dictName, term, matchType);
            for (const entry of entries) {
                results.push({
                    dictionary: dictName,
                    expression: entry.term,
                    reading: entry.reading,
                    rules: entry.tags || [],
                    definitions: entry.definitions || [],
                    score: entry.score || 0
                });
            }
        }

        return results;
    }

    /**
     * Search a specific dictionary
     */
    async _searchDictionary(dictName: string, term: string, matchType: 'exact' | 'prefix' | 'suffix'): Promise<any[]> {
        const results: any[] = [];
        const seen = new Set<string>();

        if (term.length === 0) return results;

        // Search by term (expression index)
        const termKey = `${DICTIONARY_KEY}_${dictName}_${term[0]}`;
        const termData = await DataStore.get(termKey);

        if (termData) {
            for (const indexKey in termData) {
                const entries = termData[indexKey] as any[];
                for (const entry of entries) {
                    let termMatches = false;
                    if (matchType === 'exact') {
                        termMatches = entry.term === term;
                    } else if (matchType === 'prefix') {
                        termMatches = entry.term.startsWith(term);
                    } else if (matchType === 'suffix') {
                        termMatches = entry.term.endsWith(term);
                    }

                    if (termMatches) {
                        const key = `${entry.term}|${entry.reading}`;
                        if (!seen.has(key)) {
                            results.push(entry);
                            seen.add(key);
                        }
                    }
                }
            }
        }

        // Search by reading
        const readingFirstChar = term[0];
        const readingKey = `${DICTIONARY_KEY}_${dictName}_${readingFirstChar}`;
        const readingData = await DataStore.get(readingKey);

        if (readingData) {
            for (const indexKey in readingData) {
                const entries = readingData[indexKey] as any[];
                for (const entry of entries) {
                    if (!entry.reading) continue;

                    let readingMatches = false;
                    if (matchType === 'exact') {
                        readingMatches = entry.reading === term;
                    } else if (matchType === 'prefix') {
                        readingMatches = entry.reading.startsWith(term);
                    } else if (matchType === 'suffix') {
                        readingMatches = entry.reading.endsWith(term);
                    }

                    if (readingMatches) {
                        const key = `${entry.term}|${entry.reading}`;
                        if (!seen.has(key)) {
                            results.push(entry);
                            seen.add(key);
                        }
                    }
                }
            }
        }

        return results;
    }

    /**
     * Generate a unique ID for an entry
     */
    _generateId(term: string, reading: string): number {
        // Simple hash function
        const str = `${term}|${reading}`;
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }

    /**
     * Find exact terms (for sequence matching)
     */
    async findTermsExactBulk(termList: any[], dictionaries: Set<string>): Promise<any[]> {
        const results: any[] = [];

        for (const item of termList) {
            const { term, reading } = item;
            for (const dictName of dictionaries) {
                const entries = await this._searchDictionaryExact(dictName, term, reading);
                results.push(...entries.map(entry => ({
                    ...entry,
                    index: termList.indexOf(item),
                    dictionary: dictName
                })));
            }
        }

        return results;
    }

    async _searchDictionaryExact(dictName: string, term: string, reading: string): Promise<any[]> {
        const termKey = `${DICTIONARY_KEY}_${dictName}_${term[0]}`;
        const data = await DataStore.get(termKey);

        if (!data || !data[term]) return [];

        const entries = data[term] as any[];
        return entries.filter(entry => entry.reading === reading);
    }

    /**
     * Find terms by sequence (for sequenced dictionaries)
     */
    async findTermsBySequenceBulk(items: any[]): Promise<any[]> {
        // Simplified - just search by term
        const results: any[] = [];
        for (const item of items) {
            const { dictionary, query } = item;
            const dictSet = new Set([dictionary]);
            const entries = await this._searchDictionary(dictionary, query, 'exact');
            results.push(...entries.map(entry => ({
                ...entry,
                index: items.indexOf(item),
                dictionary
            })));
        }
        return results;
    }
}

