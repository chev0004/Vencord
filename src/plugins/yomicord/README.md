# Yomicord

A Discord plugin for looking up text while hovering, inspired by the Yomichan browser extension.

## Features

- 🎯 **Smart Text Detection**: Hold Alt (or your chosen key) and hover over any text
- 🇯🇵 **Japanese Text Support**: Intelligently handles hiragana, katakana, and kanji
- 🎨 **Clean UI**: Discord-themed tooltip with smooth animations
- ⚙️ **Configurable**: Choose your scan key (Alt, Ctrl, or Shift)

## Usage

1. **Enable the plugin** in Vencord settings
2. **Hold your scan key** (default: Alt)
3. **Hover over text** in Discord
4. **See the tooltip** appear with the text under your cursor

## How It Works

The plugin uses sophisticated DOM text extraction to:
- Detect text nodes at your cursor position
- Extract surrounding context intelligently
- Handle Japanese text differently from English (longer extraction window)
- Position tooltips smartly to avoid going off-screen

## Configuration

### Scan Key
Choose which key to hold while hovering:
- **Alt** (default) - Most convenient
- **Ctrl** - Alternative option
- **Shift** - Another alternative

## Technical Details

### Files
- `index.tsx` - Main plugin with event handling and tooltip UI
- `textScanner.ts` - Smart text extraction engine
- `styles.css` - Tooltip styling and animations

### Text Extraction
The text scanner:
- Uses `document.caretRangeFromPoint()` for precise cursor detection
- Intelligently expands text selection based on content type
- Detects Japanese characters and applies appropriate extraction rules
- Returns both text and bounding rect for accurate positioning

### Japanese Detection
Detects and handles:
- Hiragana (ひらがな): U+3040-309F
- Katakana (カタカナ): U+30A0-30FF
- Kanji (漢字): U+4E00-9FFF
- Japanese punctuation

## Dictionary Lookup ✅

Now includes **full dictionary support**!

1. Download Yomichan dictionaries from [here](https://github.com/themoeway/jmdict-yomitan)
2. Extract the ZIP and import the `term_bank_*.json` files
3. Start looking up words instantly!

See [DICTIONARY.md](./DICTIONARY.md) for detailed setup instructions.

## Future Plans

- 🔤 Kanji information (readings, radicals, stroke order)
- 📝 Sentence parsing and context
- 🗂️ Dictionary export/backup
- 📱 Anki card creation
- 🔊 Audio pronunciation
- 📊 Frequency indicators

## Credits

Inspired by [Yomichan](https://github.com/FooSoft/yomichan) by FooSoft Productions.

## License

GPL-3.0-or-later
