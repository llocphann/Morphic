import { describe, expect, it, vi } from "vitest";
import { RetainedCommitTransaction, type RetainedCommitParticipant } from "../render/retained-commit-transaction";
import {
	RetainedDetachedGenerationHost,
	type RetainedPreparedGeneration,
} from "../render/retained-detached-generation-host";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function requirePrepared(
	result: ReturnType<RetainedDetachedGenerationHost["prepareStructure"]>,
): RetainedPreparedGeneration {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared generation, received ${result.status}`);
	}
	return result;
}

function textBuilder(id: string, value: string) {
	return (context: Parameters<RetainedDetachedGenerationHost["prepareStructure"]>[1] extends (
		context: infer C,
	) => void ? C : never) => {
		context.fragment.append(context.textSlot(id, value));
	};
}

describe("RetainedDetachedGenerationHost", () => {
	it("builds a new structure fully detached until the final synchronous commit", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const stable = ownerDocument.createElement("span");
		stable.textContent = "Stable";
		root.appendChild(stable);
		const host = new RetainedDetachedGenerationHost(root);

		const prepared = requirePrepared(host.prepareStructure(
			"structure-a",
			textBuilder("title", "Staged"),
		));

		expect(root.firstChild).toBe(stable);
		expect(root.textContent).toBe("Stable");
		expect(host.currentStructureKey).toBeNull();
		expect(prepared.runtime.currentStructureKey).toBe("structure-a");

		expect(prepared.commit()).toEqual({ status: "committed" });
		expect(root.textContent).toBe("Staged");
		expect(host.currentStructureKey).toBe("structure-a");
		expect(host.activeRuntime).toBe(prepared.runtime);
	});

	it("keeps retained bindings patchable after their exact Nodes move into the live root", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const host = new RetainedDetachedGenerationHost(root);
		const prepared = requirePrepared(host.prepareStructure(
			"structure-a",
			textBuilder("title", "Before"),
		));

		expect(prepared.commit().status).toBe("committed");
		expect(root.textContent).toBe("Before");
		expect(prepared.runtime.patchText("title", "After")).toBe("patched");
		expect(root.textContent).toBe("After");
	});

	it("renders Markdown and content islands off-DOM before exposing the complete generation", async () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		root.textContent = "Last good";
		const host = new RetainedDetachedGenerationHost(root);
		const prepared = requirePrepared(host.prepareStructure("mixed", (context) => {
			const shell = context.ownerDocument.createElement("section");
			const markdown = context.ownerDocument.createElement("span");
			const content = context.ownerDocument.createElement("div");
			context.markdownSlot("markdown", markdown);
			context.contentSlot("content", content);
			shell.append(markdown, content);
			context.fragment.append(shell);
		}));

		await expect(prepared.runtime.patchMarkdown("markdown", "md:1", ({ container }) => {
			container.textContent = "Rendered Markdown";
		})).resolves.toEqual({ status: "patched" });
		await expect(prepared.runtime.patchContent("content", "content:1", ({ container }) => {
			container.textContent = "Rendered content";
		})).resolves.toEqual({ status: "patched" });

		expect(root.textContent).toBe("Last good");
		expect(prepared.commit().status).toBe("committed");
		expect(root.textContent).toBe("Rendered MarkdownRendered content");
	});

	it("rolls a live root replacement back by exact Node identity when a later participant fails", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const stable = ownerDocument.createElement("button");
		stable.textContent = "Stable";
		root.appendChild(stable);
		const host = new RetainedDetachedGenerationHost(root);
		const prepared = requirePrepared(host.prepareStructure(
			"next",
			textBuilder("title", "Next"),
		));
		const failure = new Error("Later participant failed");
		const later: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply() {
				throw failure;
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		const transaction = new RetainedCommitTransaction(() => true);

		const result = transaction.commit([prepared.toCommitParticipant(), later]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(root.firstChild).toBe(stable);
		expect(host.currentStructureKey).toBeNull();
		expect(prepared.runtime.patchText("title", "Disposed")).toBe("disposed");
	});

	it("keeps the previous active runtime authoritative when a newer generation rolls back", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const host = new RetainedDetachedGenerationHost(root);
		const first = requirePrepared(host.prepareStructure(
			"first",
			textBuilder("title", "First"),
		));
		expect(first.commit().status).toBe("committed");
		const firstNode = root.firstChild;

		const second = requirePrepared(host.prepareStructure(
			"second",
			textBuilder("title", "Second"),
		));
		const later: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply() {
				throw new Error("Abort second generation");
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		const transaction = new RetainedCommitTransaction(() => true);

		expect(transaction.commit([second.toCommitParticipant(), later]).status).toBe("failed");
		expect(root.firstChild).toBe(firstNode);
		expect(host.currentStructureKey).toBe("first");
		expect(host.activeRuntime).toBe(first.runtime);
		expect(first.runtime.patchText("title", "Still active")).toBe("patched");
		expect(root.textContent).toBe("Still active");
	});

	it("disposes the previous active runtime only after the replacement is adopted", async () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const cleanup = vi.fn();
		const host = new RetainedDetachedGenerationHost(root);
		const first = requirePrepared(host.prepareStructure("first", (context) => {
			const markdown = context.ownerDocument.createElement("span");
			context.markdownSlot("markdown", markdown);
			context.fragment.append(markdown);
		}));
		await first.runtime.patchMarkdown("markdown", "md:1", ({ container, resources }) => {
			resources.register(cleanup);
			container.textContent = "First";
		});
		expect(first.commit().status).toBe("committed");
		expect(cleanup).not.toHaveBeenCalled();

		const second = requirePrepared(host.prepareStructure(
			"second",
			textBuilder("title", "Second"),
		));
		expect(second.commit().status).toBe("committed");
		expect(root.textContent).toBe("Second");
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(first.runtime.patchText("missing", "Ignored")).toBe("disposed");
	});

	it("supersedes repeated pending structure keys instead of reusing stale initial values", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const host = new RetainedDetachedGenerationHost(root);
		const first = requirePrepared(host.prepareStructure(
			"same-key",
			textBuilder("title", "Old generation"),
		));
		const second = requirePrepared(host.prepareStructure(
			"same-key",
			textBuilder("title", "New generation"),
		));

		expect(first.isCurrent()).toBe(false);
		expect(first.runtime.patchText("title", "Ignored")).toBe("disposed");
		expect(second.isCurrent()).toBe(true);
		expect(second.commit().status).toBe("committed");
		expect(root.textContent).toBe("New generation");
	});

	it("reuses the active runtime for the same committed structure without rebuilding DOM", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const host = new RetainedDetachedGenerationHost(root);
		const first = requirePrepared(host.prepareStructure(
			"same-key",
			textBuilder("title", "First"),
		));
		expect(first.commit().status).toBe("committed");
		const node = root.firstChild;
		const builder = vi.fn(textBuilder("unused", "Unused"));

		const reused = host.prepareStructure("same-key", builder);
		expect(reused.status).toBe("reused");
		if (reused.status !== "reused") throw new Error("Expected reuse");
		expect(reused.runtime).toBe(first.runtime);
		expect(builder).not.toHaveBeenCalled();
		expect(root.firstChild).toBe(node);
	});

	it("preserves the live surface when detached structure building throws", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const stable = ownerDocument.createElement("span");
		stable.textContent = "Stable";
		root.appendChild(stable);
		const host = new RetainedDetachedGenerationHost(root);
		const failure = new Error("Builder failed");

		const result = host.prepareStructure("broken", () => {
			throw failure;
		});

		expect(result).toEqual({ status: "failed", error: failure });
		expect(root.firstChild).toBe(stable);
		expect(host.currentStructureKey).toBeNull();
	});

	it("rolls back a generation made stale reentrantly by newer preparation during apply", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const stable = ownerDocument.createElement("span");
		stable.textContent = "Stable";
		root.appendChild(stable);
		const host = new RetainedDetachedGenerationHost(root);
		const prepared = requirePrepared(host.prepareStructure(
			"first",
			textBuilder("title", "First"),
		));
		const originalReplace = host.replaceLiveChildren.bind(host);
		let trigger = true;
		vi.spyOn(host, "replaceLiveChildren").mockImplementation((nodes) => {
			originalReplace(nodes);
			if (!trigger) return;
			trigger = false;
			host.prepareStructure("newer", textBuilder("title", "Newer"));
		});
		const transaction = new RetainedCommitTransaction(() => true);

		expect(transaction.commit([prepared.toCommitParticipant()])).toEqual({ status: "stale" });
		expect(root.firstChild).toBe(stable);
		expect(host.currentStructureKey).toBeNull();
	});

	it("uses the live root ownerDocument for all detached generation DOM", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const host = new RetainedDetachedGenerationHost(root);
		let seenDocument: Document | null = null;
		const prepared = requirePrepared(host.prepareStructure("popout-like", (context) => {
			seenDocument = context.ownerDocument;
			const element = context.ownerDocument.createElement("article");
			element.append(context.textSlot("title", "Owned"));
			context.fragment.append(element);
		}));

		expect(seenDocument).toBe(ownerDocument);
		expect(prepared.commit().status).toBe("committed");
		expect(root.firstElementChild?.ownerDocument).toBe(ownerDocument);
	});

	it("disposes pending and active retained resources without removing owner DOM", async () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const cleanup = vi.fn();
		const host = new RetainedDetachedGenerationHost(root);
		const prepared = requirePrepared(host.prepareStructure("active", (context) => {
			const markdown = context.ownerDocument.createElement("span");
			context.markdownSlot("markdown", markdown);
			context.fragment.append(markdown);
		}));
		await prepared.runtime.patchMarkdown("markdown", "md:1", ({ container, resources }) => {
			resources.register(cleanup);
			container.textContent = "Committed";
		});
		expect(prepared.commit().status).toBe("committed");
		const liveNode = root.firstChild;

		host.dispose();
		host.dispose();

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(root.firstChild).toBe(liveNode);
		expect(host.activeRuntime).toBeNull();
		expect(host.prepareStructure("later", textBuilder("title", "Later"))).toEqual({
			status: "disposed",
		});
	});
});
