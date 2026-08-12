import joplin from 'api';
import { Paginated } from './types';

type Path = string[];

export async function dataGet<T = unknown>(path: Path, query?: Record<string, unknown>): Promise<T> {
	return joplin.data.get(path, query) as Promise<T>;
}

export async function dataPost<T = unknown>(
	path: Path,
	query: Record<string, unknown> | null,
	body: Record<string, unknown>
): Promise<T> {
	return joplin.data.post(path, query, body) as Promise<T>;
}

export async function dataPut<T = unknown>(
	path: Path,
	query: Record<string, unknown> | null,
	body: Record<string, unknown>
): Promise<T> {
	return joplin.data.put(path, query, body) as Promise<T>;
}

export async function dataDelete(path: Path, query?: Record<string, unknown>): Promise<void> {
	await joplin.data.delete(path, query);
}

/** Fetch all pages from a paginated Joplin data endpoint. */
export async function fetchAllPages<T>(
	path: Path,
	query: Record<string, unknown> = {},
	pageSize = 100
): Promise<T[]> {
	const items: T[] = [];
	let page = 1;
	let hasMore = true;

	while (hasMore) {
		const result = await dataGet<Paginated<T>>(path, {
			...query,
			page,
			limit: pageSize,
		});
		items.push(...(result.items || []));
		hasMore = Boolean(result.has_more);
		page += 1;
		if (page > 1000) break;
	}

	return items;
}
