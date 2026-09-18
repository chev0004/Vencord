/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { canonicalizeMatch } from "@utils/patches";
import { ModuleFactory } from "@vencord/discord-types/webpack";
import * as Webpack from "@webpack";
import { wreq } from "@webpack";
import { AnyModuleFactory } from "@webpack/types";

function asyncLimit(concurrency: number) {
    let running = 0;
    type Task = { fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; };
    const pending: Task[] = [];

    function runNext() {
        if (running >= concurrency || pending.length === 0) return;
        running++;
        const task = pending.shift()!;
        task.fn().then(
            val => {
                running--;
                task.resolve(val);
                runNext();
            },
            err => {
                running--;
                task.reject(err);
                runNext();
            }
        );
    }

    return function limit<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            pending.push({
                fn: () => fn() as Promise<unknown>,
                resolve: v => resolve(v as T),
                reject,
            });
            runNext();
        });
    };
}

function getWebpackChunkMap() {
    const sym = Symbol();
    let chunksMap: unknown = null;

    Object.defineProperty(Object.prototype, sym, {
        get() {
            chunksMap = this;
            return "";
        },
        configurable: true
    });

    wreq.u(sym);
    delete Object.prototype[sym];

    return chunksMap as Record<PropertyKey, string> | null;
}

let chunksAlreadyLoaded = false;

export async function loadLazyChunks() {
    const LazyChunkLoaderLogger = new Logger("LazyChunkLoader");

    if (chunksAlreadyLoaded) {
        LazyChunkLoaderLogger.log("Lazy chunks have already been loaded");
        return;
    }

    const limit = asyncLimit(50);
    const workerAssetCache = new Map<string, Promise<boolean>>();
    const WORKER_ASSET_REGEX = /importScripts\(|self\.postMessage/;

    async function isWorkerAsset(url: string, useQueue: boolean = true): Promise<boolean> {
        if (workerAssetCache.has(url)) {
            return workerAssetCache.get(url)!;
        }

        const doFetch = () => {
            return fetch(url)
                .then(r => r.text())
                .then(t => WORKER_ASSET_REGEX.test(t));
        };

        const res = useQueue
            ? limit(doFetch)
            : doFetch();

        workerAssetCache.set(url, res);
        return res;
    }

    try {
        LazyChunkLoaderLogger.log("Loading all chunks...");

        const validChunks = new Set<PropertyKey>();
        const invalidChunks = new Set<PropertyKey>();
        const deferredRequires = new Set<PropertyKey>();

        const { promise: chunkSearchingDone, resolve: chunkSearchingDoneResolve } = Promise.withResolvers<void>();

        let chunkSearchResolvedGetters = [] as Array<() => boolean>;

        const CompleteLazyChunkRegex = canonicalizeMatch(/(?:(?:Promise\.all\(\[)?((?:\i\.e\("?[^)]+?"?\),?)+?)(?:\]\))?)\.then\(\i(?:\.\i)?\.bind\(\i,"?([^)]+?)"?(?:,[^)]+?)?\)\)/g);
        const PartialLazyChunkRegex = canonicalizeMatch(/(?:(?:Promise\.all\(\[)?((?:\i\.e\("?[^)]+?"?\),?)+?)(?:\]\))?)\.then\(\i\.bind\(\i,"?([^)]+?)"?\)\)/g);

        let foundCssDebuggingLoad = false;

        async function searchAndLoadLazyChunks(factoryCode: string) {
            const hasCssDebuggingLoad = foundCssDebuggingLoad = false;

            const lazyChunks = factoryCode.matchAll(hasCssDebuggingLoad ? CompleteLazyChunkRegex : PartialLazyChunkRegex);
            const validChunkGroups = new Set<[chunkIds: PropertyKey[], entryPoint: PropertyKey]>();

            const shouldForceDefer = false;

            await Promise.all(Array.from(lazyChunks).map(async ([, rawChunkIds, entryPoint]) => {
                const chunkIds = rawChunkIds
                    ?.matchAll(Webpack.ChunkIdsRegex)
                    .map(m => {
                        const numChunkId = Number(m[1]);
                        return Number.isNaN(numChunkId) ? m[1] : String(numChunkId);
                    })
                    .toArray()
                    ?? [];

                if (chunkIds.length === 0) {
                    return;
                }

                let invalidChunkGroup = false;

                for (const id of chunkIds) {
                    if (hasCssDebuggingLoad) {
                        if (chunkIds.length > 1) {
                            throw new Error("Found multiple chunks in factory that loads the CSS debugging chunk");
                        }

                        invalidChunks.add(id);
                        invalidChunkGroup = true;
                        break;
                    }

                    if (wreq.u(id) == null || wreq.u(id) === "undefined.js") continue;

                    if (await isWorkerAsset(wreq.p + wreq.u(id))) {
                        invalidChunks.add(id);
                        invalidChunkGroup = true;
                        continue;
                    }

                    validChunks.add(id);
                }

                if (!invalidChunkGroup) {
                    const numEntryPoint = Number(entryPoint);
                    validChunkGroups.add([chunkIds, Number.isNaN(numEntryPoint) ? entryPoint : String(numEntryPoint)]);
                }
            }));

            await Promise.all(
                Array.from(validChunkGroups)
                    .map(([chunkIds]) =>
                        Promise.all(chunkIds.map(id => wreq.e(id)))
                    )
            );

            for (const [, entryPoint] of validChunkGroups) {
                try {
                    if (shouldForceDefer) {
                        deferredRequires.add(entryPoint);
                        continue;
                    }

                    if (wreq.m[entryPoint]) wreq(entryPoint);
                } catch (err) {
                    if (err instanceof TypeError && err.message.includes("reading 'nativeModules'")) {
                        continue;
                    }

                    console.error(err);
                }
            }

            setTimeout(() => {
                chunkSearchResolvedGetters = chunkSearchResolvedGetters.filter(isResolvedGetter => !isResolvedGetter());
                if (chunkSearchResolvedGetters.length === 0) {
                    chunkSearchingDoneResolve();
                }
            }, 0);
        }

        function factoryListener(factory: AnyModuleFactory | ModuleFactory) {
            let isResolved = false;
            searchAndLoadLazyChunks(String(factory))
                .then(() => isResolved = true, () => isResolved = true);

            chunkSearchResolvedGetters.push(() => isResolved);
        }

        Webpack.factoryListeners.add(factoryListener);
        for (const moduleId in wreq.m) {
            factoryListener(wreq.m[moduleId]);
        }

        await chunkSearchingDone;
        Webpack.factoryListeners.delete(factoryListener);

        for (const deferredRequire of deferredRequires) {
            wreq(deferredRequire);
        }

        const chunksMap = getWebpackChunkMap();
        if (!chunksMap) throw new Error("Failed to get chunk map");

        const allChunks = Object.keys(chunksMap);
        if (allChunks.length === 0) throw new Error("Failed to get all chunks");

        const chunksLeft = allChunks.filter(id => {
            return !(validChunks.has(id) || invalidChunks.has(id));
        });

        await Promise.all(chunksLeft.map(async id => limit(async () => {
            const isWorkerFile = await isWorkerAsset(wreq.p + wreq.u(id), false);

            if (!isWorkerFile) {
                await wreq.e(id);
            }
        })));

        LazyChunkLoaderLogger.log("Finished loading all chunks!");
        chunksAlreadyLoaded = true;
    } catch (e) {
        LazyChunkLoaderLogger.log("A fatal error occurred:", e);
    }
}
