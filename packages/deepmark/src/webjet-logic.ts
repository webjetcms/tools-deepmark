import { extractMdastStrings } from "./extract.js";
import { translate } from "./translate.js";
import np from "node:path";

/**
 * Retrieves the configuration file path.
 * If Widows is detect sanitizes the slashes and adds the file:// prefix (if missing).
 * 
 * @param {String} path - The path to the configuration file. If not provided, the default path "deepmark.config.mjs" will be used.
 * @returns {String} The resolved configuration file path.
 */
export async function getConfigFilePath(path: string, doWindowsEdit = false) {
    let configFilePathTmp = path ? path.startsWith("/") ? path : np.resolve(process.cwd(), path) : np.resolve(process.cwd(), "deepmark.config.mjs");
  
    //Detect Windows OS by slahes
    if(configFilePathTmp.includes("\\")) {
        //Fix slashes
        configFilePathTmp = configFilePathTmp.replaceAll("\\", "/");
        //Fix prefix
        if(configFilePathTmp.startsWith("file://") === false) configFilePathTmp = "file://" + configFilePathTmp;
    }
  
    return configFilePathTmp;
}

/**
 * Replace <br> with <!-- br --> to prevent translation of <br> tags
 * 
 * @param {String} markdown 
 * @returns - edited markdown
 */
export function beforeFormatMarkdownPrepare(markdown: string) {
    markdown = markdown.replace(/<br\s*\/?>/gi, '<!-- br -->');

    return _removeIgnoredContent(markdown);
}

/**
 * Print information about the ignored content into the console.
 * 
 * @param {String[]} ignoredContent 
 */
export function logIgnoredContentInfo(ignoredContent: any[]) {
    if (ignoredContent.length > 0){
        console.log('\x1b[43m Skipping the following paragraphs: \x1b[0m');
        ignoredContent.forEach((content: string) => console.log("\x1b[45m" + content + " \x1b[0m"));
    }
}

/**
 * Uses the extractMdastStrings function from the extract.js module to extract strings, than replaces the newlines with <br> tags.
 * 
 * @param {Object} mdast - object representing the Markdown Abstract Syntax Tree (MDAST).
 * @param {Object} config - configuration objec
 * @returns - strings array
 */
export function getPreparedStrings(mdast: any, config: any) {
    let extractedMdastStrings = extractMdastStrings({ mdast, config })
    let strings: string | any[] = [];
    extractedMdastStrings.forEach((string) => {
      strings[strings.length] = string.replace(/(|)\n/gi, '$1<br>');
    });

    return strings;
}

/**
 * Enhance the translated markdown string with custom operations, that improve the quality of the markdown.
 * 
 * Allso insert back the ignored content.
 * 
 * @param {String} markdown2 
 * @param {*} options 
 * @param {*} config 
 * @param {String} targetLanguage 
 * @param {String[]} ignoredContent 
 * @returns 
 */
