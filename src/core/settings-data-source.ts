import type { DependencyCollector } from "./dependencies";
import type {
	IncrementalPropertyCatalog,
	PropertyTypeDefinition,
	PropertyValueType,
} from "./property-catalog";
import type { RevisionedVaultQueryCache } from "./vault-query-cache";

export type AssignedPropertyTypeResolver = (name: string) => PropertyValueType | undefined;

/**
 * Lifecycle-owned Settings/autocomplete data source backed by the shared
 * revisioned VaultIndex query cache and incremental property type catalogue.
 * It deliberately has no App/Vault access, so consumers cannot accidentally
 * fall back to whole-vault rescans.
 */
export class VaultSettingsDataSource {
	private fileInput: readonly string[] | undefined;
	private fileValues: readonly string[] | undefined;
	private folderInput: readonly string[] | undefined;
	private folderValues: readonly string[] | undefined;
	private tagInput: readonly string[] | undefined;
	private tagValues: readonly string[] | undefined;

	constructor(
		private readonly queries: RevisionedVaultQueryCache,
		private readonly propertyCatalog: IncrementalPropertyCatalog,
	) {}

	/** Matches FileSuggest semantics: Markdown paths without the .md suffix. */
	files(collector?: DependencyCollector): readonly string[] {
		const input = this.queries.allPaths(collector);
		if (input === this.fileInput && this.fileValues) return this.fileValues;
		const values = Object.freeze(
			input
				.filter(isMarkdownPath)
				.map(stripMarkdownExtension)
				.sort(localeCompare),
		);
		this.fileInput = input;
		this.fileValues = values;
		return values;
	}

	/** Matches FolderSuggest semantics: root is represented by "/". */
	folders(collector?: DependencyCollector): readonly string[] {
		const input = this.queries.folderPaths(collector);
		if (input === this.folderInput && this.folderValues) return this.folderValues;
		const values = Object.freeze(["/", ...input].sort(localeCompare));
		this.folderInput = input;
		this.folderValues = values;
		return values;
	}

	/** Matches TagSuggest semantics: values are exposed without leading #. */
	tags(collector?: DependencyCollector): readonly string[] {
		const input = this.queries.allTags(collector);
		if (input === this.tagInput && this.tagValues) return this.tagValues;
		const values = Object.freeze(input.map(tag => tag.replace(/^#+/, "")).sort());
		this.tagInput = input;
		this.tagValues = values;
		return values;
	}

	/** Existing frontmatter keys, sorted by VaultIndex. */
	properties(collector?: DependencyCollector): readonly string[] {
		return this.queries.propertyNames(collector);
	}

	/**
	 * Existing frontmatter keys with their incrementally inferred type.
	 *
	 * An injected assigned-type resolver lets Bot 1 preserve Obsidian's
	 * metadataTypeManager precedence without giving this provider App access.
	 * Resolver work is O(property-count), never O(vault-file-count).
	 */
	propertyDefinitions(
		resolveAssignedType?: AssignedPropertyTypeResolver,
		collector?: DependencyCollector,
	): readonly PropertyTypeDefinition[] {
		const inferred = this.propertyCatalog.definitions(collector);
		if (!resolveAssignedType) return inferred;
		return Object.freeze(inferred.map(definition => Object.freeze({
			name: definition.name,
			type: resolveAssignedType(definition.name) ?? definition.type,
		})));
	}

	/**
	 * Existing frontmatter keys for EditView template variables, excluding only
	 * position. Unlike propertyDefinitions(), this surface intentionally keeps
	 * tags and aliases while retaining the catalogue's first-concrete inference.
	 */
	templatePropertyDefinitions(
		resolveAssignedType?: AssignedPropertyTypeResolver,
		collector?: DependencyCollector,
	): readonly PropertyTypeDefinition[] {
		const inferred = this.propertyCatalog.templateDefinitions(collector);
		if (!resolveAssignedType) return inferred;
		return Object.freeze(inferred.map(definition => Object.freeze({
			name: definition.name,
			type: resolveAssignedType(definition.name) ?? definition.type,
		})));
	}

	/** Existing values for one frontmatter property with legacy Settings coercion. */
	propertyValues(name: string, collector?: DependencyCollector): readonly string[] {
		return this.queries.settingsPropertySuggestionValues(name, collector);
	}

	/**
	 * Clear only transformed view caches. The underlying query/type caches have
	 * their own revision/retention policy and remain authoritative for freshness.
	 */
	clear(): void {
		this.fileInput = undefined;
		this.fileValues = undefined;
		this.folderInput = undefined;
		this.folderValues = undefined;
		this.tagInput = undefined;
		this.tagValues = undefined;
	}
}

function isMarkdownPath(path: string): boolean {
	return path.endsWith(".md");
}

function stripMarkdownExtension(path: string): string {
	return path.slice(0, -3);
}

function localeCompare(left: string, right: string): number {
	return left.localeCompare(right);
}
