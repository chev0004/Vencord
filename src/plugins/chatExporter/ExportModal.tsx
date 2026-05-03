/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot } from "@utils/modal";
import { getTheme, Theme } from "@utils/discord";
import { Channel } from "@vencord/discord-types";
import { Button, Forms, GuildStore, showToast, TextInput, Toasts, useState } from "@webpack/common";

import { downloadJson, ExportOptions, fetchMessages } from "./exportUtils";

function DateField({ label, value, onChange, disabled }: {
    label: string;
    value: string;
    onChange(v: string): void;
    disabled?: boolean;
}) {
    return (
        <div className="vc-ce-field">
            <label>{label}</label>
            <input
                className="vc-ce-date-input"
                type="datetime-local"
                value={value}
                onChange={e => onChange(e.currentTarget.value)}
                disabled={disabled}
                style={{ colorScheme: getTheme() === Theme.Light ? "light" : "dark" }}
            />
        </div>
    );
}

// initialFrom: ISO datetime-local string, pre-filled by "Extract from here"
export function ExportModal({ rootProps, channel, initialFrom }: { rootProps: ModalProps; channel: Channel; initialFrom?: string; }) {
    const [fromVal, setFromVal] = useState(initialFrom ?? "");
    const [untilVal, setUntilVal] = useState("");
    const [limitStr, setLimitStr] = useState("");
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState(0);

    const guild = (channel as any).guild_id ? GuildStore.getGuild((channel as any).guild_id) : null;

    async function handleExport() {
        const from = fromVal ? new Date(fromVal) : undefined;
        const until = untilVal ? new Date(untilVal) : undefined;
        const limit = limitStr.trim() ? parseInt(limitStr.trim(), 10) : undefined;

        if (from && isNaN(from.getTime())) {
            showToast("Invalid 'From' date.", Toasts.Type.FAILURE);
            return;
        }
        if (until && isNaN(until.getTime())) {
            showToast("Invalid 'Until' date.", Toasts.Type.FAILURE);
            return;
        }
        if (limitStr.trim() && (!limit || limit <= 0)) {
            showToast("Message limit must be a positive number.", Toasts.Type.FAILURE);
            return;
        }

        const options: ExportOptions = { from, until, limit };

        setIsExporting(true);
        setProgress(0);

        try {
            const messages = await fetchMessages(channel.id, options, count => setProgress(count));

            const channelName = (channel as any).name || channel.id;
            const result = {
                channel: { id: channel.id, name: channelName, type: channel.type },
                guild: guild ? { id: guild.id, name: guild.name } : null,
                exportedAt: new Date().toISOString(),
                messageCount: messages.length,
                messages,
            };

            const safeName = channelName.replace(/[^a-zA-Z0-9_-]/g, "_");
            downloadJson(result, `${safeName}-${new Date().toISOString().slice(0, 10)}.json`);

            showToast(`Exported ${messages.length} messages!`, Toasts.Type.SUCCESS);
            rootProps.onClose();
        } catch (err) {
            showToast("Export failed: " + String(err), Toasts.Type.FAILURE);
        } finally {
            setIsExporting(false);
        }
    }

    return (
        <ModalRoot {...rootProps}>
            <ModalHeader className="vc-ce-modal-header">
                <Forms.FormTitle tag="h2" className="vc-ce-modal-title">
                    Export Chat
                </Forms.FormTitle>
                <ModalCloseButton onClick={rootProps.onClose} className="vc-ce-modal-close-button" />
            </ModalHeader>

            <ModalContent className="vc-ce-modal-content">
                <DateField
                    label="From"
                    value={fromVal}
                    onChange={setFromVal}
                    disabled={isExporting}
                />

                <DateField
                    label="Until"
                    value={untilVal}
                    onChange={setUntilVal}
                    disabled={isExporting}
                />

                <div className="vc-ce-field">
                    <label>Message Limit</label>
                    <TextInput
                        placeholder="Leave blank to export all messages"
                        value={limitStr}
                        onChange={setLimitStr}
                        disabled={isExporting}
                    />
                </div>

                {isExporting && (
                    <p className="vc-ce-progress">
                        Fetching messages… {progress} collected so far
                    </p>
                )}
            </ModalContent>

            <ModalFooter>
                <div className="vc-ce-footer-buttons">
                    <Button
                        color={Button.Colors.PRIMARY}
                        look={Button.Looks.LINK}
                        onClick={rootProps.onClose}
                        disabled={isExporting}
                    >
                        Cancel
                    </Button>
                    <Button
                        color={Button.Colors.BRAND}
                        onClick={handleExport}
                        disabled={isExporting}
                    >
                        {isExporting ? `Exporting… (${progress})` : "Export"}
                    </Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}
