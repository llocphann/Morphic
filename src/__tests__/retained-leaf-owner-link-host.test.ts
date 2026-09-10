import { describe, expect, it, vi } from "vitest";
import type {
	RetainedLeafOwnerRenderCommitResult,
	RetainedLeafOwnerRenderPreparationResult,
} from "../render/retained-leaf-owner-render-host";
import {
	RetainedLeafOwnerLinkHost,
	RetainedLeafOwnerLinkHostError,
	type RetainedLeafOwnerRenderHostPort,
	type RetainedOwnerLinkBinding,
} from "../render/retained-leaf-owner-link-host";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

type TestExpression = string;
type TestPort = RetainedLeafOwnerRenderHostPort<object, TestExpression>;

interface FakeBehavior {
	result: RetainedLeafOwnerRenderCommitResult;
	mode?: "replace" | "patch" | "handoff";
	current?: boolean;
	onCommit?: () => void;
}

class FakeRenderHost implements TestPort {
	isDisposed = false;
	readonly behaviors = new Map<number, FakeBehavior>();
	readonly releases: object[] = [];
	private readonly disposedGenerations = new Set<number>();

	async prepare(
		...args: Parameters<TestPort["prepare"]>
	): Promise<RetainedLeafOwnerRenderPreparationResult> {
		const generation = args[3];
		const behavior = this.behaviors.get(generation);
		if (!behavior) throw new Error(`Missing fake behavior for generation ${generation}`);
		let terminal = false;
		return {
			status: "prepared",
			generation,
			mode: behavior.mode ?? "patch",
			structureKey: "stable",
			isCurrent: () => !terminal && !this.isDisposed && behavior.current !== false,
			commit: () => {
				if (terminal) return { status: "stale" };
				behavior.onCommit?.();
				terminal = true;
				return behavior.result;
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				this.disposedGenerations.add(generation);
			},
		};
	}

	release(owner: object): void {
		this.releases.push(owner);
	}

	dispose(): void {
		this.isDisposed = true;
	}

	wasPreparedDisposed(generation: number): boolean {
		return this.disposedGenerations.has(generation);
	}
}

class FakeLinkBinding implements RetainedOwnerLinkBinding {
	isDisposed = false;
	readonly updates: string[] = [];
	disposeCalls = 0;
	failNextUpdate = false;

	constructor(readonly root: HTMLElement, public currentSourcePath: string) {}

	updateSourcePath(sourcePath: string): void {
		if (this.failNextUpdate) {
			this.failNextUpdate = false;
			throw new Error("Synthetic source update failure");
		}
		this.currentSourcePath = sourcePath;
		this.updates.push(sourcePath);
	}

	dispose(): void {
		this.disposeCalls += 1;
		this.isDisposed = true;
	}
}

function ownerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function root(doc: Document): HTMLElement {
	const value = doc.createElement("div");
	doc.body.appendChild(value);
	return value;
}

function scope() {
	return {
		isDisposed: false,
		registerDisposer(disposer: () => void) {
			return disposer;
		},
	};
}

function ir(): RetainedTemplateIrLike<TestExpression> {
	return {
		version: 1,
		sourceHash: "stable",
		nodes: [{ kind: "static-fragment", html: "<article></article>" }],
	};
}

