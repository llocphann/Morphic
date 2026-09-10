import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedDomRuntime,
	type RetainedIslandPreparationResult,
	type RetainedPreparedIslandPatch,
} from "../render/retained-slot-runtime";

function createParticipant(
	name: string,
	events: string[],
	overrides: Partial<RetainedCommitParticipant> = {},
): RetainedCommitParticipant {
	return {
		isCurrent: () => true,
		apply: () => events.push(`${name}:apply`),
		adopt: () => events.push(`${name}:adopt`),
		rollback: () => events.push(`${name}:rollback`),
		finalize: () => events.push(`${name}:finalize`),
		discard: () => events.push(`${name}:discard`),
		...overrides,
	};
}

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function requirePrepared(result: RetainedIslandPreparationResult): RetainedPreparedIslandPatch {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared island, received ${result.status}`);
	}
	return result;
}

describe("retained commit adoption barrier", () => {
	it("adopts every participant before any irreversible finalization", () => {
		const events: string[] = [];
		const first = createParticipant("first", events);
		const second = createParticipant("second", events);
		const transaction = new RetainedCommitTransaction(() => true);

		expect(transaction.commit([first, second])).toEqual({ status: "committed" });
		expect(events).toEqual([
			"first:apply",
			"second:apply",
			"first:adopt",
			"second:adopt",
			"first:finalize",
			"second:finalize",
		]);
	});

	it("rolls back every live mutation and completed adoption when a later adoption throws", () => {
		const events: string[] = [];
		let firstAdopted = false;
		const failure = new Error("Second adoption failed");
		const first = createParticipant("first", events, {
			adopt: () => {
				firstAdopted = true;
				events.push("first:adopt");
			},
			rollback: () => {
				firstAdopted = false;
				events.push("first:rollback");
			},
		});
		const second = createParticipant("second", events, {
			adopt: () => {
				events.push("second:adopt");
				throw failure;
			},
		});
		const transaction = new RetainedCommitTransaction(() => true);

		const result = transaction.commit([first, second]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(firstAdopted).toBe(false);
		expect(events).toEqual([
			"first:apply",
			"second:apply",
			"first:adopt",
			"second:adopt",
			"second:rollback",
			"first:rollback",
			"first:discard",
			"second:discard",
		]);
	});

	it("rechecks owner currentness between adoptions and rolls back on reentrant staleness", () => {
		const events: string[] = [];
		let ownerCurrent = true;
		const first = createParticipant("first", events, {
			adopt: () => {
				events.push("first:adopt");
				ownerCurrent = false;
			},
		});
		const second = createParticipant("second", events);
		const transaction = new RetainedCommitTransaction(() => ownerCurrent);

		expect(transaction.commit([first, second])).toEqual({ status: "stale" });
		expect(events).toEqual([
			"first:apply",
			"second:apply",
			"first:adopt",
			"second:rollback",
			"first:rollback",
			"first:discard",
			"second:discard",
		]);
	});

	it("treats reentrant transaction disposal during apply as terminal and rolls back", () => {
		const events: string[] = [];
		let transaction!: RetainedCommitTransaction;
		const first = createParticipant("first", events, {
			apply: () => {
				events.push("first:apply");
				transaction.dispose();
			},
		});
		const second = createParticipant("second", events);
		transaction = new RetainedCommitTransaction(() => true);

		expect(transaction.commit([first, second])).toEqual({ status: "disposed" });
		expect(events).toEqual([
			"first:apply",
			"first:rollback",
			"first:discard",
			"second:discard",
		]);
	});

	it("does not revalidate after adoption when cleanup schedules newer owner work", () => {
		const events: string[] = [];
		let ownerCurrent = true;
		const first = createParticipant("first", events, {
			finalize: () => {
				events.push("first:finalize");
				ownerCurrent = false;
			},
		});
		const second = createParticipant("second", events);
		const transaction = new RetainedCommitTransaction(() => ownerCurrent);

		expect(transaction.commit([first, second])).toEqual({ status: "committed" });
		expect(events.slice(-2)).toEqual(["first:finalize", "second:finalize"]);
	});

	it("adopts all prepared island resources before an old-scope cleanup can replace the structure", async () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		runtime.mountStructure("pair", ({ fragment, ownerDocument: doc, markdownSlot }) => {
			const first = doc.createElement("section");
			const second = doc.createElement("section");
			markdownSlot("first", first);
			markdownSlot("second", second);
			fragment.append(first, second);
		});

		const firstOldCleanup = vi.fn(() => {
			runtime.mountStructure("replacement", ({ fragment, ownerDocument: doc }) => {
				const replacement = doc.createElement("p");
				replacement.textContent = "Replacement surface";
				fragment.appendChild(replacement);
			});
		});
		const secondOldCleanup = vi.fn();
		expect(await runtime.patchMarkdown("first", "old:first", ({ container, resources }) => {
			container.textContent = "First old";
			resources.register(firstOldCleanup);
		})).toEqual({ status: "patched" });
		expect(await runtime.patchMarkdown("second", "old:second", ({ container, resources }) => {
			container.textContent = "Second old";
			resources.register(secondOldCleanup);
		})).toEqual({ status: "patched" });

		const firstNewCleanup = vi.fn();
		const secondNewCleanup = vi.fn();
		const firstPrepared = requirePrepared(await runtime.prepareMarkdown(
			"first",
			"new:first",
			({ container, resources }) => {
				container.textContent = "First new";
				resources.register(firstNewCleanup);
			},
		));
		const secondPrepared = requirePrepared(await runtime.prepareMarkdown(
			"second",
			"new:second",
			({ container, resources }) => {
				container.textContent = "Second new";
				resources.register(secondNewCleanup);
			},
		));
		const transaction = new RetainedCommitTransaction(() => true);

		expect(transaction.commit([
			firstPrepared.toCommitParticipant(),
			secondPrepared.toCommitParticipant(),
		])).toEqual({ status: "committed" });
		expect(root.textContent).toBe("Replacement surface");
		expect(firstOldCleanup).toHaveBeenCalledTimes(1);
		expect(secondOldCleanup).toHaveBeenCalledTimes(1);
		expect(firstNewCleanup).toHaveBeenCalledTimes(1);
		expect(secondNewCleanup).toHaveBeenCalledTimes(1);
	});
});
