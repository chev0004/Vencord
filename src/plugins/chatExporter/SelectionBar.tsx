/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { IconComponent } from "@utils/types";
import { ChannelStore, GuildStore, showToast, Toasts, useEffect, useReducer } from "@webpack/common";

import { downloadJson, exportSelectedMessages } from "./exportUtils";
import { selectionStore } from "./selectionStore";

export const ConfirmExportIcon: IconComponent = ({ width = 20, height = 20, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
);

export const CancelSelectionIcon: IconComponent = ({ width = 20, height = 20, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </svg>
);

export const SelectionBar: ChatBarButtonFactory = ({ isMainChat }) => {
    const [, rerender] = useReducer(x => x + 1, 0);
    useEffect(() => selectionStore.subscribe(rerender), []);

    if (!isMainChat || !selectionStore.active) return null;

    const count = selectionStore.selectedIds.size;

    function handleExport() {
        const { channelId, selectedIds } = selectionStore;
        if (!channelId || !selectedIds.size) {
            showToast("Select at least one message first.", Toasts.Type.FAILURE);
            return;
        }

        const channel = ChannelStore.getChannel(channelId);
        const guild = (channel as any)?.guild_id ? GuildStore.getGuild((channel as any).guild_id) : null;
        const channelName = (channel as any)?.name || channelId;

        const result = exportSelectedMessages(
            channelId,
            selectedIds,
            channelName,
            guild ? { id: guild.id, name: guild.name } : null,
            channel?.type ?? 0,
        );

        const safeName = channelName.replace(/[^a-zA-Z0-9_-]/g, "_");
        downloadJson(result, `${safeName}-selection-${new Date().toISOString().slice(0, 10)}.json`);

        showToast(`Exported ${result.messageCount} message${result.messageCount !== 1 ? "s" : ""}!`, Toasts.Type.SUCCESS);
        selectionStore.exit();
    }

    return (
        <>
            <ChatBarButton
                tooltip={count ? `Export ${count} selected message${count !== 1 ? "s" : ""}` : "No messages selected"}
                onClick={handleExport}
                buttonProps={{ className: "vc-ce-confirm-btn" }}
            >
                <ConfirmExportIcon />
            </ChatBarButton>
            <ChatBarButton
                tooltip="Cancel selection"
                onClick={() => selectionStore.exit()}
                buttonProps={{ className: "vc-ce-cancel-btn" }}
            >
                <CancelSelectionIcon />
            </ChatBarButton>
        </>
    );
};
