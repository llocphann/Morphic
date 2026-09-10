import { describe, expect, it } from "vitest";
import type {
	RetainedLeafOwnerRenderCommitResult,
	RetainedLeafOwnerRenderPreparationResult,
} from "../render/retained-leaf-owner-render-host";
import {
	RetainedLeafOwnerLinkHost,
	type RetainedLeafOwnerRenderHostPort,
	type RetainedOwnerLinkBinding,
} from "../render/retained-leaf-owner-link-host";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

type Owner = object;
type Expression = string;
type Port = RetainedLeafOwnerRenderHostPort<Owner, Expression>;

class FakeRenderHost implements Port {
	isDisposed = false;
	readonly releases: Owner[] = [];
	private generation = 0;

	async prepare(...args: Parameters<Port["prepare"]>): Promise<RetainedLeafOwnerRenderPreparationResult> {
		const generation = args[3];
		this.generation = Math.max(this.generation, generation);
		let terminal = false;
		return {
			status: "prepared",
			generation,
			mode: generation === 1 ? "replace" : "patch",
			structureKey: "stable",
			isCurrent: () => !terminal && !this.isDisposed,
			commit: (): RetainedLeafOwnerRenderCommitResult => {
				if (terminal) return { status: "stale" };
				terminal = true;
				return { status: "committed" };
			},
			dispose: () => {
				terminal = true;
			},
		};
	}

	release(owner: Owner): void {
		this.releases.push(owner);
	}

	dispose(): void {
		this.isDisposed = true;
	}
}

class FakeBinding implements RetainedOwnerLinkBinding {
	isDisposed = false;
	disposeCalls = 0;

	constructor(
		readonly root: HTMLElement,
		public currentSourcePath: string,
		private readonly onDispose?: () => void,
	) {}

	updateSourcePath(sourcePath: string): void {
		this.currentSourcePath = sourcePath;
	}

	dispose(): void {
		this.disposeCalls += 1;
		this.isDisposed = true;
		this.onDispose?.();
	}
}

function scope() {
	return {
		isDisposed: false,
		registerDisposer(disposer: () => void) {
			return disposer;
		},
	};
}

function ir(): RetainedTemplateIrLike<Expression> {
	return {
		version: 1,
		sourceHash: "stable",
		nodes: [{ kind: "static-fragment", html: "<article></article>" }],
	};
}

async function prepare(
	host: RetainedLeafOwnerLinkHost<Owner, Expression>,
	owner: Owner,
	root: HTMLElement,
	generation: number,
	sourcePath: string,
) {
	const result = await host.prepare(
		owner,
		root,
		scope(),
		generation,
		sourcePath,
		ir(),
		new Map(),
		new Map(),
	);
	if (result.status !== "prepared") throw new Error(`Expected prepared, received ${result.status}`);
	return result;
}

describe("Bot 5 retained owner link release reentry", () => {
	it("does not leave a reentrant newer binding alive after releasing the same owner", async () => {
		const renderHost = new FakeRenderHost();
		const owner = {};
		const root = document.createElement("div");
		const created: FakeBinding[] = [];
		let newerCommit: (() => RetainedLeafOwnerRenderCommitResult) | undefined;
		const host = new RetainedLeafOwnerLinkHost<Owner, Expression>({
			renderHost,
			createLinkBinding(rootEl, sourcePath) {
				const binding = new FakeBinding(
					rootEl,
					sourcePath,
					created.length === 0 ? () => newerCommit?.() : undefined,
				);
				created.push(binding);
				return binding;
			},
		});

		const first = await prepare(host, owner, root, 1, "Notes/First.md");
		expect(first.commit()).toEqual({ status: "committed" });
		const second = await prepare(host, owner, root, 2, "Notes/Second.md");
		newerCommit = second.commit;

		host.release(owner);

		expect(renderHost.releases).toEqual([owner]);
		expect(created).toHaveLength(2);
		expect(created[0].isDisposed).toBe(true);
		expect(created[1].isDisposed).toBe(true);
		expect(host.bindingFor(owner)).toBeNull();
		expect(host.size).toBe(0);
	});
});
