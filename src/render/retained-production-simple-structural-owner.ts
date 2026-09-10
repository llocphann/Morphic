import type { App } from "obsidian";
import type { ViewConfig } from "../types";
import { templateReferencesBases } from "../bases/code-blocks";
import { compileTemplateCompat } from "../compiler/template-compat";
import type { IfNode, ForNode, TemplateIR } from "../compiler/template-ir";
import type { ExprContext } from "../expression";
import { createObsidianContentIslandPatch } from "./obsidian-content-island";
import { createObsidianMarkdownIslandPatch } from "./obsidian-markdown-island";
import { createObsidianOverlayLinkBinding } from "./obsidian-overlay-link-binding";
import type { OverlayLinkBinding } from "./overlay-link-binding";
import { RetainedCommitTransaction, type RetainedCommitTransactionResult } from "./retained-commit-transaction";
import {
	RetainedProductionConditionalMixedChildren,
	type RetainedProductionConditionalMixedChildrenPreparationResult,
} from "./retained-production-conditional-mixed-children";
import {
	inspectRetainedProductionConditionalMixedBranchSupport,
	type RetainedConditionalMixedBranchUnsupportedCode,
} from "./retained-production-conditional-mixed-branch-plan";
import {
	RetainedProductionConditionalSyncChildren,
	inspectRetainedProductionConditionalSyncSupport,
	type RetainedProductionConditionalSyncFallbackCode,
	type RetainedProductionConditionalSyncPreparationResult,
} from "./retained-production-conditional-sync-children";
import {
	RetainedProductionForSyncChildren,
	inspectRetainedProductionForSyncSupport,
	type RetainedProductionForSyncFallbackCode,
	type RetainedProductionForSyncPreparationResult,
} from "./retained-production-for-sync-children";

export type RetainedSimpleStructuralOwnerFallbackCode =
	| "top-level-shape"
	| "source-changed"
	| `if:${RetainedProductionConditionalSyncFallbackCode | RetainedConditionalMixedBranchUnsupportedCode}`
	| `for:${RetainedProductionForSyncFallbackCode}`;

export interface RetainedSimpleStructuralOwnerFallback {
	readonly status: "fallback";
	readonly code: RetainedSimpleStructuralOwnerFallbackCode;
	readonly path: string;
	readonly message: string;
}

export type RetainedSimpleStructuralOwnerTerminalStatus =
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedSimpleStructuralOwnerTerminalResult {
	readonly status: RetainedSimpleStructuralOwnerTerminalStatus;
	readonly error?: unknown;
}

export interface RetainedPreparedSimpleStructuralOwner {
	readonly status: "prepared";
	isCurrent(): boolean;
	commit(isOwnerCurrent: () => boolean): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedSimpleStructuralOwnerPreparationResult =
	| RetainedPreparedSimpleStructuralOwner
	| RetainedSimpleStructuralOwnerTerminalResult
	| RetainedSimpleStructuralOwnerFallback;

export interface RetainedSimpleStructuralOwnerRequest {
	readonly ir: TemplateIR;
	readonly expressionContext: ExprContext;
	/** Mixed-island owner context. Sync-only callers may omit these compatibility fields. */
	readonly app?: App;
	readonly sourcePath?: string;
	/** Owner/read-set generation identity; mixed islands never invent this value. */
	readonly revisionKey?: string;
}

type StructuralSupport =
	| {
		readonly node: IfNode;
		readonly nodeIndex: number;
		readonly mode: "if-sync";
	}
	| {
		readonly node: IfNode;
		readonly nodeIndex: number;
		readonly mode: "if-mixed";
	}
	| {
		readonly node: ForNode;
		readonly nodeIndex: number;
		readonly mode: "for-sync";
	};

/**
 * Narrow production owner adapter for exactly one top-level structural node.
 *
 * Synchronous `{% if %}` and `{% for %}` keep their historical composers.
 * Capability-supported `{% if %}` branches that contain Markdown/content leaves
 * use the independently accepted mixed-child transaction from #828. Mixed loops,
 * raw HTML, nested structural flow and incomplete/non-text children remain
 * fail-closed before expression evaluation.
 */
export class RetainedProductionSimpleStructuralOwnerRenderer {
	private sourceHash: string | null = null;
	private structuralKind: StructuralSupport["mode"] | null = null;
	private conditionalSync: RetainedProductionConditionalSyncChildren | null = null;
	private conditionalMixed: RetainedProductionConditionalMixedChildren | null = null;
	private loop: RetainedProductionForSyncChildren | null = null;
	private preparationGeneration = 0;
	private latestOwnerGeneration = -1;
	private disposed = false;

