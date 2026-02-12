/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { TextInput, Toasts, useEffect, useState } from "@webpack/common";

import { deleteDictionary, getDictionaryPriorities, getInstalledDictionaries, importDictionaryJSON, importMultipleDictionaryFiles, updateDictionaryPriority, type ProgressCallback } from "./dictionary";

export function DictionarySettings() {
    const [dictionaries, setDictionaries] = useState<string[]>([]);
    const [priorities, setPriorities] = useState<Record<string, number>>({});
    const [dictionaryName, setDictionaryName] = useState("JMdict");
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState<{ current: number; total: number; stage: string; } | null>(null);

    const loadDictionaries = async () => {
        const [dicts, prio] = await Promise.all([getInstalledDictionaries(), getDictionaryPriorities()]);
        setDictionaries(dicts);
        setPriorities(prio);
    };

    useEffect(() => {
        loadDictionaries();
    }, []);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setUploading(true);
        setProgress({ current: 0, total: 100, stage: "Starting..." });

        const onProgress: ProgressCallback = (current, total, stage) => {
            setProgress({ current, total, stage });
        };

        try {
            if (files.length === 1) {
                // Single file upload
                const result = await importDictionaryJSON(files[0], dictionaryName, onProgress);
                if (result.success) {
                    Toasts.show({
                        message: `Dictionary "${dictionaryName}" imported successfully!`,
                        id: Toasts.genId(),
                        type: Toasts.Type.SUCCESS
                    });
                    await loadDictionaries();
                } else {
                    Toasts.show({
                        message: `Failed to import: ${result.error}`,
                        id: Toasts.genId(),
                        type: Toasts.Type.FAILURE
                    });
                }
            } else {
                // Multiple files upload
                const result = await importMultipleDictionaryFiles(Array.from(files), dictionaryName, onProgress);
                if (result.success) {
                    Toasts.show({
                        message: `Imported ${result.imported} file(s) into "${dictionaryName}"`,
                        id: Toasts.genId(),
                        type: Toasts.Type.SUCCESS
                    });
                    await loadDictionaries();
                } else {
                    Toasts.show({
                        message: `Failed to import: ${result.error}`,
                        id: Toasts.genId(),
                        type: Toasts.Type.FAILURE
                    });
                }
            }
        } catch (error) {
            Toasts.show({
                message: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
        } finally {
            setUploading(false);
            setTimeout(() => setProgress(null), 2000); // Clear progress after 2 seconds
            e.target.value = ""; // Reset input
        }
    };

    const handleDelete = async (name: string) => {
        await deleteDictionary(name);
        Toasts.show({
            message: `Dictionary "${name}" deleted`,
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS
        });
        await loadDictionaries();
    };

    const handlePriorityChange = async (name: string, value: string) => {
        const n = parseInt(value, 10);
        if (Number.isNaN(n) || n < 1) return;
        await updateDictionaryPriority(name, n);
        await loadDictionaries();
    };

    return (
        <div>
            <section>
                <Heading tag="h3">Dictionary Management</Heading>
                <Paragraph>
                    Upload Yomichan-compatible dictionary JSON files (term_bank_*.json)
                </Paragraph>
                <Divider style={{ marginTop: "1em", marginBottom: "1em" }} />

                <Heading tag="h5">Import Dictionary</Heading>
                <TextInput
                    placeholder="Dictionary Name (e.g., JMdict)"
                    value={dictionaryName}
                    onChange={setDictionaryName}
                    style={{ marginBottom: "10px" }}
                />

                <div style={{ marginBottom: "20px" }}>
                    <input
                        type="file"
                        accept=".json"
                        multiple
                        onChange={handleFileUpload}
                        style={{ display: "none" }}
                        id="dictionary-upload"
                    />
                    <label htmlFor="dictionary-upload">
                        <Button
                            disabled={uploading || !dictionaryName.trim()}
                            onClick={() => document.getElementById("dictionary-upload")?.click()}
                            size="small"
                        >
                            {uploading ? "Importing..." : "Select JSON File(s)"}
                        </Button>
                    </label>
                    <Span style={{ marginTop: "8px", fontSize: "0.9em", color: "var(--text-muted)" }}>
                        You can select multiple term_bank files at once
                    </Span>

                    {progress && (
                        <div style={{ marginTop: "12px" }}>
                            <div style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: "4px",
                                fontSize: "0.9em"
                            }}>
                                <Span style={{ color: "var(--text-muted)" }}>
                                    {progress.stage}
                                </Span>
                                <Span style={{ color: "var(--text-muted)" }}>
                                    {progress.current}%
                                </Span>
                            </div>
                            <div style={{
                                width: "100%",
                                height: "8px",
                                backgroundColor: "var(--background-modifier-accent)",
                                borderRadius: "4px",
                                overflow: "hidden"
                            }}>
                                <div style={{
                                    width: `${progress.current}%`,
                                    height: "100%",
                                    backgroundColor: "var(--brand-experiment)",
                                    transition: "width 0.3s ease",
                                    borderRadius: "4px"
                                }} />
                            </div>
                        </div>
                    )}
                </div>

                <Divider style={{ marginTop: "1em", marginBottom: "1em" }} />

                <Heading tag="h5">Installed Dictionaries</Heading>
                {dictionaries.length === 0 ? (
                    <Paragraph style={{ color: "var(--text-muted)" }}>
                        No dictionaries installed yet. Upload dictionary files above to get started.
                    </Paragraph>
                ) : (
                    <div>
                        <Paragraph style={{ marginBottom: "8px", color: "var(--text-muted)" }}>
                            Priority number (lower = first in popups).
                        </Paragraph>
                        {dictionaries.map((dict, idx) => (
                            <div
                                key={dict}
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    padding: "4px 12px",
                                    marginBottom: "4px",
                                    background: "var(--background-secondary)",
                                    borderRadius: "4px"
                                }}
                            >
                                <Span>{dict}</Span>
                                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                    <TextInput
                                        type="number"
                                        min={1}
                                        value={String(priorities[dict] ?? idx + 1)}
                                        onChange={v => {
                                            const n = parseInt(v, 10);
                                            setPriorities(prev => ({ ...prev, [dict]: Number.isNaN(n) || n < 1 ? 1 : n }));
                                        }}
                                        onBlur={e => handlePriorityChange(dict, (e.target as HTMLInputElement).value)}
                                        onKeyDown={e => {
                                            if (e.key === "Enter") handlePriorityChange(dict, (e.target as HTMLInputElement).value);
                                        }}
                                        style={{ width: "56px" }}
                                    />
                                    <Button
                                        variant="dangerPrimary"
                                        size="small"
                                        onClick={() => handleDelete(dict)}
                                    >
                                        Delete
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section style={{ marginTop: "20px" }}>
                <Heading tag="h5">How to Get Dictionaries</Heading>
                <Paragraph>
                    1. Download a Yomichan dictionary (e.g., JMdict) from <a href="https://github.com/themoeway/jmdict-yomitan" target="_blank">here</a><br />
                    2. Extract the ZIP file<br />
                    3. Upload the term_bank_*.json files using the button above<br />
                    4. You can upload multiple files at once!
                </Paragraph>
            </section>
        </div>
    );
}

