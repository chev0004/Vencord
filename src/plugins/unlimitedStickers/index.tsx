/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/index";
import { Paragraph } from "@components/Paragraph";
import { Devs, IS_MAC } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { ModalCloseButton, ModalContent, ModalHeader, type ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { chooseFile, saveFile } from "@utils/web";
import type { Channel } from "@vencord/discord-types";
import { Alerts, ChannelStore, Checkbox, React, ScrollerThin, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";
import { nanoid } from "nanoid";

import { getPluginIntlMessage } from "./intl";
import { openStickerPicker } from "./StickerPicker";

export const LIBRARY_KEY = "UnlimitedStickers_library";
export const FAVORITES_KEY = "UnlimitedStickers_Favorite_Ids";
export const RECENT_KEY = "UnlimitedStickers_Recent_Ids";
export const STICKER_DATA_KEY_PREFIX = "UnlimitedStickers_Data_";
export const RECENT_LIMIT = 16;
export const FAVORITES_EXPANDED_KEY = "UnlimitedStickers_FavoritesExpanded";
export const RECENT_EXPANDED_KEY = "UnlimitedStickers_RecentExpanded";
export const CATEGORY_ORDER_KEY = "UnlimitedStickers_CategoryOrder";

const STICKER_MAX_BYTES = 512 * 1024;
const STICKER_MAX_DIMENSION = 320;

const logger = new Logger("UnlimitedStickers");

export const getStickerBlob = async (id: string): Promise<Blob | null> => {
    const key = `${STICKER_DATA_KEY_PREFIX}${id}`;
    const data = await DataStore.get<Blob | string>(key);
    if (!data) return null;
    if (typeof data !== "string") return data;
    const blob = await fetch(data).then(r => r.blob());
    await DataStore.set(key, blob);
    return blob;
};

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
});

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers.UnlimitedStickers as PluginNative<typeof import("./native")>
    : null;

const blobToOcrBase64 = async (blob: Blob): Promise<string | null> => {
    try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
        if (!png) return null;
        return (await blobToDataUrl(png)).split(",")[1];
    } catch {
        return null;
    }
};

const OCR_CHUNK_SIZE = 25;

export const scanStickerText = async (): Promise<void> => {
    if (!Native) return;

    const categories = (await DataStore.get<StickerCategory[]>(LIBRARY_KEY)) ?? [];
    const pending = categories.flatMap(c => c.files).filter(f => f.ocrText === undefined);
    if (pending.length === 0) {
        Toasts.show({ message: "All stickers are already scanned.", type: Toasts.Type.MESSAGE, id: Toasts.genId() });
        return;
    }

    Toasts.show({ message: `Scanning text on ${pending.length} sticker${pending.length === 1 ? "" : "s"}...`, type: Toasts.Type.MESSAGE, id: Toasts.genId() });

    let scanned = 0;
    for (let i = 0; i < pending.length; i += OCR_CHUNK_SIZE) {
        const chunk = pending.slice(i, i + OCR_CHUNK_SIZE);
        const images: { id: string; data: string; }[] = [];
        for (const file of chunk) {
            const blob = await getStickerBlob(file.id);
            const data = blob && await blobToOcrBase64(blob);
            if (data) images.push({ id: file.id, data });
        }

        const response = await Native.ocrImages(images);
        if (response.error) {
            Toasts.pop();
            Toasts.show({ message: `Sticker text scan failed: ${response.error}`, type: Toasts.Type.FAILURE, id: Toasts.genId() });
            return;
        }

        const textById = response.results ?? {};
        for (const file of chunk) {
            textById[file.id] ??= "";
        }
        await DataStore.update<StickerCategory[]>(LIBRARY_KEY, (cats = []) =>
            cats.map(cat => ({
                ...cat,
                files: cat.files.map(file =>
                    file.id in textById ? { ...file, ocrText: textById[file.id] } : file
                ),
            }))
        );

        scanned += chunk.length;
        Toasts.pop();
        Toasts.show({ message: `Scanning sticker text... ${scanned}/${pending.length}`, type: Toasts.Type.MESSAGE, id: Toasts.genId() });
    }

    Toasts.pop();
    Toasts.show({ message: `Scanned text on ${pending.length} sticker${pending.length === 1 ? "" : "s"}.`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
};

const normalizeSticker = async (file: File): Promise<Blob | null> => {
    if (/\.(gif|apng)$/i.test(file.name)) {
        return file.size <= STICKER_MAX_BYTES ? file : null;
    }

    try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, STICKER_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
        if (scale === 1 && file.type === "image/png" && file.size <= STICKER_MAX_BYTES) return file;

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
        return blob && blob.size <= STICKER_MAX_BYTES ? blob : null;
    } catch {
        return null;
    }
};

export interface StickerFile {
    id: string;
    name: string;
    tags?: string[];
    ocrText?: string;
}

export interface StickerCategory {
    name: string;
    files: StickerFile[];
}

interface DirectoryInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    webkitdirectory?: string;
}