	constructor(private readonly root: HTMLElement) {}

	async prepare(
		request: RetainedSimpleStructuralOwnerRequest,
	): Promise<RetainedSimpleStructuralOwnerPreparationResult> {
		if (this.disposed) return { status: "disposed" };

		// Production revision keys end in the RenderController generation. An older
		// preparation may have spent time awaiting a tracked body read before it
		// reaches this renderer; reject that late arrival before it can supersede a
		// newer retained generation. Opaque/non-production keys keep compatibility.
		const ownerGeneration = parseOwnerGeneration(request.revisionKey);
		if (ownerGeneration !== null) {
			if (ownerGeneration < this.latestOwnerGeneration) return { status: "stale" };
			if (ownerGeneration > this.latestOwnerGeneration) this.latestOwnerGeneration = ownerGeneration;
		}

		const generation = ++this.preparationGeneration;
		const support = inspectSimpleStructuralOwnerSupport(request.ir);
		if (support.status === "fallback") return support;

		if (this.sourceHash !== null && this.sourceHash !== request.ir.sourceHash) {
			return {
				status: "fallback",
				code: "source-changed",
				path: "sourceHash",
				message: "Committed structural shell source changed; use transactional legacy fallback for this generation",
			};
		}

		if (this.sourceHash === null) {
			try {
				this.initializeShell(request.ir, support);
			} catch (error) {
				return { status: "failed", error };
			}
		}

		if (!this.isPreparationCurrent(generation)) {
			return { status: this.disposed ? "disposed" : "stale" };
		}

		if (support.mode === "if-sync") {
			if (this.structuralKind !== "if-sync" || !this.conditionalSync) {
				return { status: "failed", error: new Error("Retained structural owner sync conditional state mismatch") };
			}
			const result = await this.conditionalSync.prepare({
				node: support.node,
				sourceHash: request.ir.sourceHash,
				expressionContext: request.expressionContext,
			});
			return this.bindConditionalSyncResult(generation, result);
		}

		if (support.mode === "if-mixed") {
			if (this.structuralKind !== "if-mixed" || !this.conditionalMixed) {
				return { status: "failed", error: new Error("Retained structural owner mixed conditional state mismatch") };
			}
			const app = request.app;
			const sourcePath = request.sourcePath;
			const revisionKey = request.revisionKey;
			if (!app || sourcePath === undefined || revisionKey === undefined) {
				return {
					status: "failed",
					error: new Error("Retained mixed conditional owner requires app, sourcePath, and revisionKey authority"),
				};
			}
			const result = await this.conditionalMixed.prepare({
				node: support.node,
				sourceHash: request.ir.sourceHash,
				expressionContext: request.expressionContext,
				createIsland: ({ slot, value }) => slot.kind === "markdown"
					? createObsidianMarkdownIslandPatch({
						app,
						markdown: value,
						sourcePath,
						revisionKey,
						mode: "inline",
					})
					: createObsidianContentIslandPatch({
						app,
						markdown: request.expressionContext.bodyContent,
						sourcePath,
						revisionKey,
					}),
			});
			return this.bindConditionalMixedResult(generation, result);
		}

		if (support.mode !== "for-sync") {
			return { status: "failed", error: new Error("Retained structural owner support topology mismatch") };
		}
		if (this.structuralKind !== "for-sync" || !this.loop) {
			return { status: "failed", error: new Error("Retained structural owner loop state mismatch") };
		}
		const result = await this.loop.prepare({
			node: support.node,
			sourceHash: request.ir.sourceHash,
			expressionContext: request.expressionContext,
		});
		return this.bindForResult(generation, result);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		this.conditionalSync?.dispose();
		this.conditionalMixed?.dispose();
		this.loop?.dispose();
		this.conditionalSync = null;
		this.conditionalMixed = null;
		this.loop = null;
		this.sourceHash = null;
		this.structuralKind = null;
	}

