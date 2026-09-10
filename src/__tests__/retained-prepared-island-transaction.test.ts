import { describe, expect, it, vi } from "vitest";
import { RetainedCommitTransaction } from "../render/retained-commit-transaction";
import {
	RetainedDomRuntime,
	type RetainedIslandPreparationResult,
	type RetainedPreparedIslandPatch,
} from "../render/retained-slot-runtime";

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

function createPairRuntime(ownerDocument: Document = createOwnerDocument()) {
	const root = ownerDocument.createElement("div");
	const runtime = new RetainedDomRuntime(root);
	runtime.mountStructure("pair", ({ fragment, ownerDocument: doc, markdownSlot }) => {
		const first = doc.createElement("section");
		const second = doc.createElement("section");
		markdownSlot("first", first);
		markdownSlot("second", second);
		fragment.append(first, second);
	});
	return {
		root,
		runtime,
		first: root.children[0] as HTMLElement,
		second: root.children[1] as HTMLElement,
	};
}

async function commitStable(
	runtime: RetainedDomRuntime,
	id: "first" | "second",
	label: string,
	cleanup: () => void,
): Promise<void> {
	const result = await runtime.patchMarkdown(id, `stable:${id}`, ({ container, ownerDocument, resources }) => {
		const node = ownerDocument.createElement("span");
		node.textContent = label;
		container.appendChild(node);
		resources.register(cleanup);
	});
	expect(result).toEqual({ status: "patched" });
}

async function prepareNext(
	runtime: RetainedDomRuntime,
	id: "first" | "second",
	label: string,
	cleanup: () => void,
): Promise<RetainedPreparedIslandPatch> {
	return requirePrepared(await runtime.prepareMarkdown(
		id,
		`next:${id}`,
		({ container, ownerDocument, resources }) => {
			const node = ownerDocument.createElement("strong");
			node.textContent = label;
			container.appendChild(node);
			resources.register(cleanup);
		},
	));
}

