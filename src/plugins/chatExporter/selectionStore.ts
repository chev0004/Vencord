/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageStore } from "@webpack/common";

type Listener = () => void;

export const selectionStore = {
    active: false,
    channelId: null as string | null,
    anchorId: null as string | null,
    selectedIds: new Set<string>(),

    _listeners: new Set<Listener>(),

    _notify() {
        this._listeners.forEach(l => l());
    },

    subscribe(l: Listener): () => void {
        this._listeners.add(l);
        return () => this._listeners.delete(l);
    },

    enter(channelId: string, anchorId?: string) {
        this.active = true;
        this.channelId = channelId;
        this.anchorId = anchorId ?? null;
        this.selectedIds = new Set(anchorId ? [anchorId] : []);
        this._notify();
    },

    exit() {
        this.active = false;
        this.channelId = null;
        this.anchorId = null;
        this.selectedIds = new Set();
        this._notify();
    },

    // First click sets anchor. Subsequent clicks range-select from anchor to here.
    click(messageId: string) {
        const { anchorId, selectedIds, channelId } = this;
        if (!channelId) return;

        if (!anchorId) {
            this.anchorId = messageId;
            selectedIds.add(messageId);
        } else {
            const msgs = (MessageStore.getMessages(channelId) as any)._array as { id: string; }[] ?? [];
            const ai = msgs.findIndex(m => m.id === anchorId);
            const bi = msgs.findIndex(m => m.id === messageId);

            if (ai !== -1 && bi !== -1) {
                const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
                for (let i = lo; i <= hi; i++) selectedIds.add(msgs[i].id);
            } else {
                selectedIds.add(messageId);
            }

            this.anchorId = messageId;
        }

        this._notify();
    },

    isSelected(messageId: string) {
        return this.selectedIds.has(messageId);
    },
};
