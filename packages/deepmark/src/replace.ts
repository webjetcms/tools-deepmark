import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
	type Config,
	isJsonOrYamlPropertyIncluded,
} from './config.js';
import { isArray, isEmptyArray, isObject } from './utils.js';

export function replaceJsonOrYamlStrings({
	source,
	type = 'json',
	strings,
	config
}: {
	source: string;
	type?: 'json' | 'yaml';
	strings: string[];
	config: Config;
}): string {
	if (isEmptyArray(config.jsonOrYamlProperties.include)) return source;

	strings = strings.reverse();
	const parsed = type === 'json' ? JSON.parse(source) : parseYaml(source);

	process({ value: parsed });

	function process(args: { value: unknown; parent?: never; property?: never; index?: never }): void;
	function process(args: {
		value: unknown;
		parent: unknown[];
		property?: string | number | symbol;
		index: number;
	}): void;
	function process(args: {
		value: unknown;
		parent: Record<string | number | symbol, unknown>;
		property: string | number | symbol;
		index?: never;
	}): void;
	function process({
		value,
		parent,
		property,
		index
	}: {
		value: unknown;
		parent?: unknown[] | Record<string | number | symbol, unknown>;
		property?: string | number | symbol;
		index?: number;
	}) {
		if (isArray(value)) {
			for (const [index, item] of value.entries()) {
				process({ value: item, parent: value, property, index });
			}
			return;
		}

		if (isObject(value)) {
			for (const property in value) {
				const item = (value as Record<string | number | symbol, unknown>)[property];
				process({ value: item, parent: value, property });
			}
			return;
		}

		if (typeof value === 'string') {
			if (property && isJsonOrYamlPropertyIncluded({ property, config })) {
				if (isArray(parent) && index) {
					parent[index] = strings.pop();

					return;
				}

				if (isObject(parent)) {
					parent[property] = strings.pop();

					return;
				}
			}
			return;
		}
	}

	if (type === 'json') return JSON.stringify(parsed);
	return stringifyYaml(parsed);
}