export async function customizeTranslatedMarkdown(markdown2: string, options: any, config: any, targetLanguage: any, ignoredContent: any) {

    //Remove blocks of code (can interfere with regex operations, because often they contain some special characters etc.)
    //Block of code is replaced with <!--tmp-safety-replace-X--> where X is position of block in the array
    let extractedBlocksOfCode = markdown2.match(/^\`\`\`.*([\s\S]+?)^\`\`\`/gm);
    if(extractedBlocksOfCode !== undefined && extractedBlocksOfCode !== null) {
        for(let i = 0; i < extractedBlocksOfCode.length; i++) {
            markdown2 = markdown2.replace(extractedBlocksOfCode[i], "<!--tmp-safety-replace-" + i + "-->");
        }
    }

    //Enhance markdown
    markdown2 = await _translateLinkSubCategory(markdown2, options, config, targetLanguage);
    markdown2 = _markdownRegexEdit(markdown2);

    //Return blocks of code
    markdown2 = _insertBlocksOfCode(markdown2, extractedBlocksOfCode);

    //Return ignored content
    markdown2 = _insertIgnoredContent(markdown2, ignoredContent);

    return markdown2;
}

/**
 * Insert the extracted blocks of code back to the markdown string.
 * Block's of code are stored in the array "extractedBlocksOfCode" and are replaced in the markdown string's <!--tmp-safety-replace-X-->, where X is posietion of extracted block in the array.
 * 
 * @param {String} markdown2 
 * @param {String[]} extractedBlocksOfCode 
 * @returns -  markdown with inserted blocks of code
 */
function _insertBlocksOfCode(markdown2: string, extractedBlocksOfCode: RegExpMatchArray | null) {
    if(extractedBlocksOfCode !== undefined && extractedBlocksOfCode !== null) {
        for(let i = 0; i < extractedBlocksOfCode.length; i++) {
            //Replace <!-- br --> back to <br>
            extractedBlocksOfCode[i] = extractedBlocksOfCode[i].replace(/<{0,1}!--\s*br\s*-->/g, '<br>');
            //Replace $ to &dollar; value, because $ doing some funny things in regex
            extractedBlocksOfCode[i] = extractedBlocksOfCode[i].replace(/\$/gm, "&dollar;");
            markdown2 = markdown2.replace("<!--tmp-safety-replace-" + i + "-->", extractedBlocksOfCode[i]);
        };
    }

    //Replace &dollar; to $
    markdown2 = markdown2.replace(/&dollar;/gm, "$");
    
    return markdown2;
}

/**
 * Find link's in the markddown string. From links extract the subcategory that start with symbol # and translate it using deepl.
 * Translated
 * 
 * @param {String} markdown 
 * @param {*} options 
 * @param {*} config 
 * @param {String} targetLanguage 
 * @returns - enhanced markdown with translated subcategories in links
 */
async function _translateLinkSubCategory(markdown: string, options: { mode: any; }, config: any, targetLanguage: 'en-US' | 'sk' | 'cs') {
    //Extract links from the markdown
    const links  = markdown.match(/(\[[^\]]+\])\((?!http)[^#\)]*(#[^\)]+)\)/g);
    if(links === undefined || links === null) return markdown;
  
    //Extract subcategories from the links, and push them to the array "strings"
    let strings: any[] = [];
    links.forEach(async (link: string) => {
      let subCategory = link.match(/#[^\)]+\)/g);
      if(subCategory !== undefined && subCategory !== null) {
        let subCategoryString = subCategory[0].substring(1, subCategory[0].length-1); //remove # from start AND from end )
        subCategoryString = subCategoryString.replace(/---/g, ' - ');
        subCategoryString = subCategoryString.replace(/([^\s]{1})-([^\s]{1})/g, '$1 $2');
        subCategoryString = subCategoryString.replace(/([^\s]{1})-([^\s]{1})/g, '$1 $2');
        strings.push( subCategoryString );
      }
    });
  
    //Translate the subcategories
    const translations = await translate({ strings, mode: options.mode, config });
  
    let targetLanguageTranslations = translations[targetLanguage];
    if(targetLanguageTranslations !== undefined && targetLanguageTranslations !== null) {
        //Replace subcategories in the markdown with the translated ones
        for(let i = 0; i < strings.length; i++) {
            let originalForm = "#" + strings[i].replaceAll(" ", "-") + ")";
            let translatedForm = "#" + targetLanguageTranslations[i].replaceAll(" ", "-") + ")";
            let newLine = links[i].replace(originalForm, translatedForm);
            markdown = markdown.replace(links[i], newLine);
        }
    }
  
    return markdown;
}

/**
 * Edit (enhance) the markdown string using regex operations.
 * Fix spaces, bad tarnslated symbols, etc.
 * 
 * @param {String} markdown2 
 * @returns - enhanced markdown
 */
function _markdownRegexEdit(markdown2: string) {
    //Replace the * with -
    markdown2 = markdown2.replace(/(\n\*[\s]{3})(.*)/gm, "\n- $2");
    markdown2 = markdown2.replace(/(\n[\s]{4}\*[\s]+)(.*)/gm, "\n	- $2");
    markdown2 = markdown2.replace(/(\n[\s]{8}\*[\s]+)(.*)/gm, "\n		- $2");
    markdown2 = markdown2.replace(/(\n[\s]{12}\*[\s]+)(.*)/gm, "\n			- $2");

    //Fix redundant spaces after the -
    markdown2 = markdown2.replace(/(^[\s]*-)[\s]+/gm, "$1 ");

    //Remove redundant line in lists (there MUST be regex 2 times) 
    markdown2 = markdown2.replace(/([^\n]*-.*)[\n]{2,}([\s]*-)/gm, "$1\n$2");
    markdown2 = markdown2.replace(/([^\n]*-.*)[\n]{2,}([\s]*-)/gm, "$1\n$2");

    //If there is sentence that ends with : and then list, remove the empty line
    markdown2 = markdown2.replace(/(^.*:\n)\n(^[\s]*-)/gm, "$1$2");

    //Fix space before and after the picture
    markdown2 = markdown2.replace(/([^\n])\n(^!\[\]\([^()]+\))/gm, "$1\n\n$2");
    markdown2 = markdown2.replace(/(^!\[\]\([^()]+\))[\n]*([^\n])/gm, "$1\n\n$2");

    //Fix of -&gt; to -> (also for --&gt; to --> etc.)
    markdown2 = markdown2.replace(/-\\&gt;/g, '->');

    //return <!-- br --> and !-- br --> back to <br>
    markdown2 = markdown2.replace(/<{0,1}!--\s*br\s*-->/g, '<br>');

    //Fix wrong \<br> to \n (this happens in case of tables)
    markdown2 = markdown2.replace(/\\<br>/gm, "\n");

    //Fix of TR tags
    markdown2 = markdown2.replace(/<\/tr>\s*<tr>/g, '</tr><tr>');

    //FIX self closiong tag's  
    markdown2 = markdown2.replace(/(<i\s.*?)\/>/g, '$1></i>');
    markdown2 = markdown2.replace(/(<iframe .*?)[\s]*\/>/g, '$1></iframe>');

    //FIX space after the link like [something](url)
    markdown2 = markdown2.replace(/(\[.*]\([^\s]+\))([^.,\s\):])/g, '$1 $2');

    //FIX spaces before and after TABLE
    markdown2 = markdown2.replace(/([^\|\n])[\n]*(^\|.*\|\n)/gm, '$1\n\n$2');
    markdown2 = markdown2.replace(/(^\|.*\|)[\n]*(^[^\|\n])/gm, '$1\n\n$2');

    //Fix spaces
    markdown2 = markdown2.replace(/^ *([0-9]+.)[\s]*/gm, "$1 ");

    //Fix space after bold text
    markdown2 = markdown2.replace(/ (\*\*[^\*]+\*\*)([a-zA-Z])/gm, " $1 $2");

    //Specific FIX for sidebar files
    markdown2 = markdown2.replace(/(^\<div class="sidebar-section".*<\/div>)(\n[^\n]+)/gm, " $1\n$2");

    //Replace spacing after STRONG words
    markdown2 = markdown2.replace(/( \*\*[^\*\n]+\*\*)([^)\n.,: ]{1})/gm, "$1 $2");

    //Replace spacing after BACKTICK words
    markdown2 = markdown2.replace(/( `[^`\n]+`)([^\n:,.)\*=\] ]{1})/gm, "$1 $2");

    //Fix redundant added . INSIDE strong text
    markdown2 = markdown2.replace(/( \*\*[^\*\n]+)(\.)(\*\*\.)/gm, "$1$3");

    //Replace wrong generated \[ to [
    markdown2 = markdown2.replace(/\\\[/gm, "[");

    //Fix redundant space in TABLE -> (CAN happen in case of table row with text NOT ended with symbol | )
    markdown2 = markdown2.replace(/(^\|.*)\n\n(^\|)/gm, "$1\n$2");

    //Fix tabs strong from \*\* to **
    markdown2 = markdown2.replace(/(\\\*\\\*)/gm, "**");

    //Replace \&gt; to >
    markdown2 = markdown2.replace(/\\&gt;/gm, ">");

    //Replace \&lt; to <
    markdown2 = markdown2.replace(/\\&lt;/gm, "<");

    //Repar tag -: ad < at start if missing
    markdown2 = markdown2.replace(/(^\!--\s*deepmark-ignore-end\s*-->)/gm, "<!-- deepmark-ignore-end -->");

    //Replace \# with #
    markdown2 = markdown2.replace(/^\\#/gm, "#");
    markdown2 = markdown2.replace(/^[\s]*-[\s*]\\#/gm, "- #");

    return markdown2;
}

/**
 * Removes content between the <!-- deepmark-ignore-start --> and <!-- deepmark-ignore-end --> tags
 * from the provided markdown string and returns an object containing the modified markdown and
 * the ignored content.
 *
 * @param {string} markdown - The input markdown string.
 * @returns {object} An object with two properties:
 *                   - result: The modified markdown string with ignored content placeholders.
 *                   - ignoredContent: An array of strings containing the ignored content.
 */
function _removeIgnoredContent(markdown: string) {
    const startTag = /<!--\s*deepmark-ignore-start\s*-->/gm;
    const endTag = /<!--\s*deepmark-ignore-end\s*-->/gm;
    let result = '';
    let ignoredContent = [];
    let startIndex = 0;
    let endIndex = 0;
    let matchStart, matchEnd;
  
    while ((matchStart = startTag.exec(markdown)) !== null) {
        startIndex = matchStart.index;
        result += markdown.substring(endIndex, startIndex + matchStart[0].length);
        matchEnd = endTag.exec(markdown);
        if (!matchEnd) {
            throw new Error("Mismatched tags");
        }
        endIndex = matchEnd.index + matchEnd[0].length;
        ignoredContent.push(markdown.substring(startIndex + matchStart[0].length, matchEnd.index));
        result += matchEnd[0];
    }
  
    result += markdown.substring(endIndex);
    return { result, ignoredContent };
}

/**
 * Inserts the ignored content back into the markdown string at the positions
 * marked by the <!-- deepmark-ignore-start --> and <!-- deepmark-ignore-end --> tags.
 *
 * @param {string} translated - The translated markdown string.
 * @param {array} ignoredContent - An array of strings containing the ignored content.
 * @returns {string} The markdown string with the ignored content reinserted.
 */
function _insertIgnoredContent(translated: any, ignoredContent: string | any[]) {
    const spaceForInsert = /<!--\s*deepmark-ignore-start\s*-->([\s\S]*?)<!--\s*deepmark-ignore-end\s*-->/g;
    let result = translated;
    let match;
    let index = 0;
  
    while ((match = spaceForInsert.exec(result)) !== null) {
        if (index >= ignoredContent.length) break;
        result = result.substring(0, match.index) + '<!-- deepmark-ignore-start -->' + ignoredContent[index] + '<!-- deepmark-ignore-end -->' + result.substring(match.index + match[0].length);
        index++;
    }
  
    return result;
  }