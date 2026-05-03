/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message } from "@vencord/discord-types";
import { ReactDOM, useEffect, useLayoutEffect, useReducer, useState } from "@webpack/common";

import { selectionStore } from "./selectionStore";

function CheckIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

export function MessageCheckbox({ message }: { message: Message; }) {
    const [, rerender] = useReducer(x => x + 1, 0);
    const [articleEl, setArticleEl] = useState<HTMLElement | null>(null);

    // Find the message article in the DOM (it definitely exists by layout time)
    useLayoutEffect(() => {
        setArticleEl(document.getElementById(`chat-messages-${message.channel_id}-${message.id}`));
    }, [message.id]);

    // Re-render whenever selection state changes
    useEffect(() => selectionStore.subscribe(rerender), []);

    const { active, channelId } = selectionStore;
    if (!active || channelId !== message.channel_id || !articleEl) return null;

    const checked = selectionStore.isSelected(message.id);

    return ReactDOM.createPortal(
        <div
            className={`vc-ce-msg-checkbox${checked ? " vc-ce-msg-checkbox-checked" : ""}`}
            role="checkbox"
            aria-checked={checked}
            onClick={e => {
                e.stopPropagation();
                e.preventDefault();
                selectionStore.click(message.id);
            }}
        >
            <div className="vc-ce-msg-checkbox-inner">
                {checked && <CheckIcon />}
            </div>
        </div>,
        articleEl
    );
}
