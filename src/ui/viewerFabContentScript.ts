/**
 * Markdown viewer content script — same floating Grok FAB as the editor.
 */
import { ContentScriptContext } from 'api/types';

module.exports = {
	default: function (_context: ContentScriptContext) {
		return {
			plugin: function (_markdownIt: unknown) {
				return;
			},
			assets: function () {
				return [{ name: 'viewerFabInject.js' }];
			},
		};
	},
};
