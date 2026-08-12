/**
 * Persistent store for excluded notebook IDs.
 *
 * Joplin plugin settings are used for the config UI, but dialog formData can
 * fail to round-trip multi-value fields. We also write a JSON file under the
 * plugin dataDir so exclusions survive app restarts reliably.
 */
import * as fs from 'fs';
import * as path from 'path';
import joplin from 'api';
import { SettingKey } from '../settings';

const STORE_FILENAME = 'excluded-notebooks.json';

export interface ExcludedStorePayload {
	version: 1;
	/** Notebook (folder) ids blocked from AI */
	ids: string[];
	/** Optional human paths for display */
	paths?: string[];
	updatedAt: string;
}

function parseIdList(raw: string): string[] {
	return String(raw || '')
		.split(/[\n,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function uniqueIds(ids: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const clean = String(id || '').trim();
		if (!clean || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
	}
	return out;
}

async function storePath(): Promise<string> {
	const dir = await joplin.plugins.dataDir();
	return path.join(dir, STORE_FILENAME);
}

export async function readExcludedFromDisk(): Promise<ExcludedStorePayload | null> {
	try {
		const file = await storePath();
		if (!fs.existsSync(file)) return null;
		const raw = fs.readFileSync(file, 'utf8');
		const data = JSON.parse(raw) as ExcludedStorePayload;
		if (!data || !Array.isArray(data.ids)) return null;
		return {
			version: 1,
			ids: uniqueIds(data.ids),
			paths: Array.isArray(data.paths) ? data.paths.map(String) : undefined,
			updatedAt: data.updatedAt || '',
		};
	} catch (e) {
		console.warn('Joplin Grok: could not read excluded-notebooks.json', e);
		return null;
	}
}

export async function writeExcludedToDisk(
	ids: string[],
	paths?: string[]
): Promise<void> {
	const payload: ExcludedStorePayload = {
		version: 1,
		ids: uniqueIds(ids),
		paths: paths && paths.length ? paths : undefined,
		updatedAt: new Date().toISOString(),
	};
	try {
		const file = await storePath();
		const dir = path.dirname(file);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
	} catch (e) {
		console.warn('Joplin Grok: could not write excluded-notebooks.json', e);
		throw e;
	}
}

/** Read excluded ids from settings only. */
export async function readExcludedFromSettings(): Promise<string[]> {
	const raw = String((await joplin.settings.value(SettingKey.BlockedNotebookIds)) || '');
	return uniqueIds(parseIdList(raw));
}

/**
 * Merge disk + settings (union, disk order first then settings-only ids).
 * Used at startup to recover if one side is missing.
 */
export async function loadExcludedIds(): Promise<string[]> {
	const fromDisk = (await readExcludedFromDisk())?.ids || [];
	const fromSettings = await readExcludedFromSettings();
	if (!fromDisk.length) return fromSettings;
	if (!fromSettings.length) return fromDisk;
	// Prefer disk as source of truth when both exist, but include any
	// settings-only ids the user may have set manually in advanced settings.
	const merged = uniqueIds([...fromDisk, ...fromSettings]);
	return merged;
}

/**
 * Persist excluded ids to disk AND Joplin settings, then update the paths display.
 */
export async function persistExcludedIds(
	ids: string[],
	pathById?: Map<string, string>
): Promise<string[]> {
	const clean = uniqueIds(ids);
	const paths = clean.map((id) => pathById?.get(id) || id);

	await writeExcludedToDisk(clean, paths);
	await joplin.settings.setValue(SettingKey.BlockedNotebookIds, clean.join('\n'));

	const label =
		paths.length === 0
			? ''
			: paths.length === 1
				? paths[0]
				: `${paths.length} excluded: ${paths.join(' · ')}`;
	await joplin.settings.setValue(SettingKey.ExcludedNotebookPathsDisplay, label);

	// Verify settings write (Joplin can silently fail in rare cases)
	const verify = await readExcludedFromSettings();
	if (verify.length !== clean.length) {
		console.warn(
			'Joplin Grok: settings write verify mismatch',
			{ expected: clean, got: verify }
		);
		// Disk still has the truth; re-push settings once
		await joplin.settings.setValue(SettingKey.BlockedNotebookIds, clean.join('\n'));
	}

	return clean;
}

/**
 * On plugin start: load merged exclusions and re-write both stores so they match.
 */
export async function hydrateExcludedOnStartup(
	resolvePaths?: (ids: string[]) => Promise<Map<string, string>>
): Promise<string[]> {
	const ids = await loadExcludedIds();
	let pathById: Map<string, string> | undefined;
	if (resolvePaths && ids.length) {
		try {
			pathById = await resolvePaths(ids);
		} catch {
			pathById = undefined;
		}
	}
	if (ids.length || (await readExcludedFromDisk()) || (await readExcludedFromSettings()).length) {
		await persistExcludedIds(ids, pathById);
	}
	return ids;
}