async function prepare(
	host: RetainedLeafOwnerLinkHost<object, TestExpression>,
	owner: object,
	rootEl: HTMLElement,
	generation: number,
	sourcePath: string,
) {
	const result = await host.prepare(
		owner,
		rootEl,
		scope(),
		generation,
		sourcePath,
		ir(),
		new Map(),
		new Map(),
	);
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared result, received ${result.status}`);
	}
	return result;
}

function fixture() {
	const renderHost = new FakeRenderHost();
	const created: FakeLinkBinding[] = [];
	const factory = vi.fn((rootEl: HTMLElement, sourcePath: string) => {
		const binding = new FakeLinkBinding(rootEl, sourcePath);
		created.push(binding);
		return binding;
	});
	const host = new RetainedLeafOwnerLinkHost<object, TestExpression>({
		renderHost,
		createLinkBinding: factory,
	});
	return { host, renderHost, factory, created };
}

describe("RetainedLeafOwnerLinkHost", () => {
	it("creates link listeners only after the first successful retained commit", async () => {
		const { host, renderHost, factory, created } = fixture();
		const doc = ownerDocument();
		const owner = {};
		renderHost.behaviors.set(1, { result: { status: "committed" }, mode: "replace" });

		const prepared = await prepare(host, owner, root(doc), 1, "notes/First.md");
		expect(factory).not.toHaveBeenCalled();
		expect(host.bindingFor(owner)).toBeNull();

		expect(prepared.commit()).toEqual({ status: "committed" });
		expect(factory).toHaveBeenCalledTimes(1);
		expect(host.bindingFor(owner)).toBe(created[0]);
		expect(created[0].currentSourcePath).toBe("notes/First.md");
	});

	it("does not create or advance link source context for failed retained commits", async () => {
		const { host, renderHost, factory } = fixture();
		const doc = ownerDocument();
		const owner = {};
		renderHost.behaviors.set(1, { result: { status: "failed", error: new Error("Failed") } });

		const prepared = await prepare(host, owner, root(doc), 1, "notes/Failed.md");
		expect(prepared.commit().status).toBe("failed");
		expect(factory).not.toHaveBeenCalled();
		expect(host.bindingFor(owner)).toBeNull();
	});

	it("retains one binding identity while a successful patch advances source path", async () => {
		const { host, renderHost, factory, created } = fixture();
		const doc = ownerDocument();
		const owner = {};
		const rootEl = root(doc);
		renderHost.behaviors.set(1, { result: { status: "committed" }, mode: "replace" });
		renderHost.behaviors.set(2, { result: { status: "committed" }, mode: "patch" });

		expect((await prepare(host, owner, rootEl, 1, "notes/A.md")).commit().status).toBe("committed");
		const binding = created[0];
		expect((await prepare(host, owner, rootEl, 2, "notes/B.md")).commit().status).toBe("committed");

		expect(factory).toHaveBeenCalledTimes(1);
		expect(host.bindingFor(owner)).toBe(binding);
		expect(binding.currentSourcePath).toBe("notes/B.md");
		expect(binding.updates).toEqual(["notes/B.md"]);
	});

	it("advances source path on an unchanged DOM handoff generation", async () => {
		const { host, renderHost, created } = fixture();
		const doc = ownerDocument();
		const owner = {};
		const rootEl = root(doc);
		renderHost.behaviors.set(1, { result: { status: "committed" }, mode: "replace" });
		renderHost.behaviors.set(2, { result: { status: "unchanged" }, mode: "handoff" });

		expect((await prepare(host, owner, rootEl, 1, "notes/A.md")).commit().status).toBe("committed");
		expect((await prepare(host, owner, rootEl, 2, "notes/B.md")).commit()).toEqual({ status: "unchanged" });
		expect(created[0].currentSourcePath).toBe("notes/B.md");
	});

	it("does not let an older commit tail overwrite a newer reentrant successful source commit", async () => {
		const { host, renderHost, created } = fixture();
		const doc = ownerDocument();
		const owner = {};
		const rootEl = root(doc);
		renderHost.behaviors.set(1, { result: { status: "committed" } });
		renderHost.behaviors.set(2, { result: { status: "committed" } });

		const older = await prepare(host, owner, rootEl, 1, "notes/Older.md");
		const newer = await prepare(host, owner, rootEl, 2, "notes/Newer.md");
		renderHost.behaviors.get(1)!.onCommit = () => {
			expect(newer.commit().status).toBe("committed");
		};

		expect(older.commit().status).toBe("committed");
		expect(created).toHaveLength(1);
		expect(created[0].currentSourcePath).toBe("notes/Newer.md");
	});

	it("keeps the previous root binding when a replacement root commit fails", async () => {
		const { host, renderHost, factory, created } = fixture();
		const doc = ownerDocument();
		const owner = {};
		const firstRoot = root(doc);
		const secondRoot = root(doc);
		renderHost.behaviors.set(1, { result: { status: "committed" }, mode: "replace" });
		renderHost.behaviors.set(2, { result: { status: "failed", error: new Error("Replacement failed") }, mode: "replace" });
		renderHost.behaviors.set(3, { result: { status: "committed" }, mode: "replace" });

		expect((await prepare(host, owner, firstRoot, 1, "notes/A.md")).commit().status).toBe("committed");
		const firstBinding = created[0];
		expect((await prepare(host, owner, secondRoot, 2, "notes/B.md")).commit().status).toBe("failed");
		expect(host.bindingFor(owner)).toBe(firstBinding);
		expect(firstBinding.isDisposed).toBe(false);
		expect(factory).toHaveBeenCalledTimes(1);

		expect((await prepare(host, owner, secondRoot, 3, "notes/C.md")).commit().status).toBe("committed");
		expect(factory).toHaveBeenCalledTimes(2);
		expect(firstBinding.isDisposed).toBe(true);
		expect(host.bindingFor(owner)).toBe(created[1]);
		expect(created[1].currentSourcePath).toBe("notes/C.md");
	});

	it("surfaces a poisoned result if listener creation fails after a live commit", async () => {
		const renderHost = new FakeRenderHost();
		renderHost.behaviors.set(1, { result: { status: "committed" } });
		const host = new RetainedLeafOwnerLinkHost<object, TestExpression>({
			renderHost,
			createLinkBinding: () => {
				throw new Error("Synthetic binding failure");
			},
		});
		const result = (await prepare(host, {}, root(ownerDocument()), 1, "notes/A.md")).commit();

		expect(result.status).toBe("poisoned");
		if (!("error" in result)) throw new Error("Expected poisoned result error");
		expect(result.error).toBeInstanceOf(RetainedLeafOwnerLinkHostError);
		expect((result.error as RetainedLeafOwnerLinkHostError).code).toBe("binding-create-failed");
	});

	it("owns binding teardown per retained owner and keeps cleanup reporting non-fatal", async () => {
		const renderHost = new FakeRenderHost();
		const reported: unknown[] = [];
		const owner = {};
		const binding = new FakeLinkBinding(root(ownerDocument()), "notes/A.md");
		binding.dispose = () => {
			binding.disposeCalls += 1;
			binding.isDisposed = true;
			throw new Error("Synthetic dispose failure");
		};
		const host = new RetainedLeafOwnerLinkHost<object, TestExpression>({
			renderHost,
			createLinkBinding: () => binding,
			onCleanupError(error) {
				reported.push(error);
				throw new Error("Reporter failed");
			},
		});
		renderHost.behaviors.set(1, { result: { status: "committed" } });

		expect((await prepare(host, owner, binding.root, 1, "notes/A.md")).commit().status).toBe("committed");
		expect(() => host.release(owner)).not.toThrow();
		expect(binding.disposeCalls).toBe(1);
		expect(renderHost.releases).toEqual([owner]);
		expect(reported).toHaveLength(1);
	});
});
