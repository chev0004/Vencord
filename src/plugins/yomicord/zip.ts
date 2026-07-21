/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const EOCD_SIGNATURE = 0x06054B50;
const CENTRAL_DIR_SIGNATURE = 0x02014B50;
const MAX_EOCD_SIZE = 22 + 65535;

export interface ZipEntry {
    name: string;
    text(): Promise<string>;
}

export async function readZipEntries(file: File): Promise<ZipEntry[]> {
    const tailSize = Math.min(file.size, MAX_EOCD_SIZE);
    const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());

    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new Error(`${file.name} is not a valid zip file`);

    const entryCount = tail.getUint16(eocd + 10, true);
    const centralDirSize = tail.getUint32(eocd + 12, true);
    const centralDirOffset = tail.getUint32(eocd + 16, true);

    const centralDir = new DataView(await file.slice(centralDirOffset, centralDirOffset + centralDirSize).arrayBuffer());
    const decoder = new TextDecoder();
    const entries: ZipEntry[] = [];
    let pos = 0;

    for (let i = 0; i < entryCount && pos + 46 <= centralDir.byteLength; i++) {
        if (centralDir.getUint32(pos, true) !== CENTRAL_DIR_SIGNATURE) break;

        const method = centralDir.getUint16(pos + 10, true);
        const compressedSize = centralDir.getUint32(pos + 20, true);
        const nameLength = centralDir.getUint16(pos + 28, true);
        const extraLength = centralDir.getUint16(pos + 30, true);
        const commentLength = centralDir.getUint16(pos + 32, true);
        const localHeaderOffset = centralDir.getUint32(pos + 42, true);
        const name = decoder.decode(new Uint8Array(centralDir.buffer, pos + 46, nameLength));

        entries.push({
            name,
            async text() {
                const localHeader = new DataView(await file.slice(localHeaderOffset, localHeaderOffset + 30).arrayBuffer());
                const dataStart = localHeaderOffset + 30 + localHeader.getUint16(26, true) + localHeader.getUint16(28, true);
                const blob = file.slice(dataStart, dataStart + compressedSize);
                if (method === 0) return blob.text();
                if (method === 8) return new Response(blob.stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
                throw new Error(`Unsupported compression method ${method} for ${name}`);
            }
        });

        pos += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}
