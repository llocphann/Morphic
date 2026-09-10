const RESERVED_LOOKUP_NAMES = new Set(["__proto__", "prototype", "constructor"]);

type IndexedBases = unknown[] & Record<string, unknown>;

export function buildBasesCollection(bases: readonly unknown[]): unknown[] {
	const indexed = Array.from(bases) as IndexedBases;

	for (const entry of bases) {
		if (!isPlainRecord(entry)) continue;

		for (const alias of aliasesFor(entry)) {
			if (RESERVED_LOOKUP_NAMES.has(alias)) continue;
			if (Object.prototype.hasOwnProperty.call(indexed, alias)) continue;
			Reflect.set(indexed, alias, entry);
		}
	}

	return indexed;
}

function aliasesFor(entry: Record<string, unknown>): string[] {
	const source = isPlainRecord(entry.source) ? entry.source : undefined;
	const candidates = [
		source?.name,
		entry.key,
		entry.name,
	];
	const aliases: string[] = [];

	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		if (candidate.trim().length === 0) continue;
		aliases.push(candidate);
	}

	return aliases;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