	private initializeShell(ir: TemplateIR, support: StructuralSupport): void {
		if (this.root.childNodes.length > 0) {
			throw new Error("Fresh retained structural owner surface is not empty");
		}

		const markerToken = createMarkerToken(ir);
		const html = ir.nodes.map((candidate, index) => {
			if (index === support.nodeIndex) return `<!--${markerToken}-->`;
			if (candidate.kind === "static-fragment") return candidate.html;
			return "";
		}).join("");
		this.root.replaceChildren(parseStructuralHtmlBodyFragment(this.root.ownerDocument, html));

		const marker = findComment(this.root, markerToken);
		if (!marker || !marker.parentElement) {
			this.root.replaceChildren();
			throw new Error("Retained structural owner marker was not preserved by HTML parsing");
		}
		const parent = marker.parentElement;
		if (parent.namespaceURI !== "http://www.w3.org/1999/xhtml") {
			this.root.replaceChildren();
			throw new Error("Retained structural owner marker is outside the HTML namespace");
		}

		try {
			switch (support.mode) {
				case "if-sync":
					this.conditionalSync = new RetainedProductionConditionalSyncChildren(parent, { before: marker });
					this.structuralKind = "if-sync";
					marker.remove();
					break;
				case "if-mixed": {
					// The mixed selector owns an append-only anchor range. Temporarily detach
					// the static tail so its anchors are created exactly at the compiler marker,
					// then restore that tail after the range without changing Node identity.
					const trailing = detachTrailingSiblings(marker);
					this.conditionalMixed = new RetainedProductionConditionalMixedChildren(parent);
					this.structuralKind = "if-mixed";
					marker.remove();
					parent.append(...trailing);
					break;
				}
				case "for-sync":
					this.loop = new RetainedProductionForSyncChildren(parent, { before: marker });
					this.structuralKind = "for-sync";
					marker.remove();
					break;
			}
			this.sourceHash = ir.sourceHash;
		} catch (error) {
			this.conditionalSync?.dispose();
			this.conditionalMixed?.dispose();
			this.loop?.dispose();
			this.conditionalSync = null;
			this.conditionalMixed = null;
			this.loop = null;
			this.structuralKind = null;
			this.root.replaceChildren();
			throw error;
		}
	}

	private bindConditionalSyncResult(
		generation: number,
		result: RetainedProductionConditionalSyncPreparationResult,
	): RetainedSimpleStructuralOwnerPreparationResult {
		if (result.status === "fallback") {
			return {
				status: "fallback",
				code: `if:${result.code}`,
				path: result.path,
				message: result.message,
			};
		}
		if (result.status !== "prepared") {
			return result.status === "failed"
				? { status: "failed", error: result.error }
				: { status: result.status };
		}
		return this.bindPrepared(generation, result);
	}

	private bindConditionalMixedResult(
		generation: number,
		result: RetainedProductionConditionalMixedChildrenPreparationResult,
	): RetainedSimpleStructuralOwnerPreparationResult {
		if (result.status === "fallback") {
			return {
				status: "fallback",
				code: `if:${result.code}`,
				path: result.path,
				message: result.message,
			};
		}
		if (result.status !== "prepared") {
			return result.status === "failed"
				? { status: "failed", error: result.error }
				: { status: result.status };
		}
		return this.bindPrepared(generation, result);
	}

	private bindForResult(
		generation: number,
		result: RetainedProductionForSyncPreparationResult,
	): RetainedSimpleStructuralOwnerPreparationResult {
		if (result.status === "fallback") {
			return {
				status: "fallback",
				code: `for:${result.code}`,
				path: result.path,
				message: result.message,
			};
		}
		if (result.status !== "prepared") {
			return result.status === "failed"
				? { status: "failed", error: result.error }
				: { status: result.status };
		}
		return this.bindPrepared(generation, result);
	}

	private bindPrepared(
		generation: number,
		prepared: {
			isCurrent(): boolean;
			commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
			dispose(): void;
		},
	): RetainedPreparedSimpleStructuralOwner {
		return {
			status: "prepared",
			isCurrent: () => this.isPreparationCurrent(generation) && prepared.isCurrent(),
			commit: (isOwnerCurrent) => {
				if (!this.isPreparationCurrent(generation)) {
					prepared.dispose();
					return { status: this.disposed ? "disposed" : "stale" };
				}
				const transaction = new RetainedCommitTransaction(
					() => this.isPreparationCurrent(generation) && isOwnerCurrent(),
				);
				return prepared.commit(transaction);
			},
			dispose: () => prepared.dispose(),
		};
	}

	private isPreparationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.preparationGeneration;
	}
}

export interface RetainedSimpleStructuralOwnerSurface {
	readonly root: HTMLElement;
	readonly renderer: RetainedProductionSimpleStructuralOwnerRenderer;
	bindOwnerLinks(app: App, sourcePath: string): void;
	disposeOwnerResources(): void;
}

export interface RetainedSimpleStructuralOwnerSurfacePreparation {
	readonly surface: RetainedSimpleStructuralOwnerSurface;
	isCurrent(): boolean;
	commit(app?: App, sourcePath?: string): boolean;
	dispose(): void;
}

