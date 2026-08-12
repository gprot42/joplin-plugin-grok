import { dataGet, dataPost, fetchAllPages } from './client';
import { JoplinFolder, NotebookPathNode } from './types';

export async function listFoldersTree(): Promise<JoplinFolder[]> {
	// Joplin returns folders as a tree with children when using /folders without pagination quirks.
	const result = await dataGet<{ items?: JoplinFolder[] } | JoplinFolder[]>(['folders'], {
		fields: 'id,title,parent_id',
	});

	if (Array.isArray(result)) return result;
	if (result && Array.isArray((result as { items?: JoplinFolder[] }).items)) {
		return (result as { items: JoplinFolder[] }).items;
	}
	return [];
}

export async function listFoldersFlat(): Promise<JoplinFolder[]> {
	return fetchAllPages<JoplinFolder>(['folders'], {
		fields: 'id,title,parent_id',
	});
}

export function flattenFolderTree(folders: JoplinFolder[], parentPath = ''): NotebookPathNode[] {
	const out: NotebookPathNode[] = [];

	const walk = (nodes: JoplinFolder[], prefix: string, depth: number) => {
		for (const node of nodes) {
			const path = prefix ? `${prefix} / ${node.title}` : node.title;
			out.push({
				id: node.id,
				title: node.title,
				parent_id: node.parent_id || '',
				path,
				depth,
			});
			if (node.children && node.children.length) {
				walk(node.children, path, depth + 1);
			}
		}
	};

	// Tree API may return nested children; flat list may not.
	const hasChildren = folders.some((f) => Array.isArray(f.children) && f.children.length > 0);
	if (hasChildren) {
		walk(folders, parentPath, 0);
		return out;
	}

	// Build tree from flat list
	const byParent = new Map<string, JoplinFolder[]>();
	for (const f of folders) {
		const pid = f.parent_id || '';
		if (!byParent.has(pid)) byParent.set(pid, []);
		byParent.get(pid)!.push(f);
	}

	const walkFlat = (parentId: string, prefix: string, depth: number) => {
		const kids = byParent.get(parentId) || [];
		// stable order by title
		kids.sort((a, b) => a.title.localeCompare(b.title));
		for (const node of kids) {
			const path = prefix ? `${prefix} / ${node.title}` : node.title;
			out.push({
				id: node.id,
				title: node.title,
				parent_id: node.parent_id || '',
				path,
				depth,
			});
			walkFlat(node.id, path, depth + 1);
		}
	};

	walkFlat('', parentPath, 0);
	return out;
}

export async function listNotebookPaths(): Promise<NotebookPathNode[]> {
	const flat = await listFoldersFlat();
	return flattenFolderTree(flat);
}

export async function getFolder(id: string): Promise<JoplinFolder | null> {
	try {
		return await dataGet<JoplinFolder>(['folders', id], { fields: 'id,title,parent_id' });
	} catch {
		return null;
	}
}

export async function createFolder(title: string, parentId?: string): Promise<JoplinFolder> {
	const body: Record<string, unknown> = { title };
	if (parentId) body.parent_id = parentId;
	return dataPost<JoplinFolder>(['folders'], null, body);
}

export async function notebookPathForId(folderId: string, cache?: NotebookPathNode[]): Promise<string> {
	const nodes = cache || (await listNotebookPaths());
	const hit = nodes.find((n) => n.id === folderId);
	return hit ? hit.path : folderId;
}
