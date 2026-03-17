import { Command } from 'commander';
import fs from 'fs-extra';
import type { Config, UserConfig } from './config.js';
import { resolveConfig, getSourceFilePaths } from './config.js';
import { extractJsonOrYamlStrings } from './extract.js';
import { format } from './format.js';
import { replaceJsonOrYamlStrings } from './replace.js';
import { translate } from './translate.js';
import { beforeFormatMarkdownPrepare, logIgnoredContentInfo, customizeTranslatedMarkdown, getConfigFilePath } from "./webjet-logic.js";
import { getPreparedBatch, getTranslatedMarkdown } from "./custom-parser.js";

export function createCli() {
	const program = new Command();

	program
		.name('deepmark')
		.description(
			'Translate your markdown files with Deepl machine translation.\nIt supports both `.md` and React `.mdx`.'
		)
		.option(
			'-c, --config <path>',
			'Overide configuration file path. Either a relative path to the current workink directory or an absolute path.',
			'deepmark.config.mjs'
		);

	program
		.command('translate')
		.description('Translate strings with Deepl API and local translation memory.')
		.option(
			'-m, --mode <hybrid|offline|online>',
			'Set translation mode, defaults to hybrid.',
			'hybrid'
		)
		.action(async (__, command: Command) => {
			const options = command.optsWithGlobals() as {
				mode: 'hybrid' | 'offline' | 'online';
				config: string;
			};

			const config = await getThenResolveConfig(options.config);

			// resolve source paths
			const sourceFilePaths = await getSourceFilePaths(config);

			console.log("***** Starting translation *****");
			for (const { sourceFilePath, outputFilePath } of sourceFilePaths.md) {
				console.log("File : ./docs" + sourceFilePath.split("/docs")[1]);
				console.log("- extracting file");
				const markdown = await getFile(sourceFilePath);

				let { result, ignoredContent }: { result: string; ignoredContent: any } = beforeFormatMarkdownPrepare(markdown);

				//Optional: log ignored content
				//logIgnoredContentInfo(ignoredContent);

				console.log("- translating file");
				
				// !! - try getPreparedBatch WITHOUT formating the markdown (it was killing spacing between link, list etc)
				//const formatted_markdown: string = await format(result);
				const preparedBatch = getPreparedBatch(result);

      			//console.log("Prepared batch:", preparedBatch);

				const translatedArr = await translate({ strings: preparedBatch.toTranslate, mode: options.mode, config });

				// getTranslatedMarkdown mutates parsed chunk state, so it must run sequentially per language
				const perLangResults: Array<{ targetLanguage: string; markdown: string }> = [];
				for (const targetLanguage of config.outputLanguages) {
					perLangResults.push({
						targetLanguage,
						markdown: getTranslatedMarkdown(preparedBatch.parsed, preparedBatch.chunkIndexes, translatedArr[targetLanguage])
					});
				}

				// customizeTranslatedMarkdown and file writes are independent per language — run in parallel
				await Promise.all(perLangResults.map(async ({ targetLanguage, markdown }) => {
					const markdown2 = await customizeTranslatedMarkdown(markdown, options, config, targetLanguage, ignoredContent);
					await fs.outputFile(
						outputFilePath.replace(/\$langcode\$/, shortLangCode(targetLanguage)),
						markdown2,
						{ encoding: "utf-8" }
					);
				}));
				console.log("- file translation DONE");
        		console.log("");
			}

			console.log("***** Translation DONE *****");
    		console.log("");

			for (const { sourceFilePath, outputFilePath } of sourceFilePaths.json) {
				const json = await getFile(sourceFilePath);

				// extract strings
				const strings = extractJsonOrYamlStrings({ source: json, config });
				// translate strings
				const translations = await translate({ strings, mode: options.mode, config });

				await Promise.all(config.outputLanguages.map(targetLanguage => {
					const _json = replaceJsonOrYamlStrings({
						source: json,
						strings: translations[targetLanguage]!,
						config
					});
					return fs.outputFile(outputFilePath.replace(/\$langcode\$/, shortLangCode(targetLanguage)), _json, {
						encoding: 'utf-8'
					});
				}));
			}

			for (const { sourceFilePath, outputFilePath } of sourceFilePaths.yaml) {
				const yaml = await getFile(sourceFilePath);

				// extract strings
				const strings = extractJsonOrYamlStrings({ source: yaml, type: 'yaml', config });
				// translate strings
				const translations = await translate({ strings, mode: options.mode, config });

				await Promise.all(config.outputLanguages.map(targetLanguage => {
					const _yaml = replaceJsonOrYamlStrings({
						source: yaml,
						strings: translations[targetLanguage]!,
						type: 'yaml',
						config
					});
					return fs.outputFile(outputFilePath.replace(/\$langcode\$/, shortLangCode(targetLanguage)), _yaml, {
						encoding: 'utf-8'
					});
				}));
			}

			await Promise.all(
				sourceFilePaths.others.flatMap(({ sourceFilePath, outputFilePath }) =>
					config.outputLanguages.map(targetLanguage =>
						fs.copy(sourceFilePath, outputFilePath.replace(/\$langcode\$/, shortLangCode(targetLanguage)))
					)
				)
			);
		});

	return program;
}

async function getThenResolveConfig(path: string): Promise<Config> {
	const configFilePath: string = await getConfigFilePath(path, true);
	const userConfig: UserConfig = (await import(configFilePath)).default;
	return resolveConfig(userConfig);
}

async function getFile(path: string): Promise<string> {
	return await fs.readFile(path, { encoding: 'utf-8' });
}

//WebJET CMS en-US converted to just en
function shortLangCode(targetLanguage: string): string {
	return targetLanguage.split('-')[0];
}