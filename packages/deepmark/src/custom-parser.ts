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
  purePunctuation: /^[\p{P}\p{S}]+$/u
};

/**
 * Represents a parsed chunk of Markdown content.
 * Chunks can be translatable text, code blocks, tables, or frontmatter.
 */
interface Chunk {
  type: ChunkType | string;
  text: string;
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
  chunks: Chunk[];                                     // All parsed chunks in order
  decodeTranslatableChunk: (chunkText: string) => string; // Restores placeholders in translated text
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
  headingPlaceholders: Placeholder[];
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
  const push = (type: string, text: string, translatable: boolean): void => {
    chunks.push({ type, text, translatable });
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
    const pipeCount = (t.match(/\|/g) || []).length;
    return t.startsWith("|") || t.endsWith("|") || pipeCount >= 2;
  };

  /**
   * Consumes a complete Markdown table block starting at the given index.
   * A valid table requires: header row, separator row (|---|---|), and at least one data row.
   * 
   * @param startIndex - Line index to start checking for a table
   * @returns Table block text and next line index, or null if not a valid table
   */
  const consumeTableBlock = (startIndex: number): { block: string; nextIndex: number } | null => {
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

    return { block: lines.slice(startIndex, j).join("\n"), nextIndex: j };
  };

  /**
   * Protects table cell content with placeholders so the table structure isn't translated.
   * Only the cell content is marked for translation, not the pipes and separators.
   * 
   * @param tableBlock - The complete table block as a string
   * @returns Protected table structure with cell placeholders
   */
  const protectTableCells = (tableBlock: string): TableProtectedResult => {
    const tableLines: string[] = tableBlock.split("\n");
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
      text: processedLines.join("\n"),
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
    let out: string = "";
    let idx: number = 0;
    let k: number = 0;

    while (k < line.length) {
      if (line[k] === "`") {
        // Count consecutive backticks to handle ``code`` syntax
        let tickCount: number = 1;
        while (k + tickCount < line.length && line[k + tickCount] === "`") tickCount++;

        const start: number = k;
        k += tickCount;

        const close: number = line.indexOf("`".repeat(tickCount), k);
        if (close === -1) {
          out += line.slice(start, start + tickCount);
          continue;
        }

        const codeSpan: string = line.slice(start, close + tickCount);
        const token: string = `@@CODE_${idx}@@`;
        placeholders.push({ token, value: codeSpan });
        out += token;
        idx++;
        k = close + tickCount;
      } else {
        out += line[k];
        k++;
      }
    }

    return { text: out, placeholders };
  };

