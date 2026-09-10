import { dependencyKey, type DependencyKey } from "./dependencies";
import type { FileMetadataSnapshot } from "./file-snapshot";
import { VaultIndex } from "./vault-index";

/**
 * Pure mapping layer between Obsidian lifecycle events and data dependencies.
 * Bot 1 owns event registration; Bot 3 owns the dependency semantics returned
 * here. Returned keys are intended for InvalidationEngine.invalidateMany().
 */
export class ReactiveDataEventMap {
	constructor(private readonly vaultIndex: VaultIndex) {}

	fileCreated(snapshot: FileMetadataSnapshot): readonly DependencyKey[] {
		const changed = new Set<DependencyKey>(this.vaultIndex.upsert(snapshot));
		changed.add(dependencyKey.file(snapshot.path, "content"));
		return Array.from(changed);
	}

	/** Vault modify means file bytes changed; metadata refresh is a separate event. */
	fileContentModified(path: string): readonly DependencyKey[] {
		return [dependencyKey.file(path, "content")];
	}

	/** Metadata-cache refresh may invalidate precise fields and index memberships. */
	fileMetadataRefreshed(snapshot: FileMetadataSnapshot): readonly DependencyKey[] {
		return this.vaultIndex.upsert(snapshot);
	}

	fileDeleted(path: string): readonly DependencyKey[] {
		return this.vaultIndex.remove(path);
	}

	fileRenamed(oldPath: string, snapshot: FileMetadataSnapshot): readonly DependencyKey[] {
		return this.vaultIndex.rename(oldPath, snapshot);
	}

	/** Folder events preserve empty folders for settings autocomplete. */
	folderCreated(path: string): readonly DependencyKey[] {
		return this.vaultIndex.addFolder(path);
	}

	folderDeleted(path: string): readonly DependencyKey[] {
		return this.vaultIndex.removeFolder(path);
	}

	folderRenamed(oldPath: string, newPath: string): readonly DependencyKey[] {
		return this.vaultIndex.renameFolder(oldPath, newPath);
	}

	foldersBootstrapped(paths: Iterable<string>): readonly DependencyKey[] {
		return this.vaultIndex.replaceFolders(paths);
	}

	settingsChanged(viewId?: string): readonly DependencyKey[] {
		return [dependencyKey.settings(viewId)];
	}

	baseChanged(baseId: string): readonly DependencyKey[] {
		return [dependencyKey.base(baseId)];
	}

	timeChanged(kind: "now" | "today" | "random"): readonly DependencyKey[] {
		return [dependencyKey.time(kind)];
	}
}