/** Transactional owner-lifetime registry isolated from the flat retained surface. */
export class RetainedSimpleStructuralOwnerSurfaceRegistry<Owner extends object> {
	private readonly entries = new Map<Owner, RetainedSimpleStructuralOwnerSurface>();

	constructor(private readonly rootClassName: string) {}

	prepare(owner: Owner, container: HTMLElement): RetainedSimpleStructuralOwnerSurfacePreparation {
		const existing = this.entries.get(owner);
		if (existing && existing.root.ownerDocument === container.ownerDocument) {
			return {
				surface: existing,
				isCurrent: () => this.entries.get(owner) === existing,
				commit: (app, sourcePath) => {
					if (this.entries.get(owner) !== existing) return false;
					if (app && sourcePath !== undefined) existing.bindOwnerLinks(app, sourcePath);
					return true;
				},
				dispose: () => undefined,
			};
		}

		const surface = this.createSurface(container.ownerDocument);
		const expected = existing;
		let settled = false;
		return {
			surface,
			isCurrent: () => settled
				? this.entries.get(owner) === surface
				: this.entries.get(owner) === expected,
			commit: (app, sourcePath) => {
				if (settled) return this.entries.get(owner) === surface;
				if (this.entries.get(owner) !== expected) {
					settled = true;
					this.destroySurface(surface);
					return false;
				}
				try {
					if (app && sourcePath !== undefined) surface.bindOwnerLinks(app, sourcePath);
				} catch {
					settled = true;
					this.destroySurface(surface);
					return false;
				}
				settled = true;
				this.entries.set(owner, surface);
				if (expected) this.destroySurface(expected);
				return true;
			},
			dispose: () => {
				if (settled) return;
				settled = true;
				this.destroySurface(surface);
			},
		};
	}

	release(owner: Owner): void {
		const surface = this.entries.get(owner);
		if (!surface) return;
		this.entries.delete(owner);
		this.destroySurface(surface);
	}

	dispose(): void {
		for (const owner of Array.from(this.entries.keys())) this.release(owner);
	}

	private createSurface(ownerDocument: Document): RetainedSimpleStructuralOwnerSurface {
		const root = ownerDocument.win.createDiv();
		root.classList.add(this.rootClassName);
		const renderer = new RetainedProductionSimpleStructuralOwnerRenderer(root);
		let linkBinding: OverlayLinkBinding | null = null;
		let resourcesDisposed = false;
		return {
			root,
			renderer,
			bindOwnerLinks(app, sourcePath) {
				if (resourcesDisposed) throw new Error("Retained structural owner surface resources are disposed");
				if (linkBinding) {
					linkBinding.updateSourcePath(sourcePath);
					return;
				}
				linkBinding = createObsidianOverlayLinkBinding(root, sourcePath, app);
			},
			disposeOwnerResources() {
				if (resourcesDisposed) return;
				resourcesDisposed = true;
				linkBinding?.dispose();
				linkBinding = null;
				renderer.dispose();
				root.remove();
			},
		};
	}

	private destroySurface(surface: RetainedSimpleStructuralOwnerSurface): void {
		surface.disposeOwnerResources();
	}
}

/**
 * Compile the structural subset whose semantic dependencies are covered by the
 * production owner read-set/currentness barrier. Self-content stays legacy for
 * sync structural `if`/`for`; mixed `if` may admit it because the owner supplies
 * a tracked persisted body or the active Live Preview source. Linked/Bases/time
 * dependencies remain legacy-authoritative.
 */
export function compileRetainedSimpleStructuralTemplate(
	viewConfig: ViewConfig,
	editableMode: boolean,
): TemplateIR | null {
	if (editableMode || viewConfig.css?.trim() || viewConfig.js?.trim()) return null;
	if (templateReferencesBases(viewConfig.template, viewConfig.css, viewConfig.js)) return null;
	if (/<(?:script|style|a)\b/i.test(viewConfig.template)) return null;
	if (/\son[a-z]+\s*=/i.test(viewConfig.template)) return null;

	const ir = compileTemplateCompat(viewConfig.template);
	if (ir.diagnostics.length > 0) return null;
	const support = inspectSimpleStructuralOwnerSupport(ir);
	if (support.status !== "supported") return null;
	if (!hasSafeStructuralOwnerDependencies(ir, support.mode === "if-mixed")) return null;
	return ir;
}

function hasSafeStructuralOwnerDependencies(ir: TemplateIR, allowSelfContent: boolean): boolean {
	const hints = ir.dependencyHints;
	if ((!allowSelfContent && hints.usesSelfContent) || hints.usesBases) return false;
	if (hints.staticLinkedFileTargets.length > 0 || hints.usesDynamicLinkedFile) return false;
	if (hints.usesLinkedMetadata || hints.usesLinkedContent) return false;
	if (hints.volatility.length > 0) return false;
	return true;
}

function inspectSimpleStructuralOwnerSupport(
	ir: TemplateIR,
): ({ readonly status: "supported" } & StructuralSupport) | RetainedSimpleStructuralOwnerFallback {
	let support: StructuralSupport | null = null;
	for (let index = 0; index < ir.nodes.length; index++) {
		const node = ir.nodes[index];
		if (node.kind === "static-fragment") continue;
		if (node.kind !== "if" && node.kind !== "for") {
			return {
				status: "fallback",
				code: "top-level-shape",
				path: `nodes[${index}]`,
				message: `Simple structural owner does not support top-level ${node.kind}`,
			};
		}
		if (support) {
			return {
				status: "fallback",
				code: "top-level-shape",
				path: `nodes[${index}]`,
				message: "Simple structural owner supports exactly one top-level structural node",
			};
		}
		if (node.kind === "if") {
			const syncFallback = inspectRetainedProductionConditionalSyncSupport(node);
			if (!syncFallback) {
				support = { node, nodeIndex: index, mode: "if-sync" };
				continue;
			}
			const mixedFallback = inspectConditionalMixedSupport(node);
			if (mixedFallback) return mixedFallback;
			support = { node, nodeIndex: index, mode: "if-mixed" };
			continue;
		}

		const childFallback = inspectRetainedProductionForSyncSupport(node);
		if (childFallback) {
			return {
				status: "fallback",
				code: `for:${childFallback.code}`,
				path: childFallback.path,
				message: childFallback.message,
			};
		}
		support = { node, nodeIndex: index, mode: "for-sync" };
	}

	if (!support) {
		return {
			status: "fallback",
			code: "top-level-shape",
			path: "nodes",
			message: "Simple structural owner requires one top-level if/for node",
		};
	}
	return { status: "supported", ...support };
}

function inspectConditionalMixedSupport(node: IfNode): RetainedSimpleStructuralOwnerFallback | null {
	for (let branchIndex = 0; branchIndex < node.branches.length; branchIndex++) {
		const branchSupport = inspectRetainedProductionConditionalMixedBranchSupport(
			node.branches[branchIndex].children,
		);
		if (branchSupport.supported) continue;
		return {
			status: "fallback",
			code: `if:${branchSupport.code}`,
			path: `branches[${branchIndex}].${branchSupport.path}`,
			message: `branches[${branchIndex}].${branchSupport.message}`,
		};
	}
	return null;
}

function detachTrailingSiblings(marker: Comment): Node[] {
	const trailing: Node[] = [];
	let sibling = marker.nextSibling;
	while (sibling) {
		const next = sibling.nextSibling;
		trailing.push(sibling);
		sibling.remove();
		sibling = next;
	}
	return trailing;
}

function parseOwnerGeneration(revisionKey: string | undefined): number | null {
	if (revisionKey === undefined) return null;
	const separator = revisionKey.lastIndexOf("::");
	if (separator < 0) return null;
	const generation = Number(revisionKey.slice(separator + 2));
	return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}

let nextMarkerId = 0;

function createMarkerToken(ir: TemplateIR): string {
	const staticSource = ir.nodes
		.filter((node) => node.kind === "static-fragment")
		.map((node) => node.html)
		.join("");
	let token: string;
	do {
		token = `morphic-structural-owner-slot-${nextMarkerId++}`;
	} while (staticSource.includes(token));
	return token;
}

function findComment(root: Node, data: string): Comment | null {
	for (const child of Array.from(root.childNodes)) {
		if (child.nodeType === 8 && (child as Comment).data === data) return child as Comment;
		const nested = findComment(child, data);
		if (nested) return nested;
	}
	return null;
}

function parseStructuralHtmlBodyFragment(ownerDocument: Document, source: string): DocumentFragment {
	const Parser = ownerDocument.defaultView?.DOMParser ?? DOMParser;
	const parsedDocument = new Parser().parseFromString(source, "text/html");
	const fragment = ownerDocument.win.createFragment();
	for (const child of Array.from(parsedDocument.body.childNodes)) {
		fragment.appendChild(ownerDocument.importNode(child, true));
	}
	return fragment;
}