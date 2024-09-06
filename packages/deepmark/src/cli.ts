import { Command, Option } from 'commander';
import fs from 'fs-extra';
import np from 'node:path';
import nurl from 'node:url';
import { getMarkdown, getMdast } from './ast/mdast.js';
import type { Config, UserConfig } from './config.js';
import { resolveConfig, getSourceFilePaths } from './config.js';
import { extractJsonOrYamlStrings, extractMdastStrings } from './extract.js';
import { format } from './format.js';
import { replaceJsonOrYamlStrings, replaceMdastStrings } from './replace.js';
import { translate } from './translate.js';
import { beforeFormatMarkdownPrepare, logIgnoredContentInfo, getPreparedStrings, customizeTranslatedMarkdown, getConfigFilePath } from "./webjet-logic.js";

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

				const formatted_markdown: string = await format(result);
				const mdast: any = getMdast(formatted_markdown);

				let strings: string[] = getPreparedStrings(mdast, config);

				console.log("- translating file");

				const translations = await translate({ strings, mode: options.mode, config });

				for (const targetLanguage of config.outputLanguages) {
					const _mdast = replaceMdastStrings({
						mdast,
						strings: translations[targetLanguage]!,
						config
					});

					console.log("- formatting translated file");

					let markdown2: string = getMarkdown(_mdast);

					markdown2 = await customizeTranslatedMarkdown(markdown2, options, config, targetLanguage, ignoredContent);

					console.log("- writing file");
					await fs.outputFile(
						outputFilePath.replace(/\$langcode\$/, shortLangCode(targetLanguage)),
						markdown2,
						{ encoding: "utf-8" }
					);
					console.log("- file translation DONE");
        			console.log("");
				}
			}

			console.log("***** Translation DONE *****");
    		console.log("");

			for (const { sourceFilePath, outputFilePath } of sourceFilePaths.json) {
				const json = await getFile(sourceFilePath);

				// extract strings
				const strings = extractJsonOrYamlStrings({ source: json, config });
				// translate strings
				const translations = await translate({ strings, mode: options.mode, config });

				for (const targetLanguage of config.outputLanguages) {
					// replace strings
					const _json = replaceJsonOrYamlStrings({
						source: json,
						strings: translations[targetLanguage]!,
						config
					});
					// write translated file
					await fs.outputFile(outputFilePath.replace(/\$langcode\$/, shortLangCode(targetLanguage)), _json, {
						encoding: 'utf-8'
					});
				}
			}

			for (const { sourceFilePath, outputFilePath } of sourceFilePaths.yaml) {
				const yaml = await getFile(sourceFilePath);

				// extract strings
				const strings = extractJsonOrYamlStrings({ source: yaml, type: 'yaml', config });
				// translate strings
				const translations = await translate({ strings, mode: options.mode, config });

				for (const targetLanguage of config.outputLanguages) {
					// replace strings
					const _json = replaceJsonOrYamlStrings({
						source: yaml,
						strings: translations[targetLanguage]!,
						type: 'yaml',
						config
					});
					// write translated file
					await fs.outputFile(outputFilePath.replace(/\$langcode\$/, shortLangCode(targetLanguage)), _json, {
						encoding: 'utf-8'
					});
				}
			}

			for (const { sourceFilePath, outputFilePath } of sourceFilePaths.others) {
				for (const targetLanguage of config.outputLanguages) {
					await fs.copy(sourceFilePath, outputFilePath.replace(/\$langcode\$/, shortLangCode(targetLanguage)));
				}
			}
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