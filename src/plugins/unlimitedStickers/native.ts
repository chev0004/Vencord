/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { IpcMainInvokeEvent } from "electron";

const execFileP = promisify(execFile);

export interface OcrRequestImage {
    id: string;
    data: string;
}

export interface OcrResponse {
    results?: Record<string, string>;
    error?: string;
}

const WINDOWS_OCR_SCRIPT = String.raw`
param([string]$Dir, [string]$Out)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation?1' })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new("ja"))
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) {
    [IO.File]::WriteAllText($Out, '{"__error":"No Windows OCR language available"}', [Text.UTF8Encoding]::new($false))
    exit 0
}

$results = @{}
foreach ($f in Get-ChildItem -Path $Dir -Filter *.png) {
    try {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)
        $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $results[$f.BaseName] = $ocr.Text
        $stream.Dispose()
    } catch {
        $results[$f.BaseName] = ""
    }
}

[IO.File]::WriteAllText($Out, ($results | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
`;

const ocrWindows = async (dir: string): Promise<OcrResponse> => {
    const scriptPath = join(dir, "ocr.ps1");
    const outPath = join(dir, "out.json");
    await fs.writeFile(scriptPath, WINDOWS_OCR_SCRIPT, "utf8");

    await execFileP("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-Dir", dir,
        "-Out", outPath,
    ], { timeout: 10 * 60_000 });

    const parsed = JSON.parse(await fs.readFile(outPath, "utf8"));
    if (parsed.__error) return { error: parsed.__error };
    return { results: parsed };
};

const ocrTesseract = async (dir: string, ids: string[]): Promise<OcrResponse> => {
    let available: string[];
    try {
        const { stdout, stderr } = await execFileP("tesseract", ["--list-langs"]);
        available = `${stdout}\n${stderr}`.split("\n").map(l => l.trim()).filter(l => /^[a-z_]+$/.test(l));
    } catch {
        return { error: "tesseract not found. Install tesseract-ocr and tesseract-ocr-jpn." };
    }

    const lang = ["jpn", "eng"].filter(l => available.includes(l)).join("+") || "eng";
    const results: Record<string, string> = {};
    for (const id of ids) {
        try {
            const { stdout } = await execFileP("tesseract", [join(dir, `${id}.png`), "stdout", "-l", lang, "--psm", "6"], { timeout: 30_000 });
            results[id] = stdout.trim();
        } catch {
            results[id] = "";
        }
    }
    return { results };
};

export async function ocrImages(_: IpcMainInvokeEvent, images: OcrRequestImage[]): Promise<OcrResponse> {
    if (images.length === 0) return { results: {} };

    const dir = await fs.mkdtemp(join(tmpdir(), "vencord-sticker-ocr-"));
    try {
        await Promise.all(images.map(img =>
            fs.writeFile(join(dir, `${img.id}.png`), Buffer.from(img.data, "base64"))
        ));
        return process.platform === "win32"
            ? await ocrWindows(dir)
            : await ocrTesseract(dir, images.map(img => img.id));
    } catch (e) {
        return { error: String(e) };
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
