import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedKeyedPreparedIslandBatch,
	type RetainedKeyedPreparedIslandRequest,
} from "../render/retained-keyed-prepared-island-batch";
import { RetainedKeyedSlotScope } from "../render/scoped-keyed-slot-runtime";
import type { RetainedIslandRenderer } from "../render/retained-slot-runtime";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function mountScope(
	ownerDocument: Document,
	kind: "markdown" | "content",
	slotId: string,
) {
	const scope = new RetainedKeyedSlotScope(ownerDocument);
	const roots = scope.mount((context) => {
		const target = ownerDocument.createElement(kind === "markdown" ? "span" : "div");
		if (kind === "markdown") context.markdownSlot(slotId, target);
		else context.contentSlot(slotId, target);
		context.fragment.append(target);
	});
	ownerDocument.body.append(...roots);
	return { scope, target: roots[0] as HTMLElement };
}

function request(
	key: string | number,
	slots: RetainedKeyedSlotScope,
	kind: "markdown" | "content",
	slotId: string,
	renderKey: string,
	renderer: RetainedIslandRenderer,
): RetainedKeyedPreparedIslandRequest {
	return { key, slots, kind, slotId, renderKey, renderer };
}

function textRenderer(
	ownerDocument: Document,
	text: string,
	cleanup?: () => void,
): RetainedIslandRenderer {
	return async (context) => {
		if (cleanup) context.resources.register(cleanup);
		const node = ownerDocument.createElement("strong");
		node.textContent = text;
		context.container.append(node);
	};
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("RetainedKeyedPreparedIslandBatch", () => {
	it("prepares Markdown and content off-DOM and commits them in one transaction", async () => {
		const ownerDocument = createOwnerDocument();
		const markdown = mountScope(ownerDocument, "markdown", "markdown");
		const content = mountScope(ownerDocument, "content", "content");
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);

		const prepared = await batch.prepare([
			request(0, markdown.scope, "markdown", "markdown", "md-v1", textRenderer(ownerDocument, "Markdown")),
			request(1, content.scope, "content", "content", "content-v1", textRenderer(ownerDocument, "Content")),
		]);

		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(prepared.requestCount).toBe(2);
		expect(prepared.participantCount).toBe(2);
		expect(markdown.target.textContent).toBe("");
		expect(content.target.textContent).toBe("");

		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "committed",
		});
		expect(markdown.target.textContent).toBe("Markdown");
		expect(content.target.textContent).toBe("Content");
	});

	it("rolls every island back by exact Node identity when a later owner participant fails", async () => {
		const ownerDocument = createOwnerDocument();
		const first = mountScope(ownerDocument, "markdown", "markdown");
		const second = mountScope(ownerDocument, "content", "content");
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);
		const firstStableCleanup = vi.fn();
		const secondStableCleanup = vi.fn();

		const stable = await batch.prepare([
			request(0, first.scope, "markdown", "markdown", "stable-md", textRenderer(ownerDocument, "Stable markdown", firstStableCleanup)),
			request(1, second.scope, "content", "content", "stable-content", textRenderer(ownerDocument, "Stable content", secondStableCleanup)),
		]);
		expect(stable.status).toBe("prepared");
		if (stable.status !== "prepared") return;
		expect(stable.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		const firstStableNode = first.target.firstChild;
		const secondStableNode = second.target.firstChild;

		const firstStagedCleanup = vi.fn();
		const secondStagedCleanup = vi.fn();
		const next = await batch.prepare([
			request(0, first.scope, "markdown", "markdown", "next-md", textRenderer(ownerDocument, "Next markdown", firstStagedCleanup)),
			request(1, second.scope, "content", "content", "next-content", textRenderer(ownerDocument, "Next content", secondStagedCleanup)),
		]);
		expect(next.status).toBe("prepared");
		if (next.status !== "prepared") return;
		const claimed = next.claimParticipants();
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") return;

		const failure = new Error("Owner participant failed");
		const result = new RetainedCommitTransaction(() => true).commit([
			...claimed.claim.toCommitParticipants(),
			throwingParticipant(failure),
		]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(first.target.firstChild).toBe(firstStableNode);
		expect(second.target.firstChild).toBe(secondStableNode);
		expect(firstStableCleanup).not.toHaveBeenCalled();
		expect(secondStableCleanup).not.toHaveBeenCalled();
		expect(firstStagedCleanup).toHaveBeenCalledTimes(1);
		expect(secondStagedCleanup).toHaveBeenCalledTimes(1);
	});

	it("returns unchanged when every render key is already committed", async () => {
		const ownerDocument = createOwnerDocument();
		const mounted = mountScope(ownerDocument, "markdown", "markdown");
		const renderer = vi.fn(textRenderer(ownerDocument, "Stable"));
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);
		const first = await batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "same", renderer),
		]);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		expect(first.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		const stableNode = mounted.target.firstChild;

		const second = await batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "same", renderer),
		]);
		expect(second.status).toBe("unchanged");
		expect(renderer).toHaveBeenCalledTimes(1);
		expect(mounted.target.firstChild).toBe(stableNode);
	});

	it("rejects duplicate requests for one scoped slot before rendering", async () => {
		const ownerDocument = createOwnerDocument();
		const mounted = mountScope(ownerDocument, "markdown", "markdown");
		const firstRenderer = vi.fn(textRenderer(ownerDocument, "First"));
		const secondRenderer = vi.fn(textRenderer(ownerDocument, "Second"));
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);

		const result = await batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "first", firstRenderer),
			request(0, mounted.scope, "markdown", "markdown", "second", secondRenderer),
		]);

		expect(result.status).toBe("failed");
		expect(firstRenderer).not.toHaveBeenCalled();
		expect(secondRenderer).not.toHaveBeenCalled();
		expect(mounted.target.textContent).toBe("");
	});

	it("rejects foreign ownerDocument scopes before rendering", async () => {
		const ownerDocument = createOwnerDocument();
		const foreignDocument = createOwnerDocument();
		const mounted = mountScope(foreignDocument, "markdown", "markdown");
		const renderer = vi.fn(textRenderer(foreignDocument, "Foreign"));
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);

		const result = await batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "foreign", renderer),
		]);

		expect(result.status).toBe("failed");
		expect(renderer).not.toHaveBeenCalled();
		expect(mounted.target.textContent).toBe("");
	});

	it("discards prepared siblings when one renderer fails", async () => {
		const ownerDocument = createOwnerDocument();
		const first = mountScope(ownerDocument, "markdown", "markdown");
		const second = mountScope(ownerDocument, "content", "content");
		const firstCleanup = vi.fn();
		const failure = new Error("Content render failed");
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);

		const result = await batch.prepare([
			request(0, first.scope, "markdown", "markdown", "first", textRenderer(ownerDocument, "Prepared", firstCleanup)),
			request(1, second.scope, "content", "content", "second", async () => {
				throw failure;
			}),
		]);

		expect(result.status).toBe("failed");
		if (result.status === "failed") expect(result.error).toBe(failure);
		expect(firstCleanup).toHaveBeenCalledTimes(1);
		expect(first.target.textContent).toBe("");
		expect(second.target.textContent).toBe("");
	});

	it("supersedes and disposes older unclaimed prepared batches", async () => {
		const ownerDocument = createOwnerDocument();
		const mounted = mountScope(ownerDocument, "markdown", "markdown");
		const olderCleanup = vi.fn();
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);
		const older = await batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "older", textRenderer(ownerDocument, "Older", olderCleanup)),
		]);
		expect(older.status).toBe("prepared");
		if (older.status !== "prepared") return;

		const newer = await batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "newer", textRenderer(ownerDocument, "Newer")),
		]);
		expect(older.isCurrent()).toBe(false);
		expect(olderCleanup).toHaveBeenCalledTimes(1);
		expect(newer.status).toBe("prepared");
		if (newer.status !== "prepared") return;
		expect(newer.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(mounted.target.textContent).toBe("Newer");
	});

	it("makes claimed work stale when a newer batch generation starts", async () => {
		const ownerDocument = createOwnerDocument();
		const mounted = mountScope(ownerDocument, "markdown", "markdown");
		const olderCleanup = vi.fn();
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);
		const older = await batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "older", textRenderer(ownerDocument, "Older", olderCleanup)),
		]);
		expect(older.status).toBe("prepared");
		if (older.status !== "prepared") return;
		const claimed = older.claimParticipants();
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") return;

		const newer = await batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "newer", textRenderer(ownerDocument, "Newer")),
		]);
		expect(claimed.claim.isCurrent()).toBe(false);
		expect(new RetainedCommitTransaction(() => claimed.claim.isCurrent()).commit(
			claimed.claim.toCommitParticipants(),
		).status).toBe("stale");
		expect(olderCleanup).toHaveBeenCalledTimes(1);
		expect(mounted.target.textContent).toBe("");

		expect(newer.status).toBe("prepared");
		if (newer.status !== "prepared") return;
		expect(newer.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(mounted.target.textContent).toBe("Newer");
	});

	it("invalidates in-flight rendering on batch disposal without touching live DOM", async () => {
		const ownerDocument = createOwnerDocument();
		const mounted = mountScope(ownerDocument, "markdown", "markdown");
		const gate = deferred<void>();
		const cleanup = vi.fn();
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);
		const preparing = batch.prepare([
			request(0, mounted.scope, "markdown", "markdown", "late", async (context) => {
				context.resources.register(cleanup);
				await gate.promise;
				if (!context.isCurrent()) return;
				const node = ownerDocument.createElement("strong");
				node.textContent = "Late";
				context.container.append(node);
			}),
		]);

		await Promise.resolve();
		batch.dispose();
		gate.resolve();
		const result = await preparing;
		expect(result.status).toBe("disposed");
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(mounted.target.textContent).toBe("");
	});

	it("transfers participant ownership only once", async () => {
		const ownerDocument = createOwnerDocument();
		const mounted = mountScope(ownerDocument, "content", "content");
		const cleanup = vi.fn();
		const batch = new RetainedKeyedPreparedIslandBatch(ownerDocument);
		const prepared = await batch.prepare([
			request(0, mounted.scope, "content", "content", "claim", textRenderer(ownerDocument, "Claimed", cleanup)),
		]);
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;

		const first = prepared.claimParticipants();
		expect(first.status).toBe("claimed");
		expect(prepared.claimParticipants().status).toBe("stale");
		if (first.status !== "claimed") return;
		expect(first.claim.participantCount).toBe(1);
		first.claim.dispose();
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(mounted.target.textContent).toBe("");
	});
});