interface FileWithRelativePath extends File {
    readonly webkitRelativePath: string;
}

const RefreshIcon = ({
    className,
    width = 16,
    height = 16,
}: {
    className?: string;
    width?: number | string;
    height?: number | string;
}) => {
    return (
        <svg
            className={className}
            width={width}
            height={height}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
        </svg>
    );
};

const ReorderIcon = ({
    className,
    width = 16,
    height = 16,
}: {
    className?: string;
    width?: number | string;
    height?: number | string;
}) => {
    return (
        <svg
            className={className}
            width={width}
            height={height}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z" />
        </svg>
    );
};

interface ReorderCategoriesModalProps extends ModalProps {
    categories: StickerCategory[];
    onReorder: (newOrder: string[]) => void;
}

const ReorderCategoriesModal: React.FC<ReorderCategoriesModalProps> = ({ onClose, categories, onReorder, transitionState }) => {
    const [orderedCategories, setOrderedCategories] = React.useState<StickerCategory[]>(categories);
    const [draggedIndex, setDraggedIndex] = React.useState<number | null>(null);

    const handleDragStart = (index: number) => (e: React.DragEvent) => {
        setDraggedIndex(index);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/html", e.currentTarget.outerHTML);
    };

    const handleDragOver = (index: number) => (e: React.DragEvent) => {
        e.preventDefault();
        if (draggedIndex === null || draggedIndex === index) return;

        const newCategories = [...orderedCategories];
        const draggedItem = newCategories[draggedIndex];
        newCategories.splice(draggedIndex, 1);
        newCategories.splice(index, 0, draggedItem);

        setOrderedCategories(newCategories);
        setDraggedIndex(index);
    };

    const handleDragEnd = () => {
        setDraggedIndex(null);
    };

    const handleSave = async () => {
        const newOrder = orderedCategories.map(cat => cat.name);
        await saveCategoryOrder(newOrder);
        onReorder(newOrder);
        onClose();
        Toasts.show({
            message: "Category order saved successfully",
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId()
        });
    };

    const handleReset = () => {
        const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name));
        setOrderedCategories(sorted);
    };

    return (
        <ModalRoot transitionState={transitionState} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Heading tag="h2" className="unlimited-stickers-modal-title">
                    Reorder Categories
                </Heading>
                <ModalCloseButton onClick={onClose} />
            </ModalHeader>
            <ModalContent>
                <Paragraph className="unlimited-stickers-reorder-hint">
                    Drag and drop to reorder your sticker categories. This order will be used in the sticker picker.
                </Paragraph>
                <ScrollerThin className="unlimited-stickers-reorder-list">
                    {orderedCategories.map((category, index) => (
                        <div
                            key={category.name}
                            draggable
                            onDragStart={handleDragStart(index)}
                            onDragOver={handleDragOver(index)}
                            onDragEnd={handleDragEnd}
                            className={classes(
                                "unlimited-stickers-reorder-item",
                                draggedIndex === index && "unlimited-stickers-reorder-item--dragging",
                            )}
                        >
                            <ReorderIcon width={20} height={20} />
                            <span className="unlimited-stickers-reorder-item-name">
                                {category.name}
                            </span>
                            <span className="unlimited-stickers-reorder-item-count">
                                {category.files.length} sticker{category.files.length === 1 ? "" : "s"}
                            </span>
                        </div>
                    ))}
                </ScrollerThin>
            </ModalContent>
            <div className="unlimited-stickers-modal-footer unlimited-stickers-modal-footer--split">
                <Button onClick={handleReset} size="small" variant="secondary">
                    Reset to Alphabetical
                </Button>
                <div className="unlimited-stickers-button-row">
                    <Button onClick={onClose} size="small" variant="secondary">
                        Cancel
                    </Button>
                    <Button onClick={handleSave} size="small" variant="primary">
                        Save Order
                    </Button>
                </div>
            </div>
        </ModalRoot>
    );
};

