/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, type ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import type { Channel, User } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, ChannelStore, Forms, GuildStore, moment, ScrollerThin, showToast, TextInput, Toasts, useEffect, UserStore, useState } from "@webpack/common";
import type { Moment } from "moment";
import type { ComponentType } from "react";

import { discoverDmRecipients, downloadJson, type ExportOptions, fetchAllDmMessages, fetchMessages, getChannelName } from "./exportUtils";

const DatePickerInput = findComponentByCodeLazy("calendarClassName:", "dateFormat:", "autoFocus:!0");
const DmSearchInput = findComponentByCodeLazy('"data-mana-component":"text-input"', '"tags"===');
let DmUserRow: ComponentType<any> = () => null;

export function setDmUserRow(component: ComponentType<any>) {
    DmUserRow = component;
}

function DateField({ label, value, onChange, minDate, maxDate = moment(), disabled }: {
    label: string;
    value: Moment;
    onChange(value: Moment): void;
    minDate?: Moment;
    maxDate?: Moment;
    disabled?: boolean;
}) {
    return (
        <DatePickerInput
            label={label}
            value={value}
            minDate={minDate}
            maxDate={maxDate}
            onSelect={onChange}
            disabled={disabled}
        />
    );
}

type ExportModalProps =
    | { rootProps: ModalProps; channel: Channel; initialFrom?: string | Date; allDms?: never; }
    | { rootProps: ModalProps; allDms: true; channel?: never; initialFrom: Date; };

