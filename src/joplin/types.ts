export interface JoplinNote {
	id: string;
	title: string;
	body?: string;
	parent_id: string;
	is_todo?: number;
	todo_completed?: number;
	todo_due?: number;
	source_url?: string;
	created_time?: number;
	updated_time?: number;
	user_updated_time?: number;
}

export interface JoplinFolder {
	id: string;
	title: string;
	parent_id: string;
	children?: JoplinFolder[];
}

export interface JoplinTag {
	id: string;
	title: string;
}

export interface Paginated<T> {
	items: T[];
	has_more: boolean;
}

export interface NoteSearchHit {
	id: string;
	title: string;
	parent_id: string;
	body?: string;
	notebook_path?: string;
	snippet?: string;
}

export interface NotebookPathNode {
	id: string;
	title: string;
	parent_id: string;
	path: string;
	depth: number;
}