const StickerManagementSetting: React.FC = () => {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const [categories, setCategories] = React.useState<StickerCategory[]>([]);
    const [selectedCategories, setSelectedCategories] = React.useState<Set<string>>(new Set());
    const [loading, setLoading] = React.useState(true);

    const fetchCategories = async () => {
        setLoading(true);
        const cats = (await DataStore.get<StickerCategory[]>(LIBRARY_KEY)) ?? [];
        const order = await getCategoryOrder();
        const orderedCats = applyCategoryOrder(cats, order);
        setCategories(orderedCats);
        setLoading(false);
    };

    const handleOpenReorderModal = () => {
        openModal((props: ModalProps) => (
            <ReorderCategoriesModal
                {...props}
                categories={categories}
                onReorder={() => fetchCategories()}
            />
        ));
    };

    React.useEffect(() => {
        fetchCategories();
    }, []);

    const handleSelectionChange = (categoryName: string) => {
        const newSelection = new Set(selectedCategories);
        if (newSelection.has(categoryName)) {
            newSelection.delete(categoryName);
        } else {
            newSelection.add(categoryName);
        }
        setSelectedCategories(newSelection);
    };

    const handleSelectAll = () => {
        setSelectedCategories(new Set(categories.map(c => c.name)));
    };

    const handleDeselectAll = () => {
        setSelectedCategories(new Set());
    };

    const handleFolderUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const { files } = event.target;
        if (!files || files.length === 0) return;

        Toasts.show({ message: `Processing ${files.length} files...`, id: Toasts.genId(), type: Toasts.Type.MESSAGE });

        const filesByDir = new Map<string, File[]>();
        for (const file of Array.from(files)) {
            if (!/\.(png|apng|gif|jpe?g)$/i.test(file.name)) continue;

            const path = (file as FileWithRelativePath).webkitRelativePath;
            const parts = path.split("/");
            const dirName = parts.length > 1 ? parts[parts.length - 2] : "Uploaded Stickers";

            let dirFiles = filesByDir.get(dirName);
            if (!dirFiles) {
                dirFiles = [];
                filesByDir.set(dirName, dirFiles);
            }
            dirFiles.push(file);
        }

        if (filesByDir.size === 0) {
            Toasts.show({ message: "No supported image files found in the selected folder(s).", id: Toasts.genId(), type: Toasts.Type.FAILURE });
            return;
        }

        const newCategories: StickerCategory[] = [];
        const stickerDataToSave: [string, Blob][] = [];
        const skipped: string[] = [];

        for (const [categoryName, categoryFiles] of filesByDir.entries()) {
            const stickerFiles: StickerFile[] = [];
            for (const file of categoryFiles) {
                const blob = await normalizeSticker(file);
                if (!blob) {
                    skipped.push(file.name);
                    continue;
                }
                const newId = nanoid();
                stickerDataToSave.push([`${STICKER_DATA_KEY_PREFIX}${newId}`, blob]);
                stickerFiles.push({ id: newId, name: file.name.replace(/\.[^/.]+$/, "") });
            }
            if (stickerFiles.length > 0) {
                newCategories.push({ name: categoryName, files: stickerFiles });
            }
        }

        if (skipped.length > 0) {
            Toasts.show({
                message: `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} (unreadable or over 512KB): ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`,
                type: Toasts.Type.FAILURE,
                id: Toasts.genId(),
            });
        }

        if (stickerDataToSave.length === 0) {
            if (event.target) event.target.value = "";
            return;
        }

        await DataStore.setMany(stickerDataToSave);

        await DataStore.update<StickerCategory[]>(LIBRARY_KEY, (existingData = []) => {
            for (const newCategory of newCategories) {
                const existingCategory = existingData.find(c => c.name === newCategory.name);
                if (existingCategory) {
                    const existingNames = new Set(existingCategory.files.map(f => f.name));
                    const uniqueNewFiles = newCategory.files.filter(f => !existingNames.has(f.name));
                    existingCategory.files.push(...uniqueNewFiles);
                } else {
                    existingData.push(newCategory);
                }
            }
            return existingData;
        });

        const totalStickers = stickerDataToSave.length;
        Toasts.show({ message: `Added ${totalStickers} stickers across ${newCategories.length} categories.`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
        if (event.target) event.target.value = "";
        fetchCategories();
        scanStickerText().catch(e => logger.error("Sticker text scan failed:", e));
    };

    const deleteStickerData = async (stickerIds: string[]) => {
        await DataStore.delMany(stickerIds.map(id => `${STICKER_DATA_KEY_PREFIX}${id}`));
    };

    const handleBatchDelete = async (categoryNames: string[]) => {
        const deletedStickerIds: string[] = [];
        const categoriesToDelete = categories.filter(cat => categoryNames.includes(cat.name));
        for (const cat of categoriesToDelete) {
            deletedStickerIds.push(...cat.files.map(f => f.id));
        }
        const totalStickers = deletedStickerIds.length;

        Toasts.show({
            message: `Deleting ${categoryNames.length} categor${categoryNames.length === 1 ? "y" : "ies"} and ${totalStickers} sticker${totalStickers === 1 ? "" : "s"}...`,
            type: Toasts.Type.MESSAGE,
            id: Toasts.genId(),
        });

        const remainingCategories = categories.filter(cat => {
            if (categoryNames.includes(cat.name)) {
                return false;
            }
            return true;
        });

        await deleteStickerData(deletedStickerIds);
        await DataStore.set(LIBRARY_KEY, remainingCategories);
        await pruneCategoryOrder(remainingCategories.map(c => c.name));

        await DataStore.update<string[]>(FAVORITES_KEY, (favs = []) => favs.filter(id => !deletedStickerIds.includes(id)));
        await DataStore.update<string[]>(RECENT_KEY, (recents = []) => recents.filter(id => !deletedStickerIds.includes(id)));

        Toasts.pop();
        Toasts.show({ message: `Deleted ${categoryNames.length} categor${categoryNames.length === 1 ? "y" : "ies"} and their stickers.`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
        fetchCategories();
        setSelectedCategories(new Set());
    };

    const handleDeleteSelected = () => {
        if (selectedCategories.size === 0) return;
        Alerts.show({
            title: "Delete Selected Categories",
            body: `Are you sure you want to delete ${selectedCategories.size} selected categories and all their stickers? This cannot be undone.`,
            confirmText: "Delete",
            cancelText: "Cancel",
            onConfirm: () => handleBatchDelete(Array.from(selectedCategories))
        });
    };

    const clearAllStickers = () => {
        Alerts.show({
            title: "Clear All Stickers",
            body: "Are you sure you want to delete all your uploaded stickers? This cannot be undone.",
            confirmText: "Delete",
            cancelText: "Cancel",
            onConfirm: () => handleBatchDelete(categories.map(c => c.name))
        });
    };

    const inputProps: DirectoryInputProps = {
        type: "file",
        webkitdirectory: "",
        style: { display: "none" },
        onChange: handleFolderUpload,
    };

    return (
        <div>
            <input ref={fileInputRef} {...inputProps} />
            <div className="unlimited-stickers-manage-buttons">
                <Button onClick={() => fileInputRef.current?.click()} size="small">
                    Upload Sticker Folder(s)
                </Button>
                <Button onClick={() => importStickers(fetchCategories)} size="small" variant="primary">
                    Import
                </Button>
                <Button onClick={() => exportStickers()} size="small" variant="primary">
                    Export All
                </Button>
                <Button onClick={() => exportStickers(Array.from(selectedCategories))} size="small" variant="primary" disabled={selectedCategories.size === 0}>
                    Export Selected
                </Button>
                <Button onClick={handleDeleteSelected} size="small" variant="dangerPrimary" disabled={selectedCategories.size === 0}>
                    Delete Selected
                </Button>
                <Button onClick={clearAllStickers} size="small" variant="dangerPrimary" disabled={categories.length === 0}>
                    Delete All
                </Button>
                <Button onClick={handleOpenReorderModal} size="small" variant="secondary" disabled={categories.length === 0}>
                    Reorder Categories
                </Button>
                {IS_DISCORD_DESKTOP && (
                    <Button
                        onClick={() => scanStickerText().catch(e => logger.error("Sticker text scan failed:", e))}
                        size="small"
                        variant="secondary"
                        disabled={categories.length === 0}
                    >
                        Scan Sticker Text
                    </Button>
                )}
                <Button onClick={fetchCategories} size="small" variant="secondary" style={{ padding: "4px 8px" }}>
                    <RefreshIcon width={16} height={16} />
                </Button>
            </div>
            {!loading && categories.length > 0 && (
                <div className="unlimited-stickers-selection-buttons">
                    <Button onClick={handleSelectAll} size="small" variant="secondary">
                        Select All
                    </Button>
                    <Button onClick={handleDeselectAll} size="small" variant="secondary">
                        Deselect All
                    </Button>
                </div>
            )}
            {loading ? (
                <Paragraph>Loading categories...</Paragraph>
            ) : categories.length > 0 ? (
                <ScrollerThin className="unlimited-stickers-manage-list">
                    {categories.map(category => (
                        <div key={category.name} className="unlimited-stickers-manage-row">
                            <Checkbox value={selectedCategories.has(category.name)} onChange={() => handleSelectionChange(category.name)} />
                            <span>{category.name} ({category.files.length} stickers)</span>
                            <Button size="min" variant="dangerSecondary" onClick={() => Alerts.show({
                                title: `Delete ${category.name}`,
                                body: `Are you sure you want to delete the "${category.name}" category and all its stickers? This cannot be undone.`,
                                onConfirm: () => handleBatchDelete([category.name]),
                                confirmText: "Delete"
                            })}>Delete</Button>
                        </div>
                    ))}
                </ScrollerThin>
            ) : (
                <Paragraph>
                    Upload folders containing your stickers. Each folder will become a category.
                    <br />
                    <br />
                    You can also import a previously exported sticker collection using the "Import" button above.
                </Paragraph>
            )}
        </div>
    );
};

export const settings = definePluginSettings({
    stickerManagement: {
        type: OptionType.COMPONENT,
        component: StickerManagementSetting,
        description: "Upload and manage your local stickers.",
    },
}).withPrivateSettings<{
    stickerGuildId: string | null;
    stickerSlotId: string | null;
    accountGuilds: Record<string, { guildId: string; slotId: string | null; }>;
}>();

export const getFavorites = async (): Promise<string[]> => {
    return (await DataStore.get<string[]>(FAVORITES_KEY)) ?? [];
};

export const saveFavorites = async (favorites: string[]): Promise<void> => {
    await DataStore.set(FAVORITES_KEY, favorites);
};

export const getRecentStickers = async (): Promise<string[]> => {
    return (await DataStore.get<string[]>(RECENT_KEY)) ?? [];
};

export const addRecentSticker = async (stickerId: string): Promise<void> => {
    await DataStore.update<string[]>(RECENT_KEY, (recents = []) => {
        const index = recents.indexOf(stickerId);
        if (index > -1) {
            recents.splice(index, 1);
        }
        recents.unshift(stickerId);
        if (recents.length > RECENT_LIMIT) {
            recents.length = RECENT_LIMIT;
        }
        return recents;
    });
};

export const getExpansionState = async (key: string): Promise<boolean> => {
    return (await DataStore.get<boolean>(key)) ?? true;
};

export const saveExpansionState = async (
    key: string,
    isExpanded: boolean,
): Promise<void> => {
    await DataStore.set(key, isExpanded);
};

export const getCategoryOrder = async (): Promise<string[]> => {
    return (await DataStore.get<string[]>(CATEGORY_ORDER_KEY)) ?? [];
};

export const saveCategoryOrder = async (order: string[]): Promise<void> => {
    await DataStore.set(CATEGORY_ORDER_KEY, order);
};

export const renameCategoryOrder = async (oldName: string, newName: string): Promise<void> => {
    await DataStore.update<string[]>(CATEGORY_ORDER_KEY, (order = []) =>
        order.map(name => name === oldName ? newName : name)
    );
};

export const pruneCategoryOrder = async (existingNames: string[]): Promise<void> => {
    const names = new Set(existingNames);
    await DataStore.update<string[]>(CATEGORY_ORDER_KEY, (order = []) =>
        order.filter(name => names.has(name))
    );
};

export const applyCategoryOrder = (categories: StickerCategory[], customOrder: string[]): StickerCategory[] => {
    if (customOrder.length === 0) {
        return [...categories].sort((a, b) => a.name.localeCompare(b.name));
    }

    const orderMap = new Map(customOrder.map((name, index) => [name, index]));
    const sorted = [...categories].sort((a, b) => {
        const aIndex = orderMap.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = orderMap.get(b.name) ?? Number.MAX_SAFE_INTEGER;

        if (aIndex !== Number.MAX_SAFE_INTEGER || bIndex !== Number.MAX_SAFE_INTEGER) {
            return aIndex - bIndex;
        }

        return a.name.localeCompare(b.name);
    });

    return sorted;
};

interface StickerExportData {
    version: string;
    categories: StickerCategory[];
    stickerData: Record<string, string>;
    favorites: string[];
}

const ImportSelectionModal: React.FC<ModalProps & { importData: StickerExportData; onImported?: () => void; }> = ({ onClose, transitionState, importData, onImported }) => {
    const [selectedCategories, setSelectedCategories] = React.useState<Set<string>>(
        new Set(importData.categories.map(c => c.name))
    );

    const handleSelectionChange = (categoryName: string) => {
        const newSelection = new Set(selectedCategories);
        if (newSelection.has(categoryName)) {
            newSelection.delete(categoryName);
        } else {
            newSelection.add(categoryName);
        }
        setSelectedCategories(newSelection);
    };

    const handleSelectAll = () => {
        setSelectedCategories(new Set(importData.categories.map(c => c.name)));
    };

    const handleDeselectAll = () => {
        setSelectedCategories(new Set());
    };

    const handleImport = async () => {
        onClose();

        const categoriesToImport = importData.categories.filter(c => selectedCategories.has(c.name));
        const totalFiles = categoriesToImport.reduce((sum, cat) => sum + cat.files.length, 0);

        Toasts.show({
            message: `Importing ${selectedCategories.size} categor${selectedCategories.size === 1 ? "y" : "ies"} and ${totalFiles} file${totalFiles === 1 ? "" : "s"}...`,
            type: Toasts.Type.MESSAGE,
            id: Toasts.genId(),
        });

        try {
            const selectedStickerIds = new Set<string>();
            for (const category of categoriesToImport) {
                for (const file of category.files) {
                    selectedStickerIds.add(file.id);
                }
            }

            const idMapping = new Map<string, string>();
            for (const id of selectedStickerIds) {
                if (!idMapping.has(id)) {
                    idMapping.set(id, nanoid());
                }
            }

            const importedCategories: StickerCategory[] = categoriesToImport.map(category => ({
                name: category.name,
                files: category.files.map(file => ({
                    id: idMapping.get(file.id)!,
                    name: file.name,
                    tags: file.tags,
                    ocrText: file.ocrText,
                })),
            }));

            const stickerEntries: [string, Blob][] = [];
            for (const oldId of selectedStickerIds) {
                const base64 = importData.stickerData[oldId];
                const newId = idMapping.get(oldId);
                if (base64 && newId) {
                    stickerEntries.push([`${STICKER_DATA_KEY_PREFIX}${newId}`, await fetch(base64).then(r => r.blob())]);
                }
            }
            await DataStore.setMany(stickerEntries);

            await DataStore.update<StickerCategory[]>(LIBRARY_KEY, (existingData = []) => {
                const result = [...existingData];
                for (const importedCategory of importedCategories) {
                    const existingCategory = result.find(c => c.name === importedCategory.name);
                    if (existingCategory) {
                        const existingNames = new Set(existingCategory.files.map(f => f.name));
                        const uniqueNewFiles = importedCategory.files.filter(f => !existingNames.has(f.name));
                        existingCategory.files.push(...uniqueNewFiles);
                    } else {
                        result.push(importedCategory);
                    }
                }
                return result;
            });

            if (importData.favorites && importData.favorites.length > 0) {
                const newFavoriteIds = importData.favorites
                    .filter(oldId => selectedStickerIds.has(oldId))
                    .map(oldId => idMapping.get(oldId))
                    .filter((id): id is string => id !== undefined);

                if (newFavoriteIds.length > 0) {
                    await DataStore.update<string[]>(FAVORITES_KEY, (existingFavorites = []) => {
                        const combined = new Set([...existingFavorites, ...newFavoriteIds]);
                        return Array.from(combined);
                    });
                }
            }

            const totalFavorites = importData.favorites?.filter(id => selectedStickerIds.has(id)).length ?? 0;

            Toasts.pop();
            Toasts.show({
                message: `Imported ${selectedCategories.size} categor${selectedCategories.size === 1 ? "y" : "ies"} with ${totalFiles} sticker${totalFiles === 1 ? "" : "s"}${totalFavorites > 0 ? ` and ${totalFavorites} favorite${totalFavorites === 1 ? "" : "s"}` : ""}.`,
                type: Toasts.Type.SUCCESS,
                id: Toasts.genId(),
            });
            onImported?.();
        } catch (error) {
            logger.error("Failed to import selected stickers:", error);
            Toasts.pop();
            Toasts.show({
                message: `Failed to import stickers: ${error instanceof Error ? error.message : String(error)}`,
                type: Toasts.Type.FAILURE,
                id: Toasts.genId(),
            });
        }
    };

    return (
        <ModalRoot transitionState={transitionState} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Heading tag="h2" className="unlimited-stickers-modal-title">
                    Select Categories to Import
                </Heading>
                <ModalCloseButton onClick={onClose} />
            </ModalHeader>
            <ModalContent>
                <div className="unlimited-stickers-import-wrapper">
                    <div className="unlimited-stickers-selection-buttons">
                        <Button onClick={handleSelectAll} size="small" variant="secondary">
                            Select All
                        </Button>
                        <Button onClick={handleDeselectAll} size="small" variant="secondary">
                            Deselect All
                        </Button>
                    </div>
                    <ScrollerThin className="unlimited-stickers-import-list">
                        {importData.categories.map(category => (
                            <div key={category.name} className="unlimited-stickers-manage-row unlimited-stickers-manage-row--bright">
                                <Checkbox
                                    value={selectedCategories.has(category.name)}
                                    onChange={() => handleSelectionChange(category.name)}
                                />
                                <span>
                                    {category.name} ({category.files.length} sticker{category.files.length === 1 ? "" : "s"})
                                </span>
                            </div>
                        ))}
                    </ScrollerThin>
                </div>
            </ModalContent>
            <div className="unlimited-stickers-modal-footer">
                <Button onClick={onClose} size="small" variant="secondary">
                    Cancel
                </Button>
                <Button onClick={handleImport} size="small" variant="primary" disabled={selectedCategories.size === 0}>
                    Import Selected ({selectedCategories.size})
                </Button>
            </div>
        </ModalRoot>
    );
};

export const exportStickers = async (categoryNames?: string[]): Promise<void> => {
    try {
        const allCategories = (await DataStore.get<StickerCategory[]>(LIBRARY_KEY)) ?? [];
        const categories = categoryNames
            ? allCategories.filter(c => categoryNames.includes(c.name))
            : allCategories;
        const favorites = await getFavorites();

        const stickerIds = new Set<string>();
        for (const category of categories) {
            for (const file of category.files) {
                stickerIds.add(file.id);
            }
        }
        const totalCategories = categories.length;
        const totalStickers = stickerIds.size;

        Toasts.show({
            message: `Exporting ${totalCategories} categor${totalCategories === 1 ? "y" : "ies"} and ${totalStickers} sticker${totalStickers === 1 ? "" : "s"}...`,
            type: Toasts.Type.MESSAGE,
            id: Toasts.genId(),
        });

        const ids = Array.from(stickerIds);
        const values = await DataStore.getMany<Blob | string>(ids.map(id => `${STICKER_DATA_KEY_PREFIX}${id}`));
        const stickerData: Record<string, string> = {};
        await Promise.all(ids.map(async (id, i) => {
            const value = values[i];
            if (!value) return;
            stickerData[id] = typeof value === "string" ? value : await blobToDataUrl(value);
        }));

        const exportData: StickerExportData = {
            version: "1.0",
            categories,
            stickerData,
            favorites: favorites.filter(id => stickerIds.has(id)),
        };

        const json = JSON.stringify(exportData, null, 2);
        const data = new TextEncoder().encode(json);
        const filename = `unlimited-stickers-export-${new Date().toISOString().split("T")[0]}.json`;

        if (IS_DISCORD_DESKTOP) {
            await DiscordNative.fileManager.saveWithDialog(data, filename);
        } else {
            saveFile(new File([data], filename, { type: "application/json" }));
        }

        Toasts.pop();
        Toasts.show({
            message: `Exported ${totalCategories} categor${totalCategories === 1 ? "y" : "ies"} with ${totalStickers} sticker${totalStickers === 1 ? "" : "s"}.`,
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
        });
    } catch (error) {
        logger.error("Failed to export stickers:", error);
        Toasts.show({
            message: "Failed to export stickers. Check console for details.",
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
        });
    }
};

export const importStickers = async (onImported?: () => void): Promise<void> => {
    try {
        let jsonData: string;

        if (IS_DISCORD_DESKTOP) {
            const [file] = await DiscordNative.fileManager.openFiles({
                filters: [
                    { name: "Unlimited Stickers Export", extensions: ["json"] },
                    { name: "all", extensions: ["*"] }
                ]
            });

            if (!file) return;

            jsonData = new TextDecoder().decode(file.data);
        } else {
            const file = await chooseFile("application/json");
            if (!file) return;

            jsonData = await file.text();
        }

        const importData = JSON.parse(jsonData) as StickerExportData;

        if (!importData.version || !importData.categories || !importData.stickerData) {
            throw new Error("Invalid export file format");
        }

        openModal((props: ModalProps) => (
            <ImportSelectionModal {...props} importData={importData} onImported={onImported} />
        ));
    } catch (error) {
        logger.error("Failed to open import selection:", error);
        Toasts.show({
            message: `Failed to open import selection: ${error instanceof Error ? error.message : String(error)}`,
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
        });
    }
};

const UnlimitedStickerIcon = ({
    className,
    width = 20,
    height = 20,
}: {
    className?: string;
    width?: number | string;
    height?: number | string;
}) => {
    return (
        <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            xmlnsXlink="http://www.w3.org/1999/xlink"
            viewBox="0 0 24 24"
            width={width}
            height={height}
            className={className}
        >
            <defs>
                <clipPath id="c">
                    <path d="M0 0h24v24H0z" />
                </clipPath>
                <clipPath id="d">
                    <path d="M0 0h600v600H0z" />
                </clipPath>
                <filter id="a" filterUnits="objectBoundingBox" x="0%" y="0%" width="100%" height="100%">
                    <feComponentTransfer in="SourceGraphic">
                        <feFuncA type="table" tableValues="1.0 0.0" />
                    </feComponentTransfer>
                </filter>
                <path
                    fill="currentColor"
                    d="M-5.5-2a1.5 1.5 0 1 0-.001-3.001A1.5 1.5 0 0 0-5.5-2M7-3.5a1.5 1.5 0 1 1-3.001-.001A1.5 1.5 0 0 1 7-3.5M-2.911-.556A1.001 1.001 0 0 0-4.573.556 5.5 5.5 0 0 0 0 3 5.5 5.5 0 0 0 4.573.556 1 1 0 1 0 2.911-.556 3.5 3.5 0 0 1 0 1 3.5 3.5 0 0 1-2.911-.556"
                    transform="matrix(25 0 0 25 300 300)"
                    style={{ display: "block" }}
                    id="b"
                />
                <mask id="e" style={{ maskType: "alpha" }}>
                    <g filter="url(#a)">
                        <path fill="#fff" opacity="0" d="M0 0h600v600H0z" />
                        <use href="#b" />
                    </g>
                </mask>
            </defs>
            <g clipPath="url(#c)">
                <g clipPath="url(#d)" transform="rotate(.012) scale(.04)" style={{ display: "block" }}>
                    <g mask="url(#e)" style={{ display: "block" }}>
                        <path
                            fill="currentColor"
                            d="M150 50h300a100 100 0 0 1 100 100v187.5a12.5 12.5 0 0 1-12.5 12.5H475a125 125 0 0 0-125 125v62.5a12.5 12.5 0 0 1-12.5 12.5H150A100 100 0 0 1 50 450V150A100 100 0 0 1 150 50"
                        />
                    </g>
                    <g transform="translate(355 355) scale(10)">
                        <path
                            d="m8.121 9.879 2.083 2.083.007-.006 1.452 1.452.006.006 2.122 2.122a5 5 0 1 0 0-7.072l-.714.714 1.415 1.414.713-.713a3 3 0 1 1 0 4.242l-2.072-2.072-.007.006-3.59-3.59a5 5 0 1 0 0 7.07l.713-.713-1.414-1.414-.714.713a3 3 0 1 1 0-4.242"
                            fill="currentColor"
                        />
                    </g>
                </g>
            </g>
        </svg>
    );
};

const openPickerIfNitro = (channel: Channel) => {
    if (UserStore.getCurrentUser()?.premiumType) {
        openStickerPicker(channel);
    } else {
        Toasts.show({
            message: getPluginIntlMessage("NITRO_REQUIRED_BODY"),
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE,
        });
    }
};

export const UnlimitedStickersChatBarIcon: ChatBarButtonFactory = props => {
    const channel = ChannelStore.getChannel(props.channel.id);
    if (!channel || props.disabled) return null;

    return (
        <ChatBarButton
            tooltip={getPluginIntlMessage("OPEN_LOCAL_STICKER_PICKER")}
            onClick={() => openPickerIfNitro(channel)}
        >
            <UnlimitedStickerIcon width={20} height={20} />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "UnlimitedStickers",
    description:
        "Send local images as stickers by temporarily uploading them to a private server.",
    authors: [Devs.chev],
    settings,
    chatBarButton: {
        render: UnlimitedStickersChatBarIcon,
        icon: UnlimitedStickerIcon,
    },

    onKey(e: KeyboardEvent) {
        const mod = IS_MAC ? e.metaKey : e.ctrlKey;
        if (mod && e.altKey && e.key.toLowerCase() === "s") {
            e.preventDefault();
            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId) return;

            const channel = ChannelStore.getChannel(channelId);
            if (!channel) return;

            openPickerIfNitro(channel);
        }
    },

    start() {
        document.addEventListener("keydown", this.onKey);
    },

    stop() {
        document.removeEventListener("keydown", this.onKey);
    },
});