describe("prepared retained island transaction participants", () => {
	it("commits multiple prepared islands before disposing either previous resource scope", async () => {
		const { runtime, first, second } = createPairRuntime();
		const firstStableCleanup = vi.fn(() => {
			expect(first.textContent).toBe("First next");
			expect(second.textContent).toBe("Second next");
		});
		const secondStableCleanup = vi.fn(() => {
			expect(first.textContent).toBe("First next");
			expect(second.textContent).toBe("Second next");
		});
		await commitStable(runtime, "first", "First stable", firstStableCleanup);
		await commitStable(runtime, "second", "Second stable", secondStableCleanup);

		const firstNextCleanup = vi.fn();
		const secondNextCleanup = vi.fn();
		const firstPrepared = await prepareNext(runtime, "first", "First next", firstNextCleanup);
		const secondPrepared = await prepareNext(runtime, "second", "Second next", secondNextCleanup);
		const transaction = new RetainedCommitTransaction(() => true);

		expect(transaction.commit([
			firstPrepared.toCommitParticipant(),
			secondPrepared.toCommitParticipant(),
		])).toEqual({ status: "committed" });
		expect(first.textContent).toBe("First next");
		expect(second.textContent).toBe("Second next");
		expect(firstStableCleanup).toHaveBeenCalledTimes(1);
		expect(secondStableCleanup).toHaveBeenCalledTimes(1);
		expect(firstNextCleanup).not.toHaveBeenCalled();
		expect(secondNextCleanup).not.toHaveBeenCalled();

		runtime.dispose();
		expect(firstNextCleanup).toHaveBeenCalledTimes(1);
		expect(secondNextCleanup).toHaveBeenCalledTimes(1);
	});

	it("rolls back an earlier prepared island by exact Node identity when a later island apply fails", async () => {
		const { runtime, first, second } = createPairRuntime();
		const firstStableCleanup = vi.fn();
		const secondStableCleanup = vi.fn();
		await commitStable(runtime, "first", "First stable", firstStableCleanup);
		await commitStable(runtime, "second", "Second stable", secondStableCleanup);
		const firstStableNode = first.firstChild;
		const secondStableNode = second.firstChild;

		const firstNextCleanup = vi.fn();
		const secondNextCleanup = vi.fn();
		const firstPrepared = await prepareNext(runtime, "first", "First next", firstNextCleanup);
		const secondPrepared = await prepareNext(runtime, "second", "Second next", secondNextCleanup);
		const failure = new Error("Second island apply failed");
		vi.spyOn(second, "replaceChildren").mockImplementationOnce(() => {
			throw failure;
		});
		const transaction = new RetainedCommitTransaction(() => true);

		const result = transaction.commit([
			firstPrepared.toCommitParticipant(),
			secondPrepared.toCommitParticipant(),
		]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(first.firstChild).toBe(firstStableNode);
		expect(second.firstChild).toBe(secondStableNode);
		expect(firstStableCleanup).not.toHaveBeenCalled();
		expect(secondStableCleanup).not.toHaveBeenCalled();
		expect(firstNextCleanup).toHaveBeenCalledTimes(1);
		expect(secondNextCleanup).toHaveBeenCalledTimes(1);
	});

	it("rolls back a prepared island when owner currentness changes reentrantly after apply", async () => {
		const { runtime, first, second } = createPairRuntime();
		const firstStableCleanup = vi.fn();
		const secondStableCleanup = vi.fn();
		await commitStable(runtime, "first", "First stable", firstStableCleanup);
		await commitStable(runtime, "second", "Second stable", secondStableCleanup);
		const firstStableNode = first.firstChild;
		const secondStableNode = second.firstChild;
		const firstNextCleanup = vi.fn();
		const secondNextCleanup = vi.fn();
		const firstPrepared = await prepareNext(runtime, "first", "First next", firstNextCleanup);
		const secondPrepared = await prepareNext(runtime, "second", "Second next", secondNextCleanup);

		let ownerCurrent = true;
		const replaceFirst = first.replaceChildren.bind(first);
		vi.spyOn(first, "replaceChildren").mockImplementation((...nodes) => {
			replaceFirst(...nodes);
			ownerCurrent = false;
		});
		const transaction = new RetainedCommitTransaction(() => ownerCurrent);

		expect(transaction.commit([
			firstPrepared.toCommitParticipant(),
			secondPrepared.toCommitParticipant(),
		])).toEqual({ status: "stale" });
		expect(first.firstChild).toBe(firstStableNode);
		expect(second.firstChild).toBe(secondStableNode);
		expect(firstStableCleanup).not.toHaveBeenCalled();
		expect(secondStableCleanup).not.toHaveBeenCalled();
		expect(firstNextCleanup).toHaveBeenCalledTimes(1);
		expect(secondNextCleanup).toHaveBeenCalledTimes(1);
	});

	it("rejects an older prepared participant after a newer island generation supersedes it", async () => {
		const { runtime, first } = createPairRuntime();
		const oldCleanup = vi.fn();
		const oldPrepared = requirePrepared(await runtime.prepareMarkdown(
			"first",
			"old",
			({ container, resources }) => {
				container.textContent = "Old generation";
				resources.register(oldCleanup);
			},
		));
		const nextPrepared = requirePrepared(await runtime.prepareMarkdown(
			"first",
			"new",
			({ container }) => {
				container.textContent = "New generation";
			},
		));
		const transaction = new RetainedCommitTransaction(() => true);

		expect(oldCleanup).toHaveBeenCalledTimes(1);
		expect(transaction.commit([oldPrepared.toCommitParticipant()])).toEqual({
			status: "stale",
		});
		expect(first.textContent).toBe("");
		expect(nextPrepared.commit()).toEqual({ status: "patched" });
		expect(first.textContent).toBe("New generation");
	});

	it("keeps direct prepared commit compatibility after exposing the participant view", async () => {
		const { runtime, first } = createPairRuntime();
		const nextCleanup = vi.fn();
		const prepared = await prepareNext(runtime, "first", "Direct next", nextCleanup);

		expect(prepared.toCommitParticipant()).toBe(prepared);
		expect(prepared.commit()).toEqual({ status: "patched" });
		expect(first.textContent).toBe("Direct next");
		expect(prepared.commit()).toEqual({ status: "patched" });
		expect(nextCleanup).not.toHaveBeenCalled();

		runtime.dispose();
		expect(nextCleanup).toHaveBeenCalledTimes(1);
	});

	it("preserves the committed surface when structure replacement invalidates a prepared participant", async () => {
		const { root, runtime } = createPairRuntime();
		const stagedCleanup = vi.fn();
		const prepared = requirePrepared(await runtime.prepareMarkdown(
			"first",
			"pending",
			({ container, resources }) => {
				container.textContent = "Pending";
				resources.register(stagedCleanup);
			},
		));
		runtime.mountStructure("replacement", ({ fragment, ownerDocument, textSlot }) => {
			const paragraph = ownerDocument.createElement("p");
			paragraph.appendChild(textSlot("label", "Replacement"));
			fragment.appendChild(paragraph);
		});
		const transaction = new RetainedCommitTransaction(() => true);

		expect(stagedCleanup).toHaveBeenCalledTimes(1);
		expect(transaction.commit([prepared.toCommitParticipant()])).toEqual({ status: "stale" });
		expect(root.textContent).toBe("Replacement");
		expect(stagedCleanup).toHaveBeenCalledTimes(1);
	});

	it("commits a prepared content island through the same ownerDocument-safe participant contract", async () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		runtime.mountStructure("content", ({ fragment, ownerDocument: doc, contentSlot }) => {
			const slot = doc.createElement("article");
			contentSlot("body", slot);
			fragment.appendChild(slot);
		});
		const slot = root.firstElementChild as HTMLElement;
		const prepared = requirePrepared(await runtime.prepareContent(
			"body",
			"content-next",
			({ container, ownerDocument: contextDocument }) => {
				expect(contextDocument).toBe(ownerDocument);
				const child = contextDocument.createElement("p");
				child.textContent = "Content next";
				container.appendChild(child);
			},
		));
		const transaction = new RetainedCommitTransaction(() => true);

		expect(transaction.commit([prepared.toCommitParticipant()])).toEqual({ status: "committed" });
		expect(slot.textContent).toBe("Content next");
		expect(slot.firstChild?.ownerDocument).toBe(ownerDocument);
	});

	it("makes discarded participant handles terminal and unable to mutate live DOM later", async () => {
		const { runtime, first } = createPairRuntime();
		const stagedCleanup = vi.fn();
		const prepared = await prepareNext(runtime, "first", "Discarded next", stagedCleanup);
		const participant = prepared.toCommitParticipant();

		participant.discard();
		participant.discard();
		expect(stagedCleanup).toHaveBeenCalledTimes(1);
		expect(prepared.isCurrent()).toBe(false);
		expect(prepared.commit()).toEqual({ status: "stale" });
		expect(first.textContent).toBe("");
	});
});