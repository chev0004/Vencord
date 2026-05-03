/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, MessageStore, RestAPI } from "@webpack/common";

export interface ExportOptions {
    from?: Date;
    until?: Date;
    limit?: number;
}

export interface ExportedAuthor {
    name: string;
}

export interface ExportedMessage {
    timestamp: string;
    author: ExportedAuthor;
    content: string;
    attachments?: string[];
}

export interface ExportResult {
    channel: { id: string; name: string; type: number; };
    guild: { id: string; name: string; } | null;
    exportedAt: string;
    messageCount: number;
    messages: ExportedMessage[];
}

// Converts a Date to a Discord snowflake string usable as a "before" cursor
function dateToSnowflake(date: Date): string {
    const DISCORD_EPOCH = 1420070400000n;
    return ((BigInt(date.getTime()) - DISCORD_EPOCH) << 22n).toString();
}

function formatMessage(raw: any): ExportedMessage {
    const attachments: string[] = (raw.attachments ?? []).map((a: any) => a.filename);
    const stickers: string[] = (raw.sticker_items ?? []).map((s: any) => s.name);
    const allAttachments = [...attachments, ...stickers];

    let content: string = raw.content ?? "";
    if (!content) {
        if (allAttachments.length) content = allAttachments.join(", ");
        else if (raw.embeds?.length) content = "[Embed]";
    }

    // "2023-08-16 15:44:51" — strip timezone and sub-seconds
    const timestamp = raw.timestamp.replace("T", " ").replace(/\.\d+.*$/, "").replace(/\+.*$/, "");

    const msg: ExportedMessage = {
        timestamp,
        author: {
            name: raw.author.global_name ?? raw.author.username,
        },
        content,
    };

    if (allAttachments.length) msg.attachments = allAttachments;

    return msg;
}

export async function fetchMessages(
    channelId: string,
    options: ExportOptions,
    onProgress?: (count: number) => void
): Promise<ExportedMessage[]> {
    const { from, until, limit } = options;
    const messages: ExportedMessage[] = [];

    // Use "until" date as the starting "before" cursor if provided
    let before: string | undefined = until ? dateToSnowflake(until) : undefined;

    while (true) {
        const query: Record<string, any> = { limit: 100 };
        if (before) query.before = before;

        let res: any;
        try {
            res = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channelId),
                query,
                retries: 2,
            });
        } catch {
            break;
        }

        const batch: any[] = res?.body ?? [];
        if (!batch.length) break;

        let done = false;
        for (const raw of batch) {
            if (from && new Date(raw.timestamp) < from) {
                done = true;
                break;
            }
            messages.push(formatMessage(raw));
            onProgress?.(messages.length);
            if (limit && messages.length >= limit) {
                done = true;
                break;
            }
        }

        if (done) break;

        // Oldest message in the batch becomes the next "before" cursor
        before = batch[batch.length - 1].id;

        // Brief pause to avoid hammering the API
        await new Promise(r => setTimeout(r, 350));
    }

    return messages;
}

// Export messages that are already cached in MessageStore (selection mode)
export function exportSelectedMessages(
    channelId: string,
    selectedIds: Set<string>,
    channelName: string,
    guild: { id: string; name: string; } | null,
    channelType: number,
): ExportResult {
    const cached = (MessageStore.getMessages(channelId) as any)._array as any[] ?? [];
    const messages = cached
        .filter((m: any) => selectedIds.has(m.id))
        .sort((a: any, b: any) => a.id < b.id ? -1 : 1)
        .map(formatMessage);

    return {
        channel: { id: channelId, name: channelName, type: channelType },
        guild,
        exportedAt: new Date().toISOString(),
        messageCount: messages.length,
        messages,
    };
}

export function downloadJson(data: ExportResult, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
