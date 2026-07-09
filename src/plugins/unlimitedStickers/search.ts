/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 chev
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const ROMAJI_TO_HIRA: Record<string, string> = {
    a: "あ", i: "い", u: "う", e: "え", o: "お",
    ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
    ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
    sa: "さ", si: "し", su: "す", se: "せ", so: "そ",
    za: "ざ", zi: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
    ta: "た", ti: "ち", tu: "つ", te: "て", to: "と",
    da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
    na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
    ha: "は", hi: "ひ", hu: "ふ", he: "へ", ho: "ほ",
    ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
    pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
    ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
    ya: "や", yu: "ゆ", yo: "よ",
    ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
    wa: "わ", wo: "を", n: "ん", "n'": "ん",
    shi: "し", chi: "ち", tsu: "つ", fu: "ふ", ji: "じ", vu: "ゔ",
    kya: "きゃ", kyu: "きゅ", kyo: "きょ",
    gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ",
    sha: "しゃ", shu: "しゅ", sho: "しょ", she: "しぇ",
    sya: "しゃ", syu: "しゅ", syo: "しょ",
    ja: "じゃ", ju: "じゅ", jo: "じょ", je: "じぇ",
    jya: "じゃ", jyu: "じゅ", jyo: "じょ",
    zya: "じゃ", zyu: "じゅ", zyo: "じょ",
    cha: "ちゃ", chu: "ちゅ", cho: "ちょ", che: "ちぇ",
    tya: "ちゃ", tyu: "ちゅ", tyo: "ちょ",
    nya: "にゃ", nyu: "にゅ", nyo: "にょ",
    hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ",
    bya: "びゃ", byu: "びゅ", byo: "びょ",
    pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ",
    mya: "みゃ", myu: "みゅ", myo: "みょ",
    rya: "りゃ", ryu: "りゅ", ryo: "りょ",
    fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ",
    va: "ゔぁ", vi: "ゔぃ", ve: "ゔぇ", vo: "ゔぉ",
    "-": "ー",
};

const SOKUON_CONSONANTS = "kgsztdhbpmyrwcfjv";

const katakanaToHiragana = (text: string): string =>
    text.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));

export const romajiToHiragana = (input: string): string => {
    let out = "";
    let i = 0;
    while (i < input.length) {
        const c = input[i];
        if ((c === input[i + 1] && SOKUON_CONSONANTS.includes(c)) || (c === "t" && input[i + 1] === "c")) {
            out += "っ";
            i++;
            continue;
        }
        let matched = false;
        for (const len of [3, 2, 1]) {
            const kana = ROMAJI_TO_HIRA[input.slice(i, i + len)];
            if (kana) {
                out += kana;
                i += len;
                matched = true;
                break;
            }
        }
        if (!matched) {
            out += c;
            i++;
        }
    }
    return out;
};

export const getQueryForms = (query: string): string[] => {
    const hira = katakanaToHiragana(query.toLowerCase());
    const romaji = romajiToHiragana(hira);
    return romaji === hira ? [hira] : [hira, romaji];
};

export const textMatchesForms = (text: string, queryForms: string[]): boolean => {
    const hira = katakanaToHiragana(text.toLowerCase());
    return queryForms.some(form => hira.includes(form));
};
