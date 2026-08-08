/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RawRecipient } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, Constants, MessageStore, RestAPI } from "@webpack/common";

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

export interface ExportedDmChannel {
    channel: { id: string; name: string; type: number | null; };
    messageCount: number;
    messages: ExportedMessage[];
}

const DISCORD_EPOCH = 1420070400000n;
let discoveredDmRecipients: RawRecipient[] | undefined;
let earliestDmDate: Date | undefined;

function dateToSnowflake(date: Date): string {
    return ((BigInt(date.getTime()) - DISCORD_EPOCH) << 22n).toString();
}

function wait(duration = 350) {
    return new Promise(resolve => setTimeout(resolve, duration));
}

export function getChannelName(channel: any): string {
    const recipients = channel.rawRecipients ?? channel.recipients ?? [];
    return channel.name || recipients.map((user: any) => typeof user === "string" ? user : user.global_name ?? user.username).join(", ") || channel.id;
}

async function searchDmMessages(
    options: ExportOptions,
    cursor: unknown = null,
    sortOrder = "desc",
    limit = 25,
) {
    const query: Record<string, any> = {
        sort_by: "timestamp",
        sort_order: sortOrder,
        cursor,
        limit,
        min_id: options.from ? dateToSnowflake(options.from) : "0",
    };
    if (options.until) query.max_id = dateToSnowflake(new Date(options.until.getTime() + 1));

    let response: any;
    let retries = 0;
    while (true) {
        try {
            response = await RestAPI.post({
                url: "/users/@me/messages/search/tabs",
                body: {
                    tabs: { messages: query },
                    track_exact_total_hits: false,
                },
            });
            break;
        } catch (error) {
            const { status, body } = error as { status?: number; body?: { retry_after?: number; }; };
            if (body?.retry_after != null) {
                await wait(body.retry_after * 1000);
                continue;
            }
            if ((status ?? 0) >= 500 && retries++ < 5) {
                await wait();
                continue;
            }
            throw error;
        }
    }
    const result = response.body?.tabs?.messages;
    if (!result?.messages) throw new Error("Discord returned an invalid global DM search response.");
    return { messages: result.messages.flat(), channels: result.channels ?? [], cursor: result.cursor };
}

export async function getEarliestDmDate() {
    if (earliestDmDate) return earliestDmDate;
    const { messages } = await searchDmMessages({}, null, "asc", 1);
    if (!messages[0]) throw new Error("No DM messages are available.");
    earliestDmDate = new Date(messages[0].timestamp);
    return earliestDmDate;
}

export async function discoverDmRecipients() {
    if (discoveredDmRecipients) return discoveredDmRecipients;
    const response = await RestAPI.get({ url: "/users/@me/channels", retries: 2 });
    const recipients: RawRecipient[] = (response.body as Array<{ type: number; recipients?: RawRecipient[]; }>)
        .filter(channel => channel.type === ChannelType.DM)
        .flatMap(channel => channel.recipients ?? []);
    return discoveredDmRecipients = [...new Map(recipients.map(recipient => [recipient.id, recipient])).values()];
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

    let before: string | undefined = until ? dateToSnowflake(new Date(until.getTime() + 1)) : undefined;

    while (true) {
        const query: Record<string, any> = { limit: 100 };
        if (before) query.before = before;

        const res: any = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query,
            retries: 2,
        });

        const batch: any[] = res?.body ?? [];
        if (!batch.length) break;

        let done = false;
        for (const raw of batch) {
            const timestamp = new Date(raw.timestamp);
            if (until && timestamp > until) continue;
            if (from && timestamp < from) {
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

        before = batch[batch.length - 1].id;
        await wait();
    }

    return messages;
}

export async function fetchAllDmMessages(
    options: ExportOptions,
    excludedUserIds: Set<string>,
    onProgress?: (count: number) => void,
) {
    await ChannelStore.loadAllGuildAndPrivateChannelsFromDisk();
    const excludedChannelIds = new Set(
        [...excludedUserIds].map(userId => ChannelStore.getDMFromUserId(userId)).filter(Boolean)
    );
    const messagesByChannel = new Map<string, ExportedMessage[]>();
    const messageIds = new Set<string>();
    let cursor: unknown = null;
    let scannedCount = 0;

    do {
        const page = await searchDmMessages(options, cursor);
        for (const channel of page.channels) {
            if (channel.type === ChannelType.DM && channel.recipients?.some(recipient => excludedUserIds.has(recipient.id))) {
                excludedChannelIds.add(channel.id);
            }
        }
        for (const raw of page.messages) {
            if (messageIds.has(raw.id)) continue;
            messageIds.add(raw.id);
            onProgress?.(++scannedCount);
            if (excludedChannelIds.has(raw.channel_id)) continue;
            const messages = messagesByChannel.get(raw.channel_id) ?? [];
            messages.push(formatMessage(raw));
            messagesByChannel.set(raw.channel_id, messages);
        }
        cursor = page.cursor;
        if (cursor && (typeof cursor !== "object" || Object.keys(cursor).length)) await wait();
    } while (cursor && (typeof cursor !== "object" || Object.keys(cursor).length));

    const channels: ExportedDmChannel[] = [];
    for (const [channelId, messages] of messagesByChannel) {
        const channel = ChannelStore.getChannel(channelId) ?? await RestAPI.get({
            url: `/channels/${channelId}`,
            retries: 2,
        }).then(response => response.body).catch(() => ({ id: channelId, type: null }));
        channels.push({
            channel: { id: channelId, name: getChannelName(channel), type: channel.type },
            messageCount: messages.length,
            messages,
        });
    }

    return {
        channels,
        messageCount: channels.reduce((count, channel) => count + channel.messageCount, 0),
    };
}

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

export function downloadJson(data: object, filename: string) {
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
