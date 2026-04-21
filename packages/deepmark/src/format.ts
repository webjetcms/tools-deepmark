import { getMarkdown, getMdast, mdNodeIs } from './ast/mdast.js';
import { unwalk } from './ast/unwalk.js';

export async function format(markdown: string) {
	const mdast = getMdast(markdown);

	/**
	 * remove empty surface flow expression nodes
	 */
	unwalk(
		mdast,
		(node, parent, index) => {
 			if (
 				mdNodeIs(node, 'mdxFlowExpression') &&
 				typeof node === 'object' &&
 				'value' in node &&
 				expressionIsEmpty((node as { value: string }).value)
 			) {
 				(parent!.children[index!] as unknown) = undefined;
 			}
		},
		(node, parent) => {
			delete node.position;
			return mdNodeIs(parent, 'root');
		}
	);

	return getMarkdown(mdast);
}

function expressionIsEmpty(text: string): boolean {
	const regex = /^('|")\s*('|")$/;
	return regex.test(text);
}
