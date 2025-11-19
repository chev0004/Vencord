# Japanese Text Parsing

## How It Works

The text scanner now properly handles Japanese text by:

### 1. Starting at Cursor Position
Unlike the initial version that expanded in both directions, we now:
- Start exactly where you hover
- Extract **forward only** from the cursor position
- This matches how Japanese is read (left-to-right)

### 2. Stopping at Natural Boundaries

#### Why We DON'T Stop at Particles ⚠️
Many characters that are particles can also be **part of words**:
- `きっと` - the `と` is part of the word (not the particle と)
- `おはよう` - the `は` is part of the word (not the particle は)
- `そんなに` - the `に` is part of the word (not the particle に)

**Solution**: We extract more text and let dictionary lookup decide word boundaries.

#### What We DO Stop At ✅
1. **Punctuation (句読点)**: 、。「」！？
2. **Whitespace**: Spaces, newlines, tabs
3. **Latin characters**: a-z, A-Z, 0-9 (word boundaries)
4. **Max length**: 20 characters (default)

### 3. Word Extraction

For the sentence: **ろんちゃん寝ながら俺に通話かけてくれた**

Hovering at different positions extracts forward from cursor:
- `ろ` → extracts: `ろんちゃん寝ながら俺に通話かけてくれた` (until end/punctuation)
- `寝` → extracts: `寝ながら俺に通話かけてくれた`
- `通` → extracts: `通話かけてくれた`
- `話` → extracts: `話かけてくれた`

**Note**: Without dictionary lookup, we show the full extracted text. Once we add a dictionary, it will try progressively shorter strings to find the actual word:
- Try `通話かけてくれた` → not in dictionary
- Try `通話かけてくれ` → not in dictionary
- Try `通話かけて` → not in dictionary
- Try `通話かけ` → not in dictionary
- Try `通話か` → not in dictionary
- Try `通話` → **Found!** ✓ (phone call)

This is exactly how Yomichan works!

## For Future Dictionary Lookup

### Multiple Candidates
The `getTextCandidates()` function returns multiple lengths:
```typescript
// For hovering on 通話
[
  { text: "通", length: 1 },
  { text: "通話", length: 2 }
]
```

### Dictionary Matching Process
When we add dictionary support:
1. Generate all candidate lengths (1 to 20 characters)
2. Try longest candidate first in dictionary
3. If found → return definition
4. If not found → try next shorter candidate
5. Repeat until match or exhausted

Example lookup for `食べる`:
```
Try: "食べる" → Match! ✓ (to eat)
```

Example lookup for `食べます`:
```
Try: "食べます" → No match
Try: "食べま" → No match  
Try: "食べ" → Match! ✓ (stem of 食べる)
```

## Character Detection

### Japanese Character Ranges
- **Hiragana**: U+3040-309F (ひらがな)
- **Katakana**: U+30A0-30FF (カタカナ)
- **Kanji**: U+4E00-9FFF (漢字)

### Mixed Text Handling
For sentences mixing Japanese and English:
- Japanese text: Extract from cursor forward
- English text: Extract full word (expand both directions)

Example: `I like 寿司 very much`
- Hover `like` → extracts: `like`
- Hover `寿司` → extracts: `寿司`
- Hover `very` → extracts: `very`

## Current Behavior

Without dictionary lookup, we extract a longer string:
- `きっと` → extracts the full text forward from き
- `おはよう` → extracts the full text forward from お
- `通話` → extracts forward from the cursor position

**This is intentional!** Dictionary lookup will find the actual word boundaries by trying progressively shorter strings.

### Why This Approach?
1. ✅ No false negatives (we never cut off too early)
2. ✅ Dictionary determines exact boundaries
3. ✅ Handles all edge cases (particles in words, compounds, etc.)
4. ✅ Same as Yomichan's approach

## Next Steps

1. **Dictionary Integration**: Use JMdict or similar
2. **Better Tokenization**: Optional MeCab integration for perfect boundaries
3. **Context Display**: Show full sentence with word highlighted
4. **Inflection Handling**: Deinflect verbs/adjectives (食べます → 食べる)

