import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import { RetainedKeyedSlotScope } from "../render/scoped-keyed-slot-runtime";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function mountMarkdownScope(ownerDocument: Document) {
	const scope = new RetainedKeyedSlotScope(ownerDocument);
	const roots = scope.mount((context) => {
		const target = ownerDocument.createElement("span");
		context.markdownSlot("markdown", target);
		context.fragment.append(target);
	});
	return { scope, target: roots[0] as HTMLElement };
}

function mountContentScope(ownerDocument: Document) {
	const scope = new RetainedKeyedSlotScope(ownerDocument);
	const roots = scope.mount((context) => {
		const target = ownerDocument.createElement("div");
		context.contentSlot("content", target);
		context.fragment.append(target);
	});
	return { scope, target: roots[0] as HTMLElement };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function throwingParticipant(error: Error): RetainedCommitParticipant {
	return {
		isCurrent: () => true,
		apply: () => {
			throw error;
		},
		rollback: vi.fn(),
		finalize: vi.fn(),
		discard: vi.fn(),
	};
}

describe("RetainedKeyedSlotScope prepared islands", () => {
	it("prepares Markdown off-DOM and commits only through the retained transaction", async () => {
		const ownerDocument = createOwnerDocument();
		const { scope, target } = mountMarkdownScope(ownerDocument);
		const preparation = await scope.prepareMarkdown("markdown", "markdown-v1", async (context) => {
			const strong = context.ownerDocument.createElement("strong");
			strong.textContent = "Prepared";
			context.container.append(strong);
		});

		expect(preparation.status).toBe("prepared");
		if (preparation.status !== "prepared") return;
		expect(target.textContent).toBe("");

		const transaction = new RetainedCommitTransaction(() => true);
		expect(transaction.commit([preparation.toCommitParticipant()])).toEqual({
			status: "committed",
		});
		expect(target.textContent).toBe("Prepared");
	});

	it("uses the keyed scope ownerDocument for prepared content islands", async () => {
		const ownerDocument = createOwnerDocument();
		const { scope, target } = mountContentScope(ownerDocument);
		const preparation = await scope.prepareContent("content", "content-v1", async (context) => {
			expect(context.ownerDocument).toBe(ownerDocument);
			expect(context.container.ownerDocument).toBe(ownerDocument);
			const paragraph = ownerDocument.createElement("p");
			paragraph.textContent = "Content";
			context.container.append(paragraph);
		});

		expect(preparation.status).toBe("prepared");
		if (preparation.status !== "prepared") return;
		expect(new RetainedCommitTransaction(() => true).commit([
			preparation.toCommitParticipant(),
		]).status).toBe("committed");
		expect(target.textContent).toBe("Content");
	});

	it("rolls a prepared island back by exact Node identity when a later participant fails", async () => {
		const ownerDocument = createOwnerDocument();
		const { scope, target } = mountMarkdownScope(ownerDocument);
		const stableCleanup = vi.fn();
		const stable = await scope.prepareMarkdown("markdown", "stable", async (context) => {
			context.resources.register(stableCleanup);
			const node = ownerDocument.createElement("em");
			node.textContent = "Stable";
			context.container.append(node);
		});
		expect(stable.status).toBe("prepared");
		if (stable.status !== "prepared") return;
		new RetainedCommitTransaction(() => true).commit([stable.toCommitParticipant()]);
		const stableNode = target.firstChild;

		const stagedCleanup = vi.fn();
		const next = await scope.prepareMarkdown("markdown", "next", async (context) => {
			context.resources.register(stagedCleanup);
			const node = ownerDocument.createElement("strong");
			node.textContent = "Transient";
			context.container.append(node);
		});
		expect(next.status).toBe("prepared");
		if (next.status !== "prepared") return;

		const failure = new Error("Later participant failed");
		const result = new RetainedCommitTransaction(() => true).commit([
			next.toCommitParticipant(),
			throwingParticipant(failure),
		]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(target.firstChild).toBe(stableNode);
		expect(target.textContent).toBe("Stable");
		expect(stagedCleanup).toHaveBeenCalledTimes(1);
		expect(stableCleanup).not.toHaveBeenCalled();

		scope.dispose();
		expect(stableCleanup).toHaveBeenCalledTimes(1);
	});

	it("returns unchanged for an already committed render key without rerendering", async () => {
		const ownerDocument = createOwnerDocument();
		const { scope, target } = mountMarkdownScope(ownerDocument);
		const renderer = vi.fn(async (context) => {
			const node = ownerDocument.createElement("span");
			node.textContent = "Stable";
			context.container.append(node);
		});
		const first = await scope.prepareMarkdown("markdown", "same-key", renderer);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		new RetainedCommitTransaction(() => true).commit([first.toCommitParticipant()]);
		const stableNode = target.firstChild;

		const second = await scope.prepareMarkdown("markdown", "same-key", renderer);
		expect(second.status).toBe("unchanged");
		expect(renderer).toHaveBeenCalledTimes(1);
		expect(target.firstChild).toBe(stableNode);
	});

	it("shares only the in-flight same-key preparation before either handle is claimed", async () => {
		const ownerDocument = createOwnerDocument();
		const { scope } = mountMarkdownScope(ownerDocument);
		const gate = deferred<void>();
		const renderer = vi.fn(async (context) => {
			await gate.promise;
			const node = ownerDocument.createElement("span");
			node.textContent = "Shared";
			context.container.append(node);
		});

		const firstPromise = scope.prepareMarkdown("markdown", "shared", renderer);
		const secondPromise = scope.prepareMarkdown("markdown", "shared", renderer);
		expect(secondPromise).toBe(firstPromise);
		gate.resolve();
		const [first, second] = await Promise.all([firstPromise, secondPromise]);
		expect(first).toBe(second);
		expect(renderer).toHaveBeenCalledTimes(1);
		if (first.status === "prepared") first.dispose();
	});

	it("invalidates pending prepared work when the keyed slot scope is disposed", async () => {
		const ownerDocument = createOwnerDocument();
		const { scope, target } = mountMarkdownScope(ownerDocument);
		const gate = deferred<void>();
		const preparing = scope.prepareMarkdown("markdown", "late", async (context) => {
			await gate.promise;
			if (!context.isCurrent()) return;
			const node = ownerDocument.createElement("span");
			node.textContent = "Late";
			context.container.append(node);
		});

		await Promise.resolve();
		scope.dispose();
		gate.resolve();
		const result = await preparing;
		expect(result.status).toBe("disposed");
		expect(target.textContent).toBe("");
	});
});
