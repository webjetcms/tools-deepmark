# Changelog

## 0.3.5

Improved translation accuracy and performance across all file types.

- Preserve leading whitespace, `<iframe>` blocks, and `<code>` tags during translation (previously lost or altered).
- Fix Markdown links being reordered or dropped by Google Translate.
- De-duplicate repeated strings before sending them to the translation API, reducing usage and cost.
- Translate output files for all target languages in parallel, improving performance when multiple languages are configured.
- Fix several `WebjetCMS` post-processing regex issues that could break list formatting in translated output.

## 0.3.4

Skip **formatting** before content parsing to improve translation quality (it was causing issues with certain markdown structures).

## 0.3.3

Improve translation quality by removing `prettier` from workflow and adding other changes.

## 0.3.2

Replacing `mdast` parser with custom parser `custom-parser.ts`.

## 0.3.1

Change location for google translation database to `.deepmark/google.sqlite`.

## 0.3.0

Add support for Google Translate as engine configured by `translationEngine: "google"` in `deepmark.config.js`.

## 0.2.1

Skip also `pdf` and `docx` files (config.ts).

## 0.2.0

Update node to v22, update dependencies.

## 0.1.9

Build with node 16
