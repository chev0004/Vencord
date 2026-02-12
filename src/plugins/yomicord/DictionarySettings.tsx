/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, Forms, Text, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import { cleanupOrphanedDictionaryKeys, deleteDictionary, findOrphanedDictionaryKeys, getInstalledDictionaries, importDictionaryJSON, importMultipleDictionaryFiles, type ProgressCallback } from "./dictionary";

export function DictionarySettings() {
    const [dictionaries, setDictionaries] = useState<string[]>([]);
    const [dictionaryName, setDictionaryName] = useState("JMdict");
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState<{ current: number; total: number; stage: string; } | null>(null);
    const [cleaning, setCleaning] = useState(false);

    const loadDictionaries = async () => {
        const dicts = await getInstalledDictionaries();
        setDictionaries(dicts);
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

    const handleCleanupOrphaned = async () => {
        setCleaning(true);
        try {
            const orphanedKeys = await findOrphanedDictionaryKeys();
            if (orphanedKeys.length === 0) {
                Toasts.show({
                    message: "No orphaned dictionary data found",
                    id: Toasts.genId(),
                    type: Toasts.Type.MESSAGE
                });
                setCleaning(false);
                return;
            }

            const deleted = await cleanupOrphanedDictionaryKeys();
            Toasts.show({
                message: `Cleaned up ${deleted} orphaned dictionary key${deleted === 1 ? "" : "s"}`,
                id: Toasts.genId(),
                type: Toasts.Type.SUCCESS
            });
        } catch (error) {
            Toasts.show({
                message: `Error cleaning up: ${error instanceof Error ? error.message : "Unknown error"}`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
        } finally {
            setCleaning(false);
        }
    };

    return (
        <div>
            <Forms.FormSection>
                <Forms.FormTitle tag="h3">Dictionary Management</Forms.FormTitle>
                <Forms.FormText>
                    Upload Yomichan-compatible dictionary JSON files (term_bank_*.json)
                </Forms.FormText>
                <Forms.FormDivider style={{ marginTop: "1em", marginBottom: "1em" }} />

                <Forms.FormTitle tag="h5">Import Dictionary</Forms.FormTitle>
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
                        >
                            {uploading ? "Importing..." : "Select JSON File(s)"}
                        </Button>
                    </label>
                    <Text style={{ marginTop: "8px", fontSize: "0.9em", color: "var(--text-muted)" }}>
                        You can select multiple term_bank files at once
                    </Text>

                    {progress && (
                        <div style={{ marginTop: "12px" }}>
                            <div style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: "4px",
                                fontSize: "0.9em"
                            }}>
                                <Text style={{ color: "var(--text-muted)" }}>
                                    {progress.stage}
                                </Text>
                                <Text style={{ color: "var(--text-muted)" }}>
                                    {progress.current}%
                                </Text>
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

                <Forms.FormDivider style={{ marginTop: "1em", marginBottom: "1em" }} />

                <Forms.FormTitle tag="h5">Cleanup</Forms.FormTitle>
                <Forms.FormText style={{ marginBottom: "10px" }}>
                    Remove orphaned dictionary data that may be left over from deleted dictionaries
                </Forms.FormText>
                <Button
                    onClick={handleCleanupOrphaned}
                    disabled={cleaning}
                    color={Button.Colors.BRAND}
                    size={Button.Sizes.SMALL}
                >
                    {cleaning ? "Cleaning..." : "Clean Up Orphaned Data"}
                </Button>

                <Forms.FormDivider style={{ marginTop: "1em", marginBottom: "1em" }} />

                <Forms.FormTitle tag="h5">Installed Dictionaries</Forms.FormTitle>
                {dictionaries.length === 0 ? (
                    <Text style={{ color: "var(--text-muted)" }}>
                        No dictionaries installed yet. Upload dictionary files above to get started.
                    </Text>
                ) : (
                    <div>
                        {dictionaries.map(dict => (
                            <div
                                key={dict}
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    padding: "8px 12px",
                                    marginBottom: "8px",
                                    background: "var(--background-secondary)",
                                    borderRadius: "4px"
                                }}
                            >
                                <Text>{dict}</Text>
                                <Button
                                    color={Button.Colors.RED}
                                    size={Button.Sizes.SMALL}
                                    onClick={() => handleDelete(dict)}
                                >
                                    Delete
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </Forms.FormSection>

            <Forms.FormSection style={{ marginTop: "20px" }}>
                <Forms.FormTitle tag="h5">How to Get Dictionaries</Forms.FormTitle>
                <Forms.FormText>
                    1. Download a Yomichan dictionary (e.g., JMdict) from <a href="https://github.com/themoeway/jmdict-yomitan" target="_blank">here</a><br />
                    2. Extract the ZIP file<br />
                    3. Upload the term_bank_*.json files using the button above<br />
                    4. You can upload multiple files at once!
                </Forms.FormText>
            </Forms.FormSection>
        </div>
    );
}

