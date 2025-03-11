import type { TargetLanguageCode } from 'deepl-node';
import { Translator } from 'deepl-node';
import np from 'node:path';
import type { Config } from './config.js';
import { Database } from './database.js';
import pkg from '@google-cloud/translate';
const { Translate } = pkg.v2;

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
	let dbPath: string;
	if (config.translationEngine === 'google') {
		dbPath = np.resolve(config.cwd, '.google/db.sqlite');
	} else {
		dbPath = np.resolve(config.cwd, '.deepmark/db.sqlite');
	}

	const db: Database = new Database(dbPath);
	const translations: { [Property in TargetLanguageCode]?: string[] } = {};

	if (mode !== 'offline') {
		let engine: any;
		if (config.translationEngine === 'google'){
			console.log("   -with google");
			const GOOGLE_AUTH_KEY = process.env.GOOGLE_AUTH_KEY;
			if (!GOOGLE_AUTH_KEY)
				throw new Error("GOOGLE_AUTH_KEY environment variable must be set");
			engine = new Translate({key : GOOGLE_AUTH_KEY} );
		}
		else {
			console.log("   -with deepl");
			const DEEPL_AUTH_KEY = process.env.DEEPL_AUTH_KEY;
			if (!DEEPL_AUTH_KEY)
				throw new Error("DEEPL_AUTH_KEY environment variable must be set");
			engine = new Translator(DEEPL_AUTH_KEY);
		}
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
				if(queue.length > 10) {
					await translateImpl(queue, engine, config, targetLanguage, _translations, db, memorize);
				}
			}

			//Translate left over string from queue using DeepL
			if (queue.length > 0) {
				await translateImpl(queue, engine, config, targetLanguage, _translations, db, memorize);
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

async function translateImpl(
	queue: [number, string][],
	engine: any,
	config: Config,
	targetLanguage: TargetLanguageCode,
	_translations: string[],
	db: Database,
	memorize: boolean | undefined
): Promise<void> {
	const indexes = queue.map(([index2]) => index2);
	const _strings = queue.map(([__, string2]) => string2);

	let results;
	if (config.translationEngine === 'google') {
		const [translations] = await engine.translate(_strings, {
			from: config.sourceLanguage,
			to: targetLanguage,
		});
		results = Array.isArray(translations) ? translations : [translations];
  	}
	else {
		results = await engine.translateText(
			_strings,
			config.sourceLanguage,
			targetLanguage,{
			tagHandling: "html",
			splitSentences: "nonewlines"
		});
	}

	queue.reverse();
	for (let j = 0; j < indexes.length; j++) {
		const index2 = indexes[j];
		const translation = config.translationEngine === 'google' ? results[j] : results[j].text;
		const string2 = _strings[j];

		if (memorize)
			db.setTranslation({ source: string2, language: targetLanguage, translation });
		_translations[index2] = translation;
		queue.pop();
	}
}