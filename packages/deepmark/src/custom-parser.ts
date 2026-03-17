/**
 * Custom Markdown parser for translation workflows.
 * This module parses Markdown content, identifies translatable vs. non-translatable sections,
 * protects technical elements (code, URLs, syntax) with placeholders, and reconstructs
 * the Markdown after translation while preserving formatting.
 */

import { isString } from './utils.js';

// Chunk types enum for type safety
const enum ChunkType {
  TEXT_LINE = 'text_line',
  CODE_FENCE = 'code_fence',
  TABLE = 'table',
  FRONTMATTER = 'frontmatter'
}

// Cached regex patterns for performance
const REGEX_PATTERNS = {
  fenceStart: /^(\s*)(```|~~~)(.*)$/,
  frontmatterDelimiter: /^\s*---\s*$/,
  tableSeparator: /^(\|?\s*:?-{3,}:?\s*)+(\|\s*)?$/,
  markdownLink: /(!?\[[^\]]*?\])\(([^)\s]+)(\s+["'][^"']*["'])?\)/g,
  headingMarker: /^(#{1,6}\s+)(.*)$/,
  horizontalRuleStar: /^(\*[\s]*){3,}$/,
  horizontalRuleDash: /^(-[\s]*){3,}$/,
  horizontalRuleUnderscore: /^(_[\s]*){3,}$/,
  listMarker: /^([-*+])$/,
  numberedList: /^\d+([.)])$/,
  taskList: /^([-*+])\s+\[[ xX]\]\s*$/,
  blockquote: /^>\s*$/,
  headingOnly: /^#{1,6}\s*$/,
  purePunctuation: /^[\p{P}\p{S}]+$/u,
  iframeStart: /^\s*<iframe\b/i,
  iframeEnd: /<\/iframe>/i
};

/**
 * Represents a parsed chunk of Markdown content.
 * Chunks can be translatable text, code blocks, tables, or frontmatter.
 */
interface Chunk {
  type: ChunkType | string;
  text: string;                                 // raw text for non-translatable chunks
  payload?: TextLinePayload | TablePayload;     // structured data for translatable chunks
  translatable: boolean;
}

/**
 * Represents a placeholder token that protects content from translation.
 * Used for code spans, URLs, heading markers, and table structure.
 */
interface Placeholder {
  token: string;  // Placeholder token (e.g., '@@CODE_0@@')
  value: string;  // Original content to restore after translation
}

/**
 * Result of parsing Markdown content.
 * Contains chunks and a decoder function to restore placeholders.
 */
interface ParsedResult {
  chunks: Chunk[];                                 // All parsed chunks in order
  decodeTranslatableChunk: (chunk: Chunk) => string; // Restores placeholders in translated text
}

/**
 * Result of protecting inline elements with placeholders.
 */
interface ProtectedResult {
  text: string;              // Text with placeholders replacing protected content
  placeholders: Placeholder[]; // List of placeholders to restore later
}

/**
 * Result of protecting table structure with placeholders.
 * Similar to ProtectedResult but specifically for table cells.
 */
interface TableProtectedResult {
  text: string;              // Table structure with cell content replaced by placeholders
  placeholders: Placeholder[]; // Cell placeholders to restore after translation
}

/**
 * Batch of content prepared for translation.
 * Contains only the translatable strings with metadata to reconstruct the document.
 */
interface PreparedBatch {
  toTranslate: string[];   // Array of strings to send for translation
  chunkIndexes: number[];  // Index mapping to know which chunk each string belongs to
  parsed: ParsedResult;    // Full parsed result for reconstruction
}

/**
 * Payload structure for text line chunks
 */
interface TextLinePayload {
  text: string;
  leadingSpacePlaceholders: Placeholder[];
  headingPlaceholders: Placeholder[];
  htmlCodeTagPlaceholders: Placeholder[];
  urlPlaceholders: Placeholder[];
  codePlaceholders: Placeholder[];
}

/**
 * Payload structure for table chunks
 */
interface TablePayload {
  text: string;
  tablePlaceholders: Placeholder[];
}

/**
 * Union type for all chunk payload types
 */
type ChunkPayload = TextLinePayload | TablePayload;

/**
 * Parses Markdown content into chunks for translation.
 * 
 * This function:
 * 1. Identifies non-translatable sections (frontmatter, code blocks, table structure)
 * 2. Protects inline code, URLs, and heading markers with placeholders
 * 3. Extracts translatable text while preserving document structure
 * 
 * @param md - The Markdown content to parse
 * @returns ParsedResult containing chunks and a decoder function
 */
function parseMarkdownForTranslation(md: string): ParsedResult {
  const lines: string[] = md.split(/\r?\n/);

  const chunks: Chunk[] = [];
  let i: number = 0;

  // State tracking for multi-line structures
  let inFence: boolean = false;
  let fenceMarker: string | null = null;
  let frontmatterDone: boolean = false;

  /** Helper to add a chunk to the chunks array */
  const push = (type: string, text: string, translatable: boolean, payload?: TextLinePayload | TablePayload): void => {
    chunks.push({ type, text, payload, translatable });
  };

  /** Detects the start of a code fence (``` or ~~~) and returns the fence marker */
  const isFenceStart = (line: string): { marker: string } | null => {
    const m = line.match(REGEX_PATTERNS.fenceStart);
    return m ? { marker: m[2] } : null;
  };

  /** Checks if a line is a YAML frontmatter delimiter (---) */
  const isFrontmatterDelimiter = (line: string): boolean => REGEX_PATTERNS.frontmatterDelimiter.test(line);

  /** 
   * Checks if a line is a table separator row (e.g., |---|---|)
   * Allows alignment colons like |:---|---:|
   */
  const isTableSeparatorLine = (line: string): boolean => {
    const s = line.trim();
    if (!s.includes("|") || !s.includes("-")) return false;
    return REGEX_PATTERNS.tableSeparator.test(s);
  };

  /** 
   * Checks if a line looks like a table row (contains pipes)
   * Returns true if line starts/ends with pipe or has multiple pipes
   */
  const looksLikeTableRow = (line: string): boolean => {
    if (!line.includes("|")) return false;
    const t = line.trim();
    const pipeCount = t.split("|").length - 1;
    return t.startsWith("|") || t.endsWith("|") || pipeCount >= 2;
  };

  /**
   * Consumes a complete Markdown table block starting at the given index.
   * A valid table requires: header row, separator row (|---|---|), and at least one data row.
   * 
   * @param startIndex - Line index to start checking for a table
   * @returns Next line index after the table, or null if not a valid table
   */
  const consumeTableBlock = (startIndex: number): { nextIndex: number } | null => {
    let j: number = startIndex;
    if (j + 1 >= lines.length) return null;
    const header = lines[j];
    const sep = lines[j + 1];
    if (!looksLikeTableRow(header) || !isTableSeparatorLine(sep)) return null;

    // Consume all consecutive table rows
    j += 2;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() === "") break;        // Empty line ends table
      if (!looksLikeTableRow(line)) break;   // Non-table row ends table
      j++;
    }

    return { nextIndex: j };
  };

  /**
   * Protects table cell content with placeholders so the table structure isn't translated.
   * Only the cell content is marked for translation, not the pipes and separators.
   * 
   * @param tableLines - The table block lines
   * @returns Protected table structure with cell placeholders
   */
  const protectTableCells = (tableLines: string[]): TableProtectedResult => {
    const placeholders: Placeholder[] = [];
    let cellIdx: number = 0;

    const processRow = (row: string, isSeparator: boolean): string => {
      if (isSeparator) return row; // Don't translate separator row (|---|---|)

      // Split by pipes, handling escaped pipes
      const cells: string[] = row.split(/(?<!\\)\|/);

      return cells.map((cell: string, idx: number): string => {
        // First and last might be empty due to leading/trailing pipes
        if (idx === 0 && cell.trim() === "") return cell;
        if (idx === cells.length - 1 && cell.trim() === "") return cell;

        const trimmed: string = cell.trim();
        if (trimmed === "") return cell;

        const token: string = `@@CELL_${cellIdx}@@`;
        placeholders.push({ token, value: trimmed });
        cellIdx++;

        // Preserve leading/trailing whitespace
        const leadingSpace = cell.match(/^\s*/)?.[0] || "";
        const trailingSpace = cell.match(/\s*$/)?.[0] || "";
        return leadingSpace + token + trailingSpace;
      }).join("|");
    };

    const processedLines: string[] = tableLines.map((line: string, idx: number): string => {
      if (idx === 1) return processRow(line, true); // Separator row
      return processRow(line, false);
    });

    return {
      text: processedLines.join("\n"),  // join here since Table still stores as string in payload
      placeholders
    };
  };

  /**
   * Protects inline code spans from translation by replacing them with placeholders.
   * Handles single backticks (`code`) and multiple backticks (``code with ` inside``).
   * 
   * @param line - Text line to process
   * @returns Line with code spans replaced by @@CODE_N@@ placeholders
   */
  const protectInlineCode = (line: string): ProtectedResult => {
    const placeholders: Placeholder[] = [];
    const parts: string[] = [];
    let segStart = 0;
    let idx = 0;
    let k = 0;

    while (k < line.length) {
      if (line[k] !== "`") { k++; continue; }

      // Count consecutive backticks to handle ``code`` syntax
      let tickCount = 1;
      while (k + tickCount < line.length && line[k + tickCount] === "`") tickCount++;

      const start = k;
      k += tickCount;

      const close = line.indexOf("`".repeat(tickCount), k);
      if (close === -1) {
        // No closing backtick — opening backticks become plain text (included in next segment)
        continue;
      }

      parts.push(line.slice(segStart, start));
      const token = `@@CODE_${idx}@@`;
      placeholders.push({ token, value: line.slice(start, close + tickCount) });
      parts.push(token);
      idx++;
      k = close + tickCount;
      segStart = k;
    }

    if (parts.length === 0) return { text: line, placeholders: [] };
    if (segStart < line.length) parts.push(line.slice(segStart));
    return { text: parts.join(""), placeholders };
  };

  /**
   * Protects Markdown link syntax from translation using XML tag pairs.
   * Wraps [label](url) as <lnkN>label</lnkN> so that:
   *   - The label text IS translated (it is visible text between the tags)
   *   - The opening [ and closing ](url) are opaque placeholders stored in the tag tokens
   *   - Both DeepL (tagHandling:'html') and Google (default format:'html') treat
   *     unknown XML-like tags as non-translatable markup and preserve them exactly.
   * This avoids the two failure modes of @@token@@ style placeholders:
   *   1. Google moving a bracket-like opening token to after the phrase
   *   2. Google dropping a closing token that immediately follows a word character
   * Works for both regular links [text](url) and images ![alt](url).
   *
   * @param line - Text line to process
   * @returns Line with link syntax replaced by <lnkN>label</lnkN> pairs
   */
  const protectLinkUrls = (line: string): ProtectedResult => {
    const placeholders: Placeholder[] = [];
    let idx: number = 0;

    const text: string = line.replace(REGEX_PATTERNS.markdownLink, (_m: string, label: string, url: string, titlePart?: string): string => {
      const openTag  = `<lnk${idx}>`;
      const closeTag = `</lnk${idx}>`;

      const isImage = label.startsWith('!');
      const openBracket = isImage ? '![' : '[';
      const innerLabel = label.slice(openBracket.length, -1); // strip '[' (or '![') and closing ']'

      placeholders.push({ token: openTag,  value: openBracket });
      placeholders.push({ token: closeTag, value: `](${url}${titlePart ?? ''})` });
      idx++;

      return `${openTag}${innerLabel}${closeTag}`;
    });

    return { text, placeholders };
  };

  /**
   * Protects leading spaces from translation by replacing them with @@LEADING_SPACE@@ tokens.
   * Translation services often strip leading whitespace, so each space is replaced with a token
   * that survives the translation round-trip.
   *
   * @param line - Text line to process
   * @returns Line with leading spaces replaced by @@LEADING_SPACE@@ tokens
   */
  const protectLeadingSpaces = (line: string): ProtectedResult => {
    const match = line.match(/^ +/);
    if (!match) return { text: line, placeholders: [] };

    const spaceCount = match[0].length;
    const token = "@@LEADING_SPACE@@";
    return {
      text: token.repeat(spaceCount) + line.slice(spaceCount),
      placeholders: [{ token, value: " " }]
    };
  };

  /**
   * Protects HTML <code> and </code> tags from interfering with translation.
   * DeepL with tagHandling:"html" treats <code> content as non-translatable by default.
   * By replacing the tags with placeholders, the tag boundaries are preserved but the
   * content between them becomes regular translatable text.
   *
   * @param line - Text line to process
   * @returns Line with <code>/<\/code> tags replaced by @@HTML_CODE_TAG_N@@ placeholders
   */
  const protectHtmlCodeTags = (line: string): ProtectedResult => {
    const placeholders: Placeholder[] = [];
    let idx = 0;
    const text = line.replace(/<\/?code>/gi, (match) => {
      const token = `@@HTML_CODE_TAG_${idx++}@@`;
      placeholders.push({ token, value: match });
      return token;
    });
    if (placeholders.length === 0) return { text: line, placeholders: [] };
    return { text, placeholders };
  };

  /**
   * Protects heading markers (# ## ### etc.) from translation.
   * Only the heading content is translated, not the # symbols.
   * 
   * @param line - Text line to process
   * @returns Line with heading marker replaced by @@HEADING_MARKER@@ placeholder
   */
  const protectHeadingMarkers = (line: string): ProtectedResult => {
    const match = line.match(REGEX_PATTERNS.headingMarker);
    if (!match) return { text: line, placeholders: [] };

    const token = "@@HEADING_MARKER@@";
    return {
      text: token + match[2],
      placeholders: [{ token, value: match[1] }]
    };
  };

  /**
   * Restores original content by replacing all placeholder tokens with their values.
   * 
   * @param text - Text containing placeholder tokens
   * @param placeholders - Array of placeholders to restore
   * @returns Text with all placeholders replaced by original values
   */
  const restorePlaceholders = (text: string, placeholders: Placeholder[]): string => {
    if (placeholders.length === 0) return text;
    let out = text;
    for (const p of placeholders) out = out.replaceAll(p.token, p.value);
    return out;
  };

  // Main parsing loop: process each line and identify chunk types
  while (i < lines.length) {
    const line: string = lines[i];

    // Frontmatter detection: YAML frontmatter must start at line 0
    if (!frontmatterDone && i === 0 && isFrontmatterDelimiter(line)) {
      const fmLines: string[] = [line];
      i++;
      while (i < lines.length) {
        fmLines.push(lines[i]);
        if (isFrontmatterDelimiter(lines[i])) {
          i++;
          break;
        }
        i++;
      }
      push(ChunkType.FRONTMATTER, fmLines.join("\n"), false);
      frontmatterDone = true;
      continue;
    }
    frontmatterDone = true;

    // Iframe block (never translated)
    if (REGEX_PATTERNS.iframeStart.test(line)) {
      const iframeLines: string[] = [line];
      if (!REGEX_PATTERNS.iframeEnd.test(line)) {
        i++;
        while (i < lines.length) {
          iframeLines.push(lines[i]);
          if (REGEX_PATTERNS.iframeEnd.test(lines[i])) {
            i++;
            break;
          }
          i++;
        }
      } else {
        i++;
      }
      push('iframe', iframeLines.join("\n"), false);
      continue;
    }

    // Fenced code block
    const fence = isFenceStart(line);
    if (!inFence && fence) {
      inFence = true;
      fenceMarker = fence.marker;

      const codeLines: string[] = [line];
      const fenceCloseRe = new RegExp(`^\\s*${fenceMarker}\\s*$`);
      i++;

      while (i < lines.length) {
        const l: string = lines[i];
        codeLines.push(l);
        if (fenceCloseRe.test(l)) {
          i++;
          break;
        }
        i++;
      }

      push(ChunkType.CODE_FENCE, codeLines.join("\n"), false);
      inFence = false;
      fenceMarker = null;
      continue;
    }

    // Table block (protect structure, translate cells)
    const tableBlock = consumeTableBlock(i);
    if (tableBlock) {
      const tableLines = lines.slice(i, tableBlock.nextIndex);
      const protectedX = protectTableCells(tableLines);
      push(
        ChunkType.TABLE,
        '',
        true,
        { text: protectedX.text, tablePlaceholders: protectedX.placeholders } as TablePayload
      );
      i = tableBlock.nextIndex;
      continue;
    }

    // Normal line, translatable but with leading spaces, heading markers, inline-code + URL placeholders
    const spacesProtected = protectLeadingSpaces(line);
    const headingProtected = protectHeadingMarkers(spacesProtected.text);
    const htmlCodeTagsProtected = protectHtmlCodeTags(headingProtected.text);
    const urlProtected = protectLinkUrls(htmlCodeTagsProtected.text);
    const codeProtected = protectInlineCode(urlProtected.text);

    push(
      ChunkType.TEXT_LINE,
      '',
      true,
      {
        text: codeProtected.text,
        leadingSpacePlaceholders: spacesProtected.placeholders,
        headingPlaceholders: headingProtected.placeholders,
        htmlCodeTagPlaceholders: htmlCodeTagsProtected.placeholders,
        urlPlaceholders: urlProtected.placeholders,
        codePlaceholders: codeProtected.placeholders
      } as TextLinePayload
    );

    i++;
  }

  return {
    chunks,
    decodeTranslatableChunk: (chunk: Chunk): string => {
      const payload = chunk.payload as Partial<TextLinePayload & TablePayload> | undefined;
      if (!payload) return '';
      let t = payload.text ?? "";
      if (payload.leadingSpacePlaceholders?.length) t = restorePlaceholders(t, payload.leadingSpacePlaceholders);
      if (payload.headingPlaceholders?.length) t = restorePlaceholders(t, payload.headingPlaceholders);
      if (payload.htmlCodeTagPlaceholders?.length) t = restorePlaceholders(t, payload.htmlCodeTagPlaceholders);
      if (payload.urlPlaceholders?.length) t = restorePlaceholders(t, payload.urlPlaceholders);
      if (payload.codePlaceholders?.length) t = restorePlaceholders(t, payload.codePlaceholders);
      if (payload.tablePlaceholders?.length) t = restorePlaceholders(t, payload.tablePlaceholders);
      return t;
    }
  };
}

/**
 * Determines if text is technical syntax or empty and should not be translated.
 * This includes:
 * - Empty/whitespace-only strings
 * - Horizontal rules (---, ***, ___)
 * - Standalone list markers (-, *, +, 1., 1))
 * - Task list markers (- [ ], - [x])
 * - Blockquote markers (>)
 * - Heading markers without content (###)
 * - Pure punctuation/symbols (:::, ===, ~~~)
 * 
 * @param text - Text to check
 * @returns true if text should be skipped for translation
 */
function isTechnicalOrEmpty(text: string | null | undefined): boolean {
  if (!isString(text)) return true;
  const t = text.trim();
  if (t === "") return true;
  
  // Horizontal rules: *** --- ___ (optionally spaces between)
  if (REGEX_PATTERNS.horizontalRuleStar.test(t)) return true;
  if (REGEX_PATTERNS.horizontalRuleDash.test(t)) return true;
  if (REGEX_PATTERNS.horizontalRuleUnderscore.test(t)) return true;
  
  // Pure list markers / bullets only: "-", "*", "+", "1.", "1)"
  if (REGEX_PATTERNS.listMarker.test(t)) return true;
  if (REGEX_PATTERNS.numberedList.test(t)) return true;
  
  // Task list marker only: "- [ ]" / "- [x]" / "* [ ]" etc.
  if (REGEX_PATTERNS.taskList.test(t)) return true;
  
  // Blockquote marker only
  if (REGEX_PATTERNS.blockquote.test(t)) return true;
  
  // Heading markers only: "#", "##", "###", etc.
  if (REGEX_PATTERNS.headingOnly.test(t)) return true;
  
  // Pure punctuation/symbols (common "technical" junk like "***", ":::", "===", "~~~")
  if (REGEX_PATTERNS.purePunctuation.test(t)) return true;
  
  return false;
}

/**
 * Prepares a batch of Markdown content for translation.
 * 
 * This function:
 * 1. Parses the Markdown into chunks
 * 2. Filters out non-translatable content (code, frontmatter, technical syntax)
 * 3. Extracts only the translatable strings
 * 4. Returns metadata needed to reconstruct the document after translation
 * 
 * @param md - The Markdown content to prepare
 * @returns PreparedBatch with strings to translate and reconstruction metadata
 */
function getPreparedBatch(md: string): PreparedBatch {
  const parsed = parseMarkdownForTranslation(md);

  // Collect all strings to translate in order, store their chunk indexes
  const toTranslate: string[] = [];
  const chunkIndexes: number[] = [];

  for (let idx = 0; idx < parsed.chunks.length; idx++) {
    const ch = parsed.chunks[idx];
    if (!ch.translatable) continue;

    const payload = ch.payload as Partial<TextLinePayload & TablePayload> | undefined;
    if (!payload) continue;

    // If this is a table chunk, extract and translate cell contents
    if (ch.type === ChunkType.TABLE && payload.tablePlaceholders) {
      for (const placeholder of payload.tablePlaceholders) {
        if (isTechnicalOrEmpty(placeholder.value)) continue;
        toTranslate.push(placeholder.value);
        chunkIndexes.push(idx);
      }
    } else {
      // Strip structural prefix tokens that are always re-added in reconstruction:
      // @@LEADING_SPACE@@ (repeated) and @@HEADING_MARKER@@ never need to cross the
      // translation API boundary — getTranslatedMarkdown restores them regardless.
      let textToTranslate = (payload.text ?? "")
        .replace(/^(?:@@LEADING_SPACE@@)+/, "")
        .replace(/^@@HEADING_MARKER@@/, "");

      if (isTechnicalOrEmpty(textToTranslate)) continue;
      // Skip if no translatable content remains after removing all remaining placeholder tokens
      // (e.g. a line that is purely inline-code or a bare URL becomes only @@CODE_N@@ / @@URL_N@@)
      const textWithoutPlaceholders = textToTranslate.replace(/@@[A-Z_]+(?:_\d+)?@@/g, "");
      if (isTechnicalOrEmpty(textWithoutPlaceholders)) continue;

      toTranslate.push(textToTranslate);
      chunkIndexes.push(idx);
    }
  }

  return { toTranslate, chunkIndexes, parsed };
}

// HTML entity map for decoding (cached at module level)
const HTML_ENTITIES: Record<string, string> = {
  '&#x27;': "'",
  '&#39;': "'",
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
};

const HTML_ENTITY_REGEX = /&#x27;|&#39;|&quot;|&amp;|&lt;|&gt;/g;

/**
 * Decodes common HTML entities that may appear in translated text.
 * Translation services sometimes encode special characters like quotes and ampersands.
 * 
 * @param text - Text potentially containing HTML entities
 * @returns Text with entities decoded to their original characters
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(HTML_ENTITY_REGEX, (match) => HTML_ENTITIES[match] ?? match);
}

/**
 * Reconstructs the Markdown document with translated content.
 * 
 * This function:
 * 1. Decodes any HTML entities in the translated strings
 * 2. Places translated text back into their original chunk positions
 * 3. Restores all protected elements (code, URLs, headings, table structure)
 * 4. Reassembles the complete Markdown document
 * 
 * @param parsed - The original parsed result with chunk structure
 * @param chunkIndexes - Mapping of which chunk each translation belongs to
 * @param translatedArr - Array of translated strings (must match order of toTranslate from getPreparedBatch)
 * @returns Complete Markdown document with translations applied
 */
function getTranslatedMarkdown(parsed: ParsedResult, chunkIndexes: number[], translatedArr?: string[]): string {
    if (!translatedArr?.length) return "";

    // Build a map of chunk index to translations (decode HTML entities inline, single pass)
    const chunkTranslations = new Map<number, string[]>();
    for (let i = 0; i < chunkIndexes.length; i++) {
      const chunkIdx = chunkIndexes[i];
      if (!chunkTranslations.has(chunkIdx)) chunkTranslations.set(chunkIdx, []);
      chunkTranslations.get(chunkIdx)!.push(decodeHtmlEntities(translatedArr[i]));
    }

    // Apply translations to chunks
    for (const [chunkIdx, translations] of chunkTranslations.entries()) {
      const ch = parsed.chunks[chunkIdx];
      const payload = ch.payload as Partial<TextLinePayload & TablePayload> | undefined;
      if (!payload) continue;

      // Handle table chunks - restore all cell translations
      if (ch.type === ChunkType.TABLE && payload.tablePlaceholders) {
        for (let i = 0; i < Math.min(payload.tablePlaceholders.length, translations.length); i++) {
          payload.tablePlaceholders[i].value = translations[i];
        }
      } else {
        // Regular text line - restore placeholders if translation service removed them
        let translatedText = translations[0] ?? payload.text ?? "";
        const originalText = payload.text ?? "";

        // Normalize <lnkN> / </lnkN> tags: translators may alter internal whitespace or casing.
        // Must run before the exact-match restorePlaceholders step.
        if (payload.urlPlaceholders?.length) {
          translatedText = translatedText
            .replace(/<\s*\/\s*lnk\s*(\d+)\s*>/gi, (_, n) => `</lnk${n}>`)
            .replace(/<\s*lnk\s*(\d+)\s*>/gi,      (_, n) => `<lnk${n}>`);

          // Google sometimes shuffles the space that appeared BEFORE an opening link tag
          // to INSIDE the tag: "- <lnk0>text" → "-<lnk0> text"
          // Fix: when a non-space char immediately precedes <lnkN> and whitespace immediately
          // follows it, the space belongs before the tag, not after.
          translatedText = translatedText.replace(/(\S)(<lnk\d+>)\s+/g, '$1 $2');
        }

        // Check if leading space placeholders were stripped by translation service
        if (payload.leadingSpacePlaceholders && payload.leadingSpacePlaceholders.length > 0) {
          const spaceToken = payload.leadingSpacePlaceholders[0].token; // "@@LEADING_SPACE@@"
          const originalLeadingTokens = originalText.match(/^(?:@@LEADING_SPACE@@)+/)?.[0] ?? "";
          if (originalLeadingTokens && !translatedText.startsWith(spaceToken)) {
            translatedText = originalLeadingTokens + translatedText;
          }
        }

        // Check if heading marker placeholder was stripped by translation service
        if (payload.headingPlaceholders && payload.headingPlaceholders.length > 0) {
          const headingToken = payload.headingPlaceholders[0].token;
          if (originalText.startsWith(headingToken) && !translatedText.startsWith(headingToken)) {
            translatedText = headingToken + translatedText;
          }
        }

        payload.text = translatedText;
      }
    }

    // Rebuild markdown by decoding all chunks and restoring placeholders
    const outLines = parsed.chunks.map((ch): string => {
        if (!ch.translatable) return ch.text;
        return parsed.decodeTranslatableChunk(ch);
    });

    return outLines.join("\n");
}

// Export the main API functions for external use
export { getPreparedBatch, getTranslatedMarkdown };