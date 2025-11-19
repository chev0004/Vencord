# Dictionary Setup Guide

## Quick Start

1. **Download a Dictionary**
   - Go to: https://github.com/themoeway/jmdict-yomitan
   - Download the latest release (e.g., `JMdict_english.zip`)

2. **Extract the ZIP**
   - Extract the ZIP file to a folder
   - You'll see files like `term_bank_1.json`, `term_bank_2.json`, etc.

3. **Import into Yomicord**
   - Open Vencord Settings → Plugins → Yomicord
   - Scroll down to "Dictionary Management"
   - Enter a name (e.g., "JMdict")
   - Click "Select JSON File(s)"
   - Select **all** the `term_bank_*.json` files (you can select multiple at once!)
   - Wait for import to complete

4. **Start Using**
   - Hold Alt and hover over Japanese text
   - Dictionary definitions will appear automatically!

## Supported Dictionaries

Any Yomichan-compatible dictionary will work:

### Recommended for Japanese
- **JMdict** (English) - Main Japanese-English dictionary
- **JMnedict** - Japanese proper names
- **KANJIDIC** - Kanji information

### Where to Find Dictionaries
- Main repository: https://github.com/themoeway/jmdict-yomitan
- Yomitan wiki: https://github.com/themoeway/yomitan/wiki/Dictionaries

## Dictionary Format

Yomicord uses the standard Yomichan dictionary format:

```json
[
  [
    "食べる",           // term (the word)
    "たべる",           // reading (hiragana)
    "",                 // definition tags
    "",                 // rules
    0,                  // score/priority
    ["to eat"],         // definitions array
    0,                  // sequence
    ""                  // term tags
  ]
]
```

## Managing Dictionaries

### Import Multiple Files
You can import all term_bank files at once:
1. Click "Select JSON File(s)"
2. Hold Ctrl/Cmd and click all `term_bank_*.json` files
3. Click "Open"

### View Installed Dictionaries
The settings page shows all installed dictionaries with their names.

### Delete a Dictionary
Click the "Delete" button next to any dictionary to remove it.

## Storage

Dictionaries are stored in:
- Browser storage (DataStore)
- Indexed by first character for fast lookup
- Persistent across Discord restarts

## Lookup Algorithm

When you hover over text:

1. **Extract Text**: Gets up to 20 characters from cursor position forward
2. **Try Longest First**: Looks up the full extracted text
3. **Progressively Shorter**: If not found, tries shorter strings
4. **First Match Wins**: Returns the first dictionary match found

Example for `通話する`:
```
Try: "通話する" → Not found
Try: "通話す" → Not found  
Try: "通話" → Found! ✓
Returns: "phone call, telephone call"
```

## Settings

### Show Readings
- Toggle to show/hide furigana readings
- Default: On

### Max Definitions
- Number of dictionary entries to show per word
- Default: 3
- Range: 1-10

## Tips

### Large Dictionaries
- JMdict has ~180,000 entries
- Import might take 10-30 seconds
- Once imported, lookups are instant!

### Multiple Dictionaries
- You can install multiple dictionaries
- Results from all dictionaries are combined
- More specialized dictionaries (names, slang) complement the main dictionary

### Backup Dictionaries
- Dictionaries are stored in browser storage
- They persist across sessions
- To backup: no official export yet (coming soon!)

## Troubleshooting

### "No results found"
- Make sure you've imported a dictionary
- Check that the dictionary contains the word
- Try hovering on different parts of the word

### Import Failed
- Make sure you're selecting `term_bank_*.json` files
- Check that files are valid JSON
- Try importing files one at a time

### Slow Performance
- Large dictionaries (JMdict) work great
- If slow, try reducing "Max Definitions" in settings
- Clear old dictionaries you don't use

## Future Features

- [ ] Export dictionaries for backup
- [ ] Dictionary priority/ordering
- [ ] Custom dictionary creation
- [ ] Frequency lists integration
- [ ] Audio pronunciation
- [ ] Example sentences