export function ExportModal({ rootProps, channel, initialFrom, allDms }: ExportModalProps) {
    const [fromDate, setFromDate] = useState(() => initialFrom ? moment(initialFrom) : moment().startOf("day"));
    const [untilDate, setUntilDate] = useState(() => moment().startOf("day"));
    const [limitStr, setLimitStr] = useState("");
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState(0);
    const [dmQuery, setDmQuery] = useState("");
    const [excludedUserIds, setExcludedUserIds] = useState<Set<string>>(() => new Set());
    const [dmRecipients, setDmRecipients] = useState<User[]>([]);
    const [isLoadingDms, setIsLoadingDms] = useState(false);
    const normalizedQuery = dmQuery.trim().toLocaleLowerCase();
    const visibleDmRecipients = dmRecipients.filter(user =>
        !normalizedQuery || [user.globalName, user.username, user.tag]
            .some(name => name?.toLocaleLowerCase().includes(normalizedQuery))
    );

    const guild = channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null;

    useEffect(() => {
        if (!allDms) return;

        const controller = new AbortController();
        ChannelStore.loadAllGuildAndPrivateChannelsFromDisk();
        const users = ChannelStore.getSortedPrivateChannels()
            .filter(dmChannel => dmChannel.isDM())
            .flatMap(dmChannel => {
                const recipientId = dmChannel.getRecipientId();
                const user = recipientId && UserStore.getUser(recipientId);
                return user ? [user] : [];
            });
        setDmRecipients([...new Map(users.map(user => [user.id, user])).values()]);

        setIsLoadingDms(true);
        discoverDmRecipients()
            .then(recipients => {
                if (controller.signal.aborted) return;
                const UserRecord = UserStore.getCurrentUser().constructor as new(data: object) => User;
                const discoveredUsers = recipients.map(recipient => UserStore.getUser(recipient.id) ?? new UserRecord(recipient));
                setDmRecipients(current => [...new Map([...current, ...discoveredUsers].map(user => [user.id, user])).values()]);
            })
            .catch(error => {
                if (!controller.signal.aborted) showToast("Could not find closed DMs: " + String(error), Toasts.Type.FAILURE);
            })
            .finally(() => {
                if (!controller.signal.aborted) setIsLoadingDms(false);
            });

        return () => controller.abort();
    }, [allDms]);

    function toggleUser(userId: string) {
        setExcludedUserIds(current => {
            const next = new Set(current);
            next.has(userId) ? next.delete(userId) : next.add(userId);
            return next;
        });
    }

    async function handleExport() {
        const from = fromDate.clone().startOf("day").toDate();
        const until = untilDate.clone().endOf("day").toDate();
        const limit = !allDms && limitStr.trim() ? parseInt(limitStr.trim(), 10) : undefined;

        if (from > until) {
            showToast("'From' must be before 'Until'.", Toasts.Type.FAILURE);
            return;
        }
        if (!allDms && limitStr.trim() && (!limit || limit <= 0)) {
            showToast("Message limit must be a positive number.", Toasts.Type.FAILURE);
            return;
        }

        const options: ExportOptions = { from, until, limit };
        setIsExporting(true);
        setProgress(0);

        try {
            if (allDms) {
                const { channels, messageCount } = await fetchAllDmMessages(options, excludedUserIds, setProgress);
                if (!channels.length) {
                    showToast("No DMs found in this date range.", Toasts.Type.MESSAGE);
                    return;
                }
                downloadJson({
                    exportedAt: new Date().toISOString(),
                    from: from.toISOString(),
                    until: until.toISOString(),
                    channelCount: channels.length,
                    channels,
                    messageCount,
                }, `all-dms-${fromDate.format("YYYY-MM-DD")}-to-${untilDate.format("YYYY-MM-DD")}.json`);
                showToast(`Exported ${messageCount} messages from ${channels.length} DMs!`, Toasts.Type.SUCCESS);
            } else {
                const messages = await fetchMessages(channel.id, options, setProgress);
                const channelName = getChannelName(channel);
                downloadJson({
                    channel: { id: channel.id, name: channelName, type: channel.type },
                    guild: guild ? { id: guild.id, name: guild.name } : null,
                    exportedAt: new Date().toISOString(),
                    messageCount: messages.length,
                    messages,
                }, `${channelName.replace(/[^a-zA-Z0-9_-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.json`);
                showToast(`Exported ${messages.length} messages!`, Toasts.Type.SUCCESS);
            }

            rootProps.onClose();
        } catch (error) {
            showToast("Export failed: " + String(error), Toasts.Type.FAILURE);
        } finally {
            setIsExporting(false);
        }
    }

    return (
        <ModalRoot {...rootProps} size={allDms ? ModalSize.MEDIUM : ModalSize.SMALL}>
            <ModalHeader className="vc-ce-modal-header">
                <Forms.FormTitle tag="h2" className="vc-ce-modal-title">
                    {allDms ? "Export All DMs" : "Export Chat"}
                </Forms.FormTitle>
                <ModalCloseButton onClick={rootProps.onClose} className="vc-ce-modal-close-button" />
            </ModalHeader>

            <ModalContent className="vc-ce-modal-content">
                <DateField
                    label="From"
                    value={fromDate}
                    onChange={setFromDate}
                    disabled={isExporting}
                />
                <DateField
                    label="Until"
                    value={untilDate}
                    onChange={setUntilDate}
                    disabled={isExporting}
                />

                {!allDms && (
                    <div className="vc-ce-field">
                        <label>Message Limit</label>
                        <TextInput
                            placeholder="Leave blank to export all messages"
                            value={limitStr}
                            onChange={setLimitStr}
                            disabled={isExporting}
                        />
                    </div>
                )}

                {allDms && (
                    <div className="vc-ce-dm-picker">
                        <div>
                            <Forms.FormTitle tag="h5">DMs to exclude</Forms.FormTitle>
                            <Forms.FormText>
                                {excludedUserIds.size} excluded
                                {isLoadingDms && " · Finding closed DMs…"}
                            </Forms.FormText>
                        </div>
                        <DmSearchInput
                            autoFocus
                            fullWidth
                            placeholder="Search DMs"
                            value={dmQuery}
                            onChange={setDmQuery}
                            disabled={isExporting}
                            role="combobox"
                            aria-autocomplete="list"
                            aria-haspopup="listbox"
                            aria-expanded={Boolean(visibleDmRecipients.length)}
                        />
                        <ScrollerThin className="vc-ce-dm-list">
                            {visibleDmRecipients.map((user: User, row) => (
                                <DmUserRow
                                    key={user.id}
                                    user={user}
                                    row={row}
                                    comparator={dmQuery}
                                    selected={false}
                                    checked={excludedUserIds.has(user.id)}
                                    onClick={() => toggleUser(user.id)}
                                    aria-setsize={visibleDmRecipients.length}
                                    aria-posinset={row + 1}
                                />
                            ))}
                        </ScrollerThin>
                    </div>
                )}

                {isExporting && (
                    <p className="vc-ce-progress">
                        {allDms ? "Searching all DMs… " : "Fetching messages… "}
                        {progress} scanned so far
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
                        {isExporting
                            ? allDms ? `Searching… (${progress})` : `Exporting… (${progress})`
                            : allDms ? "Export All DMs" : "Export"}
                    </Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}
