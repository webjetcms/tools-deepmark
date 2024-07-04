import type { TargetLanguageCode } from 'deepl-node';
import { Translator } from 'deepl-node';
import np from 'node:path';
import type { Config } from './config.js';
import { Database } from './database.js';

export async function translate({
	strings,
	mode = 'hybrid',
	memorize = true,
	config
}: {
	strings: string[];
	mode?: 'offline' | 'hybrid' | 'online';
	memorize?: boolean;
	config: Config;
}): Promise<{ [Property in TargetLanguageCode]?: string[] }> {
	const db: Database = new Database(np.resolve(config.cwd, '.deepmark/db.sqlite'));
	const translations: { [Property in TargetLanguageCode]?: string[] } = {};

	if (mode !== 'offline') {
		const DEEPL_AUTH_KEY = process.env.DEEPL_AUTH_KEY;
		if (!DEEPL_AUTH_KEY) throw new Error('DEEPL_AUTH_KEY environment variable must be set');

		const deepl = new Translator(DEEPL_AUTH_KEY);
		const queue: [index: number, string: string][] = [];
		const hybrid = mode === 'hybrid';

		for (const targetLanguage of config.outputLanguages) {
			const _translations: string[] = [];

			for (const [index, string] of strings.entries()) {
				if (hybrid) {
					const translation = db.getTranslation({
						source: string,
						language: targetLanguage
					});

					if (translation) {
						_translations.push(translation);
						continue;
					}
				}

				queue.push([index, string]);
				_translations.push('');

				//Translate strings using DeepL in batches of 10 
				if(queue.length > 0) {
					await deeplTrasnlate(queue, deepl, config, targetLanguage, _translations, db, memorize);
				}
			}

			//Translate left over string from queue using DeepL
			if (queue.length > 0) {
				await deeplTrasnlate(queue, deepl, config, targetLanguage, _translations, db, memorize);
			}

			translations[targetLanguage] = _translations;
		}
	} else {
		for (const targetLanguage of config.outputLanguages) {
			const _translations: string[] = [];

			for (const string of strings) {
				const translation = db.getTranslation({
					source: string,
					language: targetLanguage
				});

				if (translation) {
					_translations.push(translation);
					continue;
				}

				_translations.push(string);
			}

			translations[targetLanguage] = _translations;
		}
	}

	return translations;
}

async function deeplTrasnlate(
	queue: [number, string][],
	deepl: Translator,
	config: Config,
	targetLanguage: TargetLanguageCode,
	_translations: string[],
	db: Database,
	memorize: boolean
): Promise<void> {
	const indexes = queue.map(([index2]) => index2);
	const _strings = queue.map(([__, string2]) => string2);

	const results = await deepl.translateText(
		_strings,
		config.sourceLanguage,
		targetLanguage,
		{
			tagHandling: "html",
			splitSentences: "nonewlines"
		}
	);

	queue.reverse();
	for (let j = 0; j < indexes.length; j++) {
		const index2 = indexes[j];
		const translation = results[j].text;
		const string2 = _strings[j];

		if (memorize)
			db.setTranslation({ source: string2, language: targetLanguage, translation });
		
		_translations[index2] = translation;
		queue.pop();
	}
}