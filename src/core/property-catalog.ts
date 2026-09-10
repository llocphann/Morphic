import { dependencyKey, type DependencyCollector, type DependencyKey } from "./dependencies";
import type { FileMetadataSnapshot } from "./file-snapshot";

export type PropertyValueType =
	| "text"
	| "number"
	| "date"
	| "datetime"
	| "list"
	| "checkbox"
	| "unknown";

export interface PropertyTypeDefinition {
	readonly name: string;
	readonly type: PropertyValueType;
}

export interface PropertyCatalogStats {
	readonly files: number;
	readonly properties: number;
}

interface FilePropertyTypes {
	readonly order: number;
	readonly values: Readonly<Record<string, PropertyValueType>>;
	readonly templateValues: Readonly<Record<string, PropertyValueType>>;
}

interface PropertyMember {
	readonly order: number;
	readonly type: PropertyValueType;
}

/** Incremental, App-free property type catalogue for Settings/editor consumers. */
export class IncrementalPropertyCatalog {
	private readonly files = new Map<string, FilePropertyTypes>();
	private readonly members = new Map<string, Map<string, PropertyMember>>();
	private readonly resolved = new Map<string, PropertyValueType>();
	private readonly templateMembers = new Map<string, Map<string, PropertyMember>>();
	private readonly templateResolved = new Map<string, PropertyValueType>();
	private nextOrder = 0;
	private definitionsCache: readonly PropertyTypeDefinition[] | undefined;
	private templateDefinitionsCache: readonly PropertyTypeDefinition[] | undefined;

	upsert(snapshot: FileMetadataSnapshot): readonly DependencyKey[] {
		const previous = this.files.get(snapshot.path);
		const genericMatches = previous
			? frontmatterMatchesPropertyTypes(snapshot.frontmatter, previous.values)
			: false;
		const templateMatches = previous
			? frontmatterMatchesTemplatePropertyTypes(snapshot.frontmatter, previous.templateValues)
			: false;
		if (previous && genericMatches && templateMatches) return [];

		const order = previous?.order ?? this.nextOrder++;
		const nextValues = previous && genericMatches
			? previous.values
			: inferFrontmatterTypes(snapshot.frontmatter);
		const nextTemplateValues = previous && templateMatches
			? previous.templateValues
			: inferTemplateFrontmatterTypes(snapshot.frontmatter);
		let genericChanges: readonly DependencyKey[] = [];
		let templateChanges: readonly DependencyKey[] = [];

		if (!previous || !genericMatches) {
			const affected = unionKeys(previous?.values, nextValues);
			const before = this.capture(affected);
			if (previous) this.removeMemberships(snapshot.path, previous.values);
			this.addMemberships(snapshot.path, order, nextValues);
			genericChanges = this.collectChanges(affected, before);
		}

		if (!previous || !templateMatches) {
			const affected = unionKeys(previous?.templateValues, nextTemplateValues);
			const before = this.captureTemplate(affected);
			if (previous) this.removeTemplateMemberships(snapshot.path, previous.templateValues);
			this.addTemplateMemberships(snapshot.path, order, nextTemplateValues);
			templateChanges = this.collectTemplateChanges(affected, before);
		}

		this.files.set(snapshot.path, {
			order,
			values: nextValues,
			templateValues: nextTemplateValues,
		});
		return mergeDependencyKeys(genericChanges, templateChanges);
	}

	remove(path: string): readonly DependencyKey[] {
		const previous = this.files.get(path);
		if (!previous) return [];
		const affected = Object.keys(previous.values);
		const templateAffected = Object.keys(previous.templateValues);
		const before = this.capture(affected);
		const templateBefore = this.captureTemplate(templateAffected);
		this.removeMemberships(path, previous.values);
		this.removeTemplateMemberships(path, previous.templateValues);
		this.files.delete(path);
		return mergeDependencyKeys(
			this.collectChanges(affected, before),
			this.collectTemplateChanges(templateAffected, templateBefore),
		);
	}

	/** Rename is atomic and preserves the file's original inference order. */
	rename(oldPath: string, snapshot: FileMetadataSnapshot): readonly DependencyKey[] {
		if (oldPath === snapshot.path) return this.upsert(snapshot);
		const previous = this.files.get(oldPath);
		if (!previous) return this.upsert(snapshot);

		const nextValues = inferFrontmatterTypes(snapshot.frontmatter);
		const nextTemplateValues = inferTemplateFrontmatterTypes(snapshot.frontmatter);
		const affected = unionKeys(previous.values, nextValues);
		const templateAffected = unionKeys(previous.templateValues, nextTemplateValues);
		const before = this.capture(affected);
		const templateBefore = this.captureTemplate(templateAffected);
		this.removeMemberships(oldPath, previous.values);
		this.removeTemplateMemberships(oldPath, previous.templateValues);
		this.files.delete(oldPath);
		this.files.set(snapshot.path, {
			order: previous.order,
			values: nextValues,
			templateValues: nextTemplateValues,
		});
		this.addMemberships(snapshot.path, previous.order, nextValues);
		this.addTemplateMemberships(snapshot.path, previous.order, nextTemplateValues);
		return mergeDependencyKeys(
			this.collectChanges(affected, before),
			this.collectTemplateChanges(templateAffected, templateBefore),
		);
	}

	/**
	 * Rebuild the catalogue from bootstrap snapshots without materializing
	 * per-file invalidation diffs. Bootstrap order is the inference order, so the
	 * first concrete type for each property can be resolved incrementally in O(1)
	 * per membership instead of rescanning all prior members after every file.
	 */
	bootstrap(snapshots: Iterable<FileMetadataSnapshot>): void {
		this.clear();
		for (const snapshot of snapshots) this.seedBootstrapSnapshot(snapshot);
	}

	/**
	 * Lifecycle-only streaming seed used by ReactiveDataCore.bootstrap().
	 * Callers must clear the catalogue before the first snapshot. Unique paths use
	 * the same O(1)-per-membership resolution as bootstrap(); duplicate paths fall
	 * back to incremental upsert so replacement/order semantics remain exact.
	 */
	seedBootstrapSnapshot(snapshot: FileMetadataSnapshot): void {
		if (this.files.has(snapshot.path)) {
			this.upsert(snapshot);
			return;
		}

		const order = this.nextOrder++;
		const values = inferFrontmatterTypes(snapshot.frontmatter);
		const templateValues = inferTemplateFrontmatterTypes(snapshot.frontmatter);
		this.files.set(snapshot.path, { order, values, templateValues });

		for (const [property, type] of Object.entries(values)) {
			let propertyMembers = this.members.get(property);
			if (!propertyMembers) {
				propertyMembers = new Map<string, PropertyMember>();
				this.members.set(property, propertyMembers);
			}
			propertyMembers.set(snapshot.path, { order, type });

			const current = this.resolved.get(property);
			if (current === undefined || (current === "unknown" && type !== "unknown")) {
				this.resolved.set(property, type);
			}
		}

		for (const [property, type] of Object.entries(templateValues)) {
			let propertyMembers = this.templateMembers.get(property);
			if (!propertyMembers) {
				propertyMembers = new Map<string, PropertyMember>();
				this.templateMembers.set(property, propertyMembers);
			}
			propertyMembers.set(snapshot.path, { order, type });

			const current = this.templateResolved.get(property);
			if (current === undefined || (current === "unknown" && type !== "unknown")) {
				this.templateResolved.set(property, type);
			}
		}
	}

	inferredType(name: string, collector?: DependencyCollector): PropertyValueType {
		collector?.track(dependencyKey.index("property-type", name));
		return this.resolved.get(name) ?? "unknown";
	}

	definitions(collector?: DependencyCollector): readonly PropertyTypeDefinition[] {
		collector?.track(dependencyKey.index("property-types"));
		if (this.definitionsCache) return this.definitionsCache;
		this.definitionsCache = Object.freeze(
			Array.from(this.members.keys())
				.sort()
				.map(name => Object.freeze({
					name,
					type: this.resolved.get(name) ?? "unknown",
				})),
		);
		return this.definitionsCache;
	}

	/**
	 * Template-variable property definitions preserve the EditView surface:
	 * every frontmatter key except position, including tags and aliases.
	 */
	templateDefinitions(collector?: DependencyCollector): readonly PropertyTypeDefinition[] {
		collector?.track(dependencyKey.index("template-property-types"));
		if (this.templateDefinitionsCache) return this.templateDefinitionsCache;
		this.templateDefinitionsCache = Object.freeze(
			Array.from(this.templateMembers.keys())
				.sort((left, right) => left.localeCompare(right))
				.map(name => Object.freeze({
					name,
					type: this.templateResolved.get(name) ?? "unknown",
				})),
		);
		return this.templateDefinitionsCache;
	}

	clear(): void {
		this.files.clear();
		this.members.clear();
		this.resolved.clear();
		this.templateMembers.clear();
		this.templateResolved.clear();
		this.nextOrder = 0;
		this.definitionsCache = undefined;
		this.templateDefinitionsCache = undefined;
	}

	stats(): PropertyCatalogStats {
		return Object.freeze({ files: this.files.size, properties: this.members.size });
	}

	private capture(properties: Iterable<string>): Map<string, PropertyValueType | undefined> {
		const result = new Map<string, PropertyValueType | undefined>();
		for (const property of properties) result.set(property, this.resolved.get(property));
		return result;
	}

	private captureTemplate(properties: Iterable<string>): Map<string, PropertyValueType | undefined> {
		const result = new Map<string, PropertyValueType | undefined>();
		for (const property of properties) result.set(property, this.templateResolved.get(property));
		return result;
	}

	private collectChanges(
		properties: Iterable<string>,
		before: ReadonlyMap<string, PropertyValueType | undefined>,
	): readonly DependencyKey[] {
		const changed = new Set<DependencyKey>();
		let coarseChanged = false;
		for (const property of properties) {
			const next = this.resolve(property);
			const previous = before.get(property);
			if (next === undefined) this.resolved.delete(property);
			else this.resolved.set(property, next);
			if (previous !== next) {
				changed.add(dependencyKey.index("property-type", property));
				coarseChanged = true;
			}
		}
		if (coarseChanged) {
			changed.add(dependencyKey.index("property-types"));
			this.definitionsCache = undefined;
		}
		return Array.from(changed);
	}

	private collectTemplateChanges(
		properties: Iterable<string>,
		before: ReadonlyMap<string, PropertyValueType | undefined>,
	): readonly DependencyKey[] {
		let coarseChanged = false;
		for (const property of properties) {
			const next = this.resolveTemplate(property);
			const previous = before.get(property);
			if (next === undefined) this.templateResolved.delete(property);
			else this.templateResolved.set(property, next);
			if (previous !== next) coarseChanged = true;
		}
		if (!coarseChanged) return [];
		this.templateDefinitionsCache = undefined;
		return [dependencyKey.index("template-property-types")];
	}

	private resolve(property: string): PropertyValueType | undefined {
		return resolvePropertyType(this.members.get(property));
	}

	private resolveTemplate(property: string): PropertyValueType | undefined {
		return resolvePropertyType(this.templateMembers.get(property));
	}

	private addMemberships(path: string, order: number, values: Readonly<Record<string, PropertyValueType>>): void {
		for (const [property, type] of Object.entries(values)) {
			let propertyMembers = this.members.get(property);
			if (!propertyMembers) {
				propertyMembers = new Map<string, PropertyMember>();
				this.members.set(property, propertyMembers);
			}
			propertyMembers.set(path, { order, type });
		}
	}

	private addTemplateMemberships(
		path: string,
		order: number,
		values: Readonly<Record<string, PropertyValueType>>,
	): void {
		for (const [property, type] of Object.entries(values)) {
			let propertyMembers = this.templateMembers.get(property);
			if (!propertyMembers) {
				propertyMembers = new Map<string, PropertyMember>();
				this.templateMembers.set(property, propertyMembers);
			}
			propertyMembers.set(path, { order, type });
		}
	}

	private removeMemberships(path: string, values: Readonly<Record<string, PropertyValueType>>): void {
		for (const property of Object.keys(values)) {
			const propertyMembers = this.members.get(property);
			if (!propertyMembers) continue;
			propertyMembers.delete(path);
			if (propertyMembers.size === 0) this.members.delete(property);
		}
	}

	private removeTemplateMemberships(
		path: string,
		values: Readonly<Record<string, PropertyValueType>>,
	): void {
		for (const property of Object.keys(values)) {
			const propertyMembers = this.templateMembers.get(property);
			if (!propertyMembers) continue;
			propertyMembers.delete(path);
			if (propertyMembers.size === 0) this.templateMembers.delete(property);
		}
	}
}

export function inferPropertyValueType(value: unknown): PropertyValueType {
	if (value === null || value === undefined) return "unknown";
	if (Array.isArray(value)) return "list";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "checkbox";
	if (typeof value === "string") {
		if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "datetime";
		if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
		return "text";
	}
	return "text";
}

function inferFrontmatterTypes(
	frontmatter: Readonly<Record<string, unknown>>,
): Readonly<Record<string, PropertyValueType>> {
	const result = Object.create(null) as Record<string, PropertyValueType>;
	for (const [property, value] of Object.entries(frontmatter)) {
		if (isReservedProperty(property)) continue;
		result[property] = inferPropertyValueType(value);
	}
	return Object.freeze(result);
}

function inferTemplateFrontmatterTypes(
	frontmatter: Readonly<Record<string, unknown>>,
): Readonly<Record<string, PropertyValueType>> {
	const result = Object.create(null) as Record<string, PropertyValueType>;
	for (const [property, value] of Object.entries(frontmatter)) {
		if (isTemplateReservedProperty(property)) continue;
		result[property] = inferPropertyValueType(value);
	}
	return Object.freeze(result);
}

/**
 * Allocation-free semantic probe for the common metadata-refresh no-op path.
 * A fresh frontmatter object is compared directly with the catalogue's retained
 * inferred type map; only a real type/key-set change materializes a replacement map.
 */
function frontmatterMatchesPropertyTypes(
	frontmatter: Readonly<Record<string, unknown>>,
	expected: Readonly<Record<string, PropertyValueType>>,
): boolean {
	return frontmatterMatchesTypes(frontmatter, expected, isReservedProperty);
}

function frontmatterMatchesTemplatePropertyTypes(
	frontmatter: Readonly<Record<string, unknown>>,
	expected: Readonly<Record<string, PropertyValueType>>,
): boolean {
	return frontmatterMatchesTypes(frontmatter, expected, isTemplateReservedProperty);
}

function frontmatterMatchesTypes(
	frontmatter: Readonly<Record<string, unknown>>,
	expected: Readonly<Record<string, PropertyValueType>>,
	isReserved: (property: string) => boolean,
): boolean {
	let propertyCount = 0;
	for (const property in frontmatter) {
		if (!Object.prototype.hasOwnProperty.call(frontmatter, property) || isReserved(property)) continue;
		propertyCount++;
		if (
			!Object.prototype.hasOwnProperty.call(expected, property)
			|| expected[property] !== inferPropertyValueType(frontmatter[property])
		) {
			return false;
		}
	}

	let expectedCount = 0;
	for (const property in expected) {
		if (Object.prototype.hasOwnProperty.call(expected, property)) expectedCount++;
	}
	return propertyCount === expectedCount;
}

function isReservedProperty(property: string): boolean {
	return property === "position" || property === "tags" || property === "aliases";
}

function isTemplateReservedProperty(property: string): boolean {
	return property === "position";
}

function resolvePropertyType(
	members: ReadonlyMap<string, PropertyMember> | undefined,
): PropertyValueType | undefined {
	if (!members || members.size === 0) return undefined;
	let first: PropertyMember | undefined;
	let firstConcrete: PropertyMember | undefined;
	for (const member of members.values()) {
		if (!first || member.order < first.order) first = member;
		if (member.type !== "unknown" && (!firstConcrete || member.order < firstConcrete.order)) {
			firstConcrete = member;
		}
	}
	return firstConcrete?.type ?? first?.type ?? "unknown";
}

function mergeDependencyKeys(
	left: readonly DependencyKey[],
	right: readonly DependencyKey[],
): readonly DependencyKey[] {
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	return Array.from(new Set([...left, ...right]));
}

function unionKeys(
	left: Readonly<Record<string, unknown>> | undefined,
	right: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
	return Array.from(new Set([
		...Object.keys(left ?? {}),
		...Object.keys(right ?? {}),
	]));
}
