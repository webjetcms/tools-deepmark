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

				// extract strings
				const mdast = getMdast(await format(markdown));
				const strings = extractMdastStrings({ mdast, config });

				// translate strings
				console.log("- translating file");
				const translations = await translate({ strings, mode: options.mode, config });

				for (const targetLanguage of config.outputLanguages) {
					// replace strings
					const _mdast = replaceMdastStrings({
						mdast,
						strings: translations[targetLanguage]!,
						config
					});

					console.log("- formatting translated file");
					let markdown = getMarkdown(_mdast);
					//remove redundant new lines
					markdown = markdown.replace(/(^[\S]*\*.*)\n\n/gm, '$1\n');
					markdown = markdown.replace(/(^[\s]*\*.*)\n\n/gm, '$1\n');
					//replace * with - (and remove redundant spaces) to deep of 4 levels
					markdown = markdown.replace(/(\n\*[\s]{3})(.*)/gm,         '\n- $2');
					markdown = markdown.replace(/(\n[\s]{4}\*[\s]{3})(.*)/gm,  '\n\t- $2');
					markdown = markdown.replace(/(\n[\s]{8}\*[\s]{3})(.*)/gm,  '\n\t\t- $2');
					markdown = markdown.replace(/(\n[\s]{12}\*[\s]{3})(.*)/gm, '\n\t\t\t- $2');
					//Headline fix - add new line before headline
					markdown = markdown.replace(/(^[\S]*-[\S]*.*)\n([\#]+.*)/gm, '$1\n\n$2'); //fix bold headlines
					//Fix Bold healines - add new line before and after bold text (that is headline)
					markdown = markdown.replace(/([^\n])\n(^\*\*[0-1a-zA-Z ]+\*\*)/gm, '$1\n\n$2');
					markdown = markdown.replace(/(^\*\*[0-1a-zA-Z ]+\*\*)\n([^\n])/gm, '$1\n\n$2');
					//Fix image links - add new line before and after image (if necessary)
					markdown = markdown.replace(/([^\n])\n(^!\[\]\([^()]+\))/gm, '$1\n\n$2');
					markdown = markdown.replace(/(^!\[\]\([^()]+\))\n([^\n])/gm, '$1\n\n$2');
					//Fix image tags - add new line before and after image (if necessary)
					markdown = markdown.replace(/([^\n])\n(^<img.*\/>)/gm, '$1\n\n$2');
					markdown = markdown.replace(/(^<img.*\/>)\n([^\n])/gm, '$1\n\n$2');
					//Fix list header, so between list and header is NOT line and list header is separated from rest of text
					/*
					* Something something:
					* - something
					* - something 
					*/
					markdown = markdown.replace(/(^.*:\n)\n(^[\s]*-)/gm, '$1$2');
					markdown = markdown.replace(/([^\n])\n(^.*:\n)/gm, '$1\n\n$2');
					//FIX - markdown gonna fuck the iframe end tag, need to be fixed or everything after this error not gonna show
					markdown = markdown.replace(/(^<div class="video-container">\n[\s]*)(<iframe.*)\/>(\n<\/div>)/gm, '$1$2></iframe>$3');
					//FIX fucking end tags
					markdown = markdown.replace(/(<[^<>]*)[\s]>/gm, '$1>');
					//Special case, if file start with * (in _sidebar.md)
					markdown = markdown.replace(/^\*[\s]*([^*]*)\n/gm, '- $1');
					//Special case, \[ to [ (in ROADMAP.md
					//For safety, we will replace only if there is combination '- \[ ]' or '- \[x]' at START of line
					markdown = markdown.replace(/^-\s\\\[\s\]/gm, '- [ ]');
					markdown = markdown.replace(/^-\s\\\[x\]/gm, '- [x]');

					//Special case for OLD changelog - 2020
					markdown = markdown.replace(/^-\s\\\[([a-zA-Z ]+])/gm, '- [$1'); //First replace - \[TEXT AND space
					markdown = markdown.replace(/^-\s\\\#([0-9]+)/gm, '- #$1'); //Second replace - \#NUMBER
					markdown = markdown.replace(/^[\s]*\\\#([0-9]+)/gm, '#$1'); //Third replace \#NUMBER
					markdown = markdown.replace(/(^-\s#[0-9]+)\s\\\[([a-zA-Z ]+])/gm, '$1 [$2'); //Fourth replace - #NUMBER \[TEXT an spac

					// write translated file
					console.log("- writing file");
					await fs.outputFile(
						outputFilePath.replace(/\$langcode\$/, targetLanguage),
						markdown,
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
					await fs.outputFile(outputFilePath.replace(/\$langcode\$/, targetLanguage), _json, {
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
					await fs.outputFile(outputFilePath.replace(/\$langcode\$/, targetLanguage), _json, {
						encoding: 'utf-8'
					});
				}
			}

			for (const { sourceFilePath, outputFilePath } of sourceFilePaths.others) {
				for (const targetLanguage of config.outputLanguages) {
					await fs.copy(sourceFilePath, outputFilePath.replace(/\$langcode\$/, targetLanguage));
				}
			}
		});

	return program;
}

async function getThenResolveConfig(path?: string): Promise<Config> {
	const configFilePath = path
		? path.startsWith('/')
			? path
			: np.resolve(process.cwd(), path)
		: np.resolve(process.cwd(), 'deepmark.config.mjs');

	const userConfig: UserConfig = (await import(configFilePath)).default;
	return resolveConfig(userConfig);
}

async function getFile(path: string): Promise<string> {
	return await fs.readFile(path, { encoding: 'utf-8' });
}
