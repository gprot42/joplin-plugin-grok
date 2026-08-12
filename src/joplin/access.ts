import joplin from 'api';
import { SettingKey } from '../settings';
import { listNotebookPaths } from './notebooks';
import { NotebookPathNode } from './types';

/**
 * Access control for the AI assistant.
 *
 * Users can block notebooks (and all of their subnotebooks) so the model
 * cannot search, read, update, or place notes into those branches.
 *
 * Storage: comma/newline-separated notebook IDs in plugin settings, plus
 * optional title patterns (case-insensitive substring or "path contains").
 */

export interface AccessPolicy {
	/** Explicit notebook IDs that are blocked (includes blocking all descendants). */
	blockedNotebookIds: Set<string>;
	/** Title/path substrings; any notebook whose path matches is blocked. */
	blockedPathPatterns: string[];
	/** If true, only allow listed notebook IDs (allowlist mode). Empty allowlist = allow all non-blocked. */
	allowlistMode: boolean;
	allowedNotebookIds: Set<string>;
}

export function parseIdList(raw: string): string[] {
	if (!raw || !String(raw).trim()) return [];
	return String(raw)
		.split(/[\n,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export async function loadAccessPolicy(): Promise<AccessPolicy> {
	// Prefer disk+settings merge so exclusions survive restarts even if settings lag
	let blockedIds: string[] = [];
	try {
		const { loadExcludedIds } = await import('./excludedStore');
		blockedIds = await loadExcludedIds();
	} catch {
		blockedIds = parseIdList(
			String((await joplin.settings.value(SettingKey.BlockedNotebookIds)) || '')
		);
	}
	const allowedIds = parseIdList(String((await joplin.settings.value(SettingKey.AllowedNotebookIds)) || ''));
	const patterns = parseIdList(String((await joplin.settings.value(SettingKey.BlockedPathPatterns)) || ''));
	const allowlistMode = Boolean(await joplin.settings.value(SettingKey.AllowlistMode));

	return {
		blockedNotebookIds: new Set(blockedIds),
		blockedPathPatterns: patterns.map((p) => p.toLowerCase()),
		allowlistMode,
		allowedNotebookIds: new Set(allowedIds),
	};
}

/** Expand explicit blocked IDs to include all descendant notebook IDs. */
export function expandBlockedIds(
	policy: AccessPolicy,
	notebooks: NotebookPathNode[]
): Set<string> {
	const blocked = new Set<string>(policy.blockedNotebookIds);

	// Any notebook matching a path pattern
	for (const n of notebooks) {
		const pathLower = n.path.toLowerCase();
		const titleLower = n.title.toLowerCase();
		for (const pat of policy.blockedPathPatterns) {
			if (pathLower.includes(pat) || titleLower.includes(pat)) {
				blocked.add(n.id);
			}
		}
	}

	// Descendants of blocked notebooks: path starts with blocked notebook's path
	const blockedPaths = notebooks.filter((n) => blocked.has(n.id)).map((n) => n.path);
	for (const n of notebooks) {
		for (const bp of blockedPaths) {
			if (n.path === bp || n.path.startsWith(bp + ' / ')) {
				blocked.add(n.id);
			}
		}
	}

	return blocked;
}

export function expandAllowedIds(
	policy: AccessPolicy,
	notebooks: NotebookPathNode[]
): Set<string> | null {
	if (!policy.allowlistMode) return null;
	if (policy.allowedNotebookIds.size === 0) {
		// Allowlist mode with empty list: nothing is readable (fail closed)
		return new Set();
	}

	const allowed = new Set<string>(policy.allowedNotebookIds);
	const allowedPaths = notebooks.filter((n) => allowed.has(n.id)).map((n) => n.path);
	for (const n of notebooks) {
		for (const ap of allowedPaths) {
			if (n.path === ap || n.path.startsWith(ap + ' / ')) {
				allowed.add(n.id);
			}
		}
	}
	return allowed;
}

export interface AccessContext {
	policy: AccessPolicy;
	notebooks: NotebookPathNode[];
	/** Effective blocked set (with descendants + patterns). */
	blocked: Set<string>;
	/** If non-null, only these notebook IDs are visible (allowlist expanded). */
	allowed: Set<string> | null;
}

export async function buildAccessContext(): Promise<AccessContext> {
	const policy = await loadAccessPolicy();
	const notebooks = await listNotebookPaths();
	const blocked = expandBlockedIds(policy, notebooks);
	const allowed = expandAllowedIds(policy, notebooks);
	return { policy, notebooks, blocked, allowed };
}

export function isNotebookAccessible(ctx: AccessContext, notebookId: string): boolean {
	if (!notebookId) return false;
	if (ctx.blocked.has(notebookId)) return false;
	if (ctx.allowed !== null && !ctx.allowed.has(notebookId)) return false;
	return true;
}

export function filterAccessibleNotebooks(ctx: AccessContext): NotebookPathNode[] {
	return ctx.notebooks.filter((n) => isNotebookAccessible(ctx, n.id));
}

export function assertNotebookAccessible(ctx: AccessContext, notebookId: string, action: string): void {
	if (!isNotebookAccessible(ctx, notebookId)) {
		throw new Error(
			`Access denied: notebook is not available to the AI (${action}). ` +
				`Adjust "AI access" settings if this is a mistake.`
		);
	}
}

export function filterNotesByAccess<T extends { parent_id: string; id?: string }>(
	ctx: AccessContext,
	notes: T[]
): T[] {
	return notes.filter((n) => isNotebookAccessible(ctx, n.parent_id));
}

/** Human-readable summary for the chat UI / system prompt. */
export function describeAccessPolicy(ctx: AccessContext): string {
	const blockedPaths = ctx.notebooks
		.filter((n) => ctx.blocked.has(n.id) && ctx.policy.blockedNotebookIds.has(n.id))
		.map((n) => n.path);
	const lines: string[] = [];

	if (ctx.allowed !== null) {
		const allowedRoots = ctx.notebooks
			.filter((n) => ctx.policy.allowedNotebookIds.has(n.id))
			.map((n) => n.path);
		lines.push(
			`Allowlist mode: AI may only use these notebooks (and their subnotebooks): ${
				allowedRoots.length ? allowedRoots.join('; ') : '(none — all blocked)'
			}.`
		);
	}

	if (blockedPaths.length || ctx.policy.blockedPathPatterns.length) {
		lines.push(
			`Excluded notebooks (and all subnotebooks) — no AI search/read/update/write: ${
				blockedPaths.length ? blockedPaths.join('; ') : '(patterns only)'
			}.`
		);
		if (ctx.policy.blockedPathPatterns.length) {
			lines.push(`Blocked path patterns: ${ctx.policy.blockedPathPatterns.join(', ')}.`);
		}
	}

	if (!lines.length) {
		return 'All notebooks are accessible to the AI. Use Exclude in the assistant panel to hide notebooks.';
	}
	return lines.join(' ');
}
