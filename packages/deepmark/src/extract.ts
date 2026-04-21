import { parse as parseYaml } from 'yaml';
import {
	type Config,
	isJsonOrYamlPropertyIncluded,
} from './config.js';
import { isArray, isEmptyArray, isObject } from './utils.js';

export function extractJsonOrYamlStrings({
	source,
	type = 'json',
	config
}: {
	source: string;
	type?: 'json' | 'yaml';
	config: Config;
}): string[] {
	const strings: string[] = [];

	if (isEmptyArray(config.jsonOrYamlProperties.include)) return strings;

	const parsed = type === 'json' ? JSON.parse(source) : parseYaml(source);

	process(parsed);

	function process(value: unknown, property?: string) {
		if (typeof value === 'string') {
			if (property && isJsonOrYamlPropertyIncluded({ property, config })) strings.push(value);
			return;
		}

		if (isArray(value)) {
			for (const item of value) {
				process(item);
			}
			return;
		}

		if (isObject(value)) {
			for (const property in value) {
				const item = (value as Record<string | number | symbol, unknown>)[property];
				process(item, property);
			}
			return;
		}
	}

	return strings;
}