  /**
   * Protects URLs in Markdown links from translation.
   * Matches both regular links [text](url) and images ![alt](url).
   * 
   * @param line - Text line to process
   * @returns Line with URLs replaced by @@URL_N@@ placeholders
   */
  const protectLinkUrls = (line: string): ProtectedResult => {
    const placeholders: Placeholder[] = [];
    let idx: number = 0;

    const text: string = line.replace(REGEX_PATTERNS.markdownLink, (_m: string, label: string, url: string, titlePart?: string): string => {
      const token: string = `@@URL_${idx}@@`;
      placeholders.push({ token, value: url });
      idx++;
      return `${label}(${token}${titlePart ?? ""})`;
    });

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

    // Fenced code block
    const fence = isFenceStart(line);
    if (!inFence && fence) {
      inFence = true;
      fenceMarker = fence.marker;

      const codeLines: string[] = [line];
      i++;

      while (i < lines.length) {
        const l: string = lines[i];
        codeLines.push(l);
        if (new RegExp(`^\\s*${fenceMarker}\\s*$`).test(l)) {
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
      const protectedX = protectTableCells(tableBlock.block);
      push(
        ChunkType.TABLE,
        JSON.stringify({
          text: protectedX.text,
          tablePlaceholders: protectedX.placeholders
        } as TablePayload),
        true
      );
      i = tableBlock.nextIndex;
      continue;
    }

    // Normal line, translatable but with heading markers, inline-code + URL placeholders
    const headingProtected = protectHeadingMarkers(line);
    const urlProtected = protectLinkUrls(headingProtected.text);
    const codeProtected = protectInlineCode(urlProtected.text);

    push(
      ChunkType.TEXT_LINE,
      JSON.stringify({
        text: codeProtected.text,
        headingPlaceholders: headingProtected.placeholders,
        urlPlaceholders: urlProtected.placeholders,
        codePlaceholders: codeProtected.placeholders
      } as TextLinePayload),
      true
    );

    i++;
  }

  return {
    chunks,
    decodeTranslatableChunk: (chunkText: string): string => {
      try {
        const payload = JSON.parse(chunkText) as Partial<TextLinePayload & TablePayload>;
        let t = payload.text ?? "";
        t = restorePlaceholders(t, payload.headingPlaceholders ?? []);
        t = restorePlaceholders(t, payload.urlPlaceholders ?? []);
        t = restorePlaceholders(t, payload.codePlaceholders ?? []);
        t = restorePlaceholders(t, payload.tablePlaceholders ?? []);
        return t;
      } catch (error) {
        console.error('Failed to decode chunk:', error);
        return chunkText;
      }
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
  if (!isString(text) || text.trim() === "") return true;
  
  const t = text.trim();
  
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

    try {
      const payload = JSON.parse(ch.text) as Partial<TextLinePayload & TablePayload>;

      // If this is a table chunk, extract and translate cell contents
      if (ch.type === ChunkType.TABLE && payload.tablePlaceholders) {
        for (const placeholder of payload.tablePlaceholders) {
          if (isTechnicalOrEmpty(placeholder.value)) continue;
          toTranslate.push(placeholder.value);
          chunkIndexes.push(idx);
        }
      } else {
        // payload.text contains placeholders (@@CODE_0@@ etc.) which are fine.
        // We decide based on the placeholdered text; if it's only syntax, skip.
        if (isTechnicalOrEmpty(payload.text)) continue;

        toTranslate.push(payload.text ?? "");
        chunkIndexes.push(idx);
      }
    } catch (error) {
      console.error(`Failed to parse chunk at index ${idx}:`, error);
      continue;
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

    // Decode HTML entities that may have been introduced by translation services
    const translatedDecodedArr = translatedArr.map(t => decodeHtmlEntities(t));

    // Put translations back into chunks
    let translationIdx = 0;
    const processedChunks = new Set<number>();

    // Build a map of chunk index to translations for better handling
    const chunkTranslations = new Map<number, string[]>();
    
    for (let i = 0; i < chunkIndexes.length; i++) {
      const chunkIdx = chunkIndexes[i];
      if (!chunkTranslations.has(chunkIdx)) {
        chunkTranslations.set(chunkIdx, []);
      }
      chunkTranslations.get(chunkIdx)!.push(translatedDecodedArr[i]);
    }

    // Apply translations to chunks
    for (const [chunkIdx, translations] of chunkTranslations.entries()) {
      if (processedChunks.has(chunkIdx)) continue;
      
      const ch = parsed.chunks[chunkIdx];
      try {
        const payload = JSON.parse(ch.text) as Partial<TextLinePayload & TablePayload>;

        // Handle table chunks - restore all cell translations
        if (ch.type === ChunkType.TABLE && payload.tablePlaceholders) {
          for (let i = 0; i < Math.min(payload.tablePlaceholders.length, translations.length); i++) {
            payload.tablePlaceholders[i].value = translations[i];
          }
        } else {
          // Regular text line - restore placeholders if translation service removed them
          let translatedText = translations[0] ?? payload.text;
          const originalText = payload.text ?? "";
          
          // Check if heading marker placeholder was stripped by translation service
          if (payload.headingPlaceholders && payload.headingPlaceholders.length > 0) {
            const headingToken = payload.headingPlaceholders[0].token;
            if (originalText.startsWith(headingToken) && !translatedText.startsWith(headingToken)) {
              // Translation service removed the placeholder, add it back
              translatedText = headingToken + translatedText;
            }
          }
          
          payload.text = translatedText;
        }
        
        ch.text = JSON.stringify(payload);
        processedChunks.add(chunkIdx);
      } catch (error) {
        console.error(`Failed to apply translation to chunk ${chunkIdx}:`, error);
      }
    }

    // Rebuild markdown by decoding all chunks and restoring placeholders
    const outLines = parsed.chunks.map((ch): string => {
        if (!ch.translatable) return ch.text;
        return parsed.decodeTranslatableChunk(ch.text);
    });

    return outLines.join("\n");
}

// Export the main API functions for external use
export { getPreparedBatch, getTranslatedMarkdown };