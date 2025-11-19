# Yomicord Implementation Summary

## What Was Built

A Vencord plugin that implements Yomichan-style text scanning for Discord. When you hold the Alt key (configurable) and hover over text, a tooltip appears showing the text you're hovering over.

## Files Created/Modified

### Main Plugin Files
- **index.tsx** - Main plugin entry point with TypeScript/React
- **styles.css** - CSS styling for the tooltip
- **README.md** - Documentation for the plugin

### Ext Folder (Yomichan Code)
The following files from Yomichan were adapted:

#### Core Scanning Files (Modified imports to work standalone)
- **text-scanner.js** - Main text scanning engine
- **text-source-generator.js** - Generates text sources from DOM positions
- **text-source-range.js** - Represents text selections as ranges
- **text-source-element.js** - Represents text from elements
- **document-util.js** - DOM manipulation utilities
- **dom-text-scanner.js** - Low-level text scanning

#### Supporting Files
- **string-util.js** - String processing utilities
- **event-dispatcher.js** - Event handling system
- **log.js** - Logging utilities
- **utilities.js** - General utility functions

#### Created Stubs
- **event-listener-collection.js** - Manages event listeners
- **extension-error.js** - Custom error class

### Import Path Fixes

Updated import statements in the following files to work within the ext folder:
- text-scanner.js - Fixed to import from local ext folder
- text-source-element.js - Fixed string-util import
- text-source-range.js - Removed toError dependency
- dom-text-scanner.js - Fixed string-util import
- utilities.js - Removed toError dependency

Added stub implementations in text-scanner.js for:
- `clone()` - Object cloning function
- `safePerformance` - Performance measurement stubs
- `ThemeController` - Theme detection stub

## How It Works

1. **Plugin Initialization**
   - Creates a `TextSourceGenerator` instance
   - Creates a `TextScanner` instance with configuration
   - Sets up event listeners for mouse movements

2. **Text Scanning**
   - When you hold Alt and hover over text, the scanner activates
   - Uses Yomichan's sophisticated DOM scanning to extract text at the cursor position
   - Handles various edge cases like CSS zoom, shadow DOM, etc.

3. **Tooltip Display**
   - On successful text extraction, shows a tooltip near the cursor
   - Automatically positions to avoid going off-screen
   - Hides when you move away or release the modifier key

## Configuration

Currently supports changing the scan key:
- Alt (default)
- Ctrl
- Shift

## Testing

To test the plugin:

1. Build Vencord with `pnpm build`
2. Enable the Yomicord plugin in settings
3. Navigate to any Discord channel with text
4. Hold down Alt and hover over text
5. A tooltip should appear showing the text under your cursor

Try it with Japanese text for the intended use case:
```
こんにちは世界
日本語のテキスト
漢字を読む
```

## Future Enhancements

The current implementation is a foundation. Possible additions:

1. **Dictionary Integration**
   - Connect to Japanese dictionaries (JMdict, etc.)
   - Show word definitions in the tooltip
   - Support multiple dictionaries

2. **Kanji Information**
   - Stroke order
   - Readings (on'yomi/kun'yomi)
   - Radicals

3. **Sentence Parsing**
   - Show the full sentence context
   - Highlight the word being looked up

4. **Custom Styling**
   - User-configurable colors
   - Font size options
   - Tooltip positioning preferences

5. **Anki Integration**
   - Create flashcards from looked-up words
   - Export to Anki deck

6. **Audio Pronunciation**
   - Play audio for Japanese words
   - Multiple voice options

## Known Limitations

1. Currently only displays the text, no dictionary lookups yet
2. The mock API doesn't perform actual dictionary searches
3. Some advanced Yomichan features are not implemented (popup UI, frequency lists, etc.)

## Code Quality

- No linter errors
- TypeScript types properly defined
- Follows Vencord plugin structure
- Clean separation between UI and scanning logic
- Proper cleanup on plugin disable

## Credits

Based on code from:
- Yomitan Authors (2023-2025)
- Yomichan Authors (2016-2022)

Licensed under GPL-3.0-or-later

