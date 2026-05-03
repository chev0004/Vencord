/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { MessageDecorationProps } from "@api/MessageDecorations";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu } from "@webpack/common";

import { ExportModal } from "./ExportModal";
import { MessageCheckbox } from "./MessageCheckbox";
import { ConfirmExportIcon, SelectionBar } from "./SelectionBar";
import { selectionStore } from "./selectionStore";

// Convert a JS Date to a datetime-local input value string
function toDatetimeLocal(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return;

    children.push(
        <Menu.MenuItem
            id="vc-chat-export"
            key="vc-chat-export"
            label="Export"
        >
            <Menu.MenuItem
                id="vc-chat-export-from-here"
                label="Extract from here"
                action={() => {
                    const from = toDatetimeLocal(new Date(message.timestamp));
                    openModal(props => (
                        <ExportModal rootProps={props} channel={channel} initialFrom={from} />
                    ));
                }}
            />
            <Menu.MenuItem
                id="vc-chat-export-select"
                label="Select messages"
                action={() => {
                    selectionStore.enter(message.channel_id, message.id);
                    // Add class to chat container so CSS can shift content
                    document.querySelector(`[class*="chat-"]`)?.classList.add("vc-ce-selecting");
                }}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "ChatExporter",
    description: "Export channel or DM messages to JSON. Right-click any message to extract from there or select a range.",
    tags: ["Chat", "Utility"],
    authors: [Devs.chev],

    contextMenus: {
        "message": messageCtxPatch,
    },

    renderMessageDecoration(props: MessageDecorationProps) {
        return <MessageCheckbox message={props.message} />;
    },

    chatBarButton: {
        icon: ConfirmExportIcon,
        render: SelectionBar,
    },

    onUnload() {
        selectionStore.exit();
        document.querySelector(".vc-ce-selecting")?.classList.remove("vc-ce-selecting");
    },
});
