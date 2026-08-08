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
import { ChannelStore, Menu, showToast, Toasts } from "@webpack/common";

import { ExportModal, setDmUserRow } from "./ExportModal";
import { getEarliestDmDate } from "./exportUtils";
import { MessageCheckbox } from "./MessageCheckbox";
import { ConfirmExportIcon, SelectionBar } from "./SelectionBar";
import { selectionStore } from "./selectionStore";

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
                    openModal(props => (
                        <ExportModal rootProps={props} channel={channel} initialFrom={message.timestamp} />
                    ));
                }}
            />
            <Menu.MenuItem
                id="vc-chat-export-select"
                label="Select messages"
                action={() => {
                    selectionStore.enter(message.channel_id, message.id);
                    document.querySelector("[class*=\"chat-\"]")?.classList.add("vc-ce-selecting");
                }}
            />
            <Menu.MenuItem
                id="vc-chat-export-all-dms"
                label="Export all DMs"
                action={async () => {
                    try {
                        const initialFrom = await getEarliestDmDate();
                        openModal(props => <ExportModal rootProps={props} allDms initialFrom={initialFrom} />);
                    } catch (error) {
                        showToast("Could not find the earliest DM: " + String(error), Toasts.Type.FAILURE);
                    }
                }}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "ChatExporter",
    description: "Export channel, selected, or all DM messages to JSON.",
    tags: ["Chat", "Utility"],
    authors: [Devs.chev],

    patches: [{
        find: "user-row-${",
        replacement: {
            match: /(?=function (\i)\(\i\)\{let\{user:\i,row:\i,hideDiscriminator:)/,
            replace: "$self.setDmUserRow($1);",
        },
    }],

    setDmUserRow,

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
