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
import { Alerts, TextInput, Toasts, useEffect, useRef, useState } from "@webpack/common";

import { deleteDictionary, getDictionaryPriorities, getInstalledDictionaries, importMultipleDictionaryFiles, updateDictionaryPriority } from "./dictionary";
import { readZipEntries } from "./zip";

const TERM_BANK_REGEX = /^term_bank_\d+\.json$/;

async function extractDictionaryZip(zip: File): Promise<{ title?: string; termBanks: File[]; }> {
    const termBanks: File[] = [];
    let title: string | undefined;
    for (const entry of await readZipEntries(zip)) {
        const baseName = entry.name.split("/").pop()!;
        if (TERM_BANK_REGEX.test(baseName)) {
            termBanks.push(new File([await entry.text()], baseName));
        } else if (baseName === "index.json") {
            title = JSON.parse(await entry.text()).title;
        }
    }
    if (termBanks.length === 0) throw new Error(`No term_bank_*.json files found in ${zip.name}`);
    return { title, termBanks };
}

export function DictionarySettings() {
    const [dictionaries, setDictionaries] = useState<string[]>([]);
    const [priorities, setPriorities] = useState<Record<string, number>>({});
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState<{ current: number; total: number; stage: string; } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadDictionaries = async () => {
        const [dicts, prio] = await Promise.all([getInstalledDictionaries(), getDictionaryPriorities()]);
        setDictionaries(dicts);
        setPriorities(prio);
    };

    useEffect(() => {
        loadDictionaries();
    }, []);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const { files } = e.target;
        if (!files || files.length === 0) return;

        setUploading(true);
        setProgress({ current: 0, total: 100, stage: "Starting..." });

        try {
            for (const zip of Array.from(files)) {
                setProgress({ current: 0, total: 100, stage: `Extracting ${zip.name}...` });
                const { title, termBanks } = await extractDictionaryZip(zip);
                const name = title?.trim() || zip.name.replace(/\.zip$/i, "");

                const result = await importMultipleDictionaryFiles(
                    termBanks,
                    name,
                    (current, total, stage) => setProgress({ current, total, stage })
                );
                if (!result.success) throw new Error(result.error ?? "Import failed");
                Toasts.show({
                    message: `Imported "${name}" (${result.imported} file(s))`,
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS
                });
            }
            await loadDictionaries();
        } catch (error) {
            Toasts.show({
                message: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
        } finally {
            setUploading(false);
            setTimeout(() => setProgress(null), 2000);
            e.target.value = "";
        }
    };

    const handleDelete = (name: string) => {
        Alerts.show({
            title: "Delete Dictionary",
            body: `Delete "${name}" and all its imported data?`,
            confirmText: "Delete",
            cancelText: "Cancel",
            onConfirm: async () => {
                await deleteDictionary(name);
                Toasts.show({
                    message: `Dictionary "${name}" deleted`,
                    id: Toasts.genId(),
                    type: Toasts.Type.SUCCESS
                });
                await loadDictionaries();
            }
        });
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
                    Import Yomichan-compatible dictionary ZIPs
                </Paragraph>
                <Divider style={{ marginTop: "1em", marginBottom: "1em" }} />

                <Heading tag="h5">Import Dictionary</Heading>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "8px", margin: "12px 0 20px" }}>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".zip"
                        multiple
                        onChange={handleFileUpload}
                        style={{ display: "none" }}
                    />
                    <Button
                        disabled={uploading}
                        onClick={() => fileInputRef.current?.click()}
                        size="small"
                    >
                        {uploading ? "Importing..." : "Import Dictionary ZIP(s)"}
                    </Button>
                    <Span style={{ fontSize: "0.9em", color: "var(--text-muted)" }}>
                        Dictionaries are named automatically from the ZIP
                    </Span>

                    {progress && (
                        <div style={{ width: "100%", marginTop: "4px" }}>
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
                        No dictionaries installed yet. Import a dictionary ZIP above to get started.
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
                    1. Download a Yomichan dictionary (e.g., JMdict) from <a href="https://github.com/themoeway/jmdict-yomitan" target="_blank" rel="noreferrer">here</a><br />
                    2. Upload the ZIP directly using the button above — no need to extract
                </Paragraph>
            </section>
        </div>
    );
}
