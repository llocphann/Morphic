import type { ViewConfig } from "../types";
import { templateReferencesBases } from "../bases/code-blocks";
import type { CompiledExpression } from "../compiler/expression-compiler";
import { compileTemplateCompat } from "../compiler/template-compat";
import type { TemplateIR } from "../compiler/template-ir";
import {
	RetainedProductionLeafRenderer,
	inspectRetainedProductionLeafSupport,
} from "./retained-production-leaf-renderer";

export interface RetainedStaticOwnerSurface {
	readonly root: HTMLElement;
	readonly renderer: RetainedProductionLeafRenderer;
}

export interface RetainedStaticOwnerSurfacePreparation {
	readonly surface: RetainedStaticOwnerSurface;
	/** True while the registry still has the authority state captured at prepare time. */
	isCurrent(): boolean;
	/** Adopt a staged replacement after its live owner commit succeeds. */
	commit(): boolean;
	/** Dispose only staged resources; never tears down the last committed surface. */
	dispose(): void;
}

/**
 * Owner-lifetime retained surface registry used only by the production
 * MarkdownView/Canvas adapter. Render generations may prepare/commit into
 * an entry, but only owner teardown/navigation/fallback releases it.
 */
export class RetainedStaticOwnerSurfaceRegistry<Owner extends object> {
	private readonly entries = new Map<Owner, RetainedStaticOwnerSurface>();

	constructor(private readonly rootClassName: string) {}

	/**
	 * Prepare an owner surface without destroying the last committed surface.
	 *
	 * Moving an owner between containers in the same Document keeps the existing
	 * surface authoritative until commit; appending the same root during commit
	 * performs the move atomically from the caller's perspective. A different
	 * ownerDocument cannot safely reuse that renderer/root, so it gets a detached
	 * candidate that replaces the committed entry only after `commit()`.
	 */
	prepare(owner: Owner, container: HTMLElement): RetainedStaticOwnerSurfacePreparation {
		const existing = this.entries.get(owner);
		if (existing && existing.root.ownerDocument === container.ownerDocument) {
			return {
				surface: existing,
				isCurrent: () => this.entries.get(owner) === existing,
				commit: () => this.entries.get(owner) === existing,
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
			commit: () => {
				if (settled) return this.entries.get(owner) === surface;
				settled = true;
				if (this.entries.get(owner) !== expected) {
					this.destroySurface(surface);
					return false;
				}
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

	/** Compatibility seam for non-transactional callers; production owner paths use prepare(). */
	getOrCreate(owner: Owner, container: HTMLElement): RetainedStaticOwnerSurface {
		const preparation = this.prepare(owner, container);
		if (!preparation.commit()) {
			throw new Error("Retained owner surface authority changed during acquisition");
		}
		return preparation.surface;
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

	private createSurface(ownerDocument: Document): RetainedStaticOwnerSurface {
		const root = ownerDocument.win.createDiv();
		root.classList.add(this.rootClassName);
		return {
			root,
			renderer: new RetainedProductionLeafRenderer(root),
		};
	}

	private destroySurface(surface: RetainedStaticOwnerSurface): void {
		surface.renderer.dispose();
		surface.root.remove();
	}
}

const SAFE_OWNER_FILE_IDENTITY_EXPRESSIONS = new Set([
	"file.name",
	"file.basename",
	"file.path",
	"file.folder",
	"file.ext",
]);

const MUTABLE_FILE_STAT_EXPRESSION_RE = /\bfile\.(?:size|ctime|mtime)\b/;

/**
 * Production retained eligibility gate used by the existing Markdown/Canvas
 * owner adapter.
 *
 * The historical function name is kept to avoid changing Bot 1 call sites. The
 * production caller now opens a RuntimeDataSession before this gate, observes the
 * complete source-file metadata snapshot, freezes that read-set before commit,
 * and synchronously validates it immediately before owner adoption. That makes
 * pure self-metadata expression leaves safe to execute through the compiled
 * retained evaluator while content, linked-file, Bases and volatile expressions
 * remain on the legacy fallback boundary.
 *
 * Mutable file stat expressions remain fenced separately for now. Their runtime
 * value is included in the broad metadata snapshot, but keeping that surface out
 * of this first expansion avoids coupling the optimization to stat-only event
 * routing until that path is independently qualified.
 */
export function compileRetainedStaticTemplate(
	viewConfig: ViewConfig,
	editableMode: boolean,
): TemplateIR | null {
	if (editableMode || viewConfig.css?.trim() || viewConfig.js?.trim()) return null;
	if (templateReferencesBases(viewConfig.template, viewConfig.css, viewConfig.js)) return null;
	if (/<(?:script|style|a)\b/i.test(viewConfig.template)) return null;
	if (/\son[a-z]+\s*=/i.test(viewConfig.template)) return null;

	const ir = compileTemplateCompat(viewConfig.template);
	if (ir.diagnostics.length > 0) return null;
	if (inspectRetainedProductionLeafSupport(ir)) return null;
	if (!hasSafeProductionOwnerDependencies(ir)) return null;
	if (!hasSafeProductionOwnerLeafNodes(ir)) return null;
	return ir;
}

function hasSafeProductionOwnerDependencies(ir: TemplateIR): boolean {
	const hints = ir.dependencyHints;
	if (hints.usesSelfContent || hints.usesBases) return false;
	if (hints.staticLinkedFileTargets.length > 0 || hints.usesDynamicLinkedFile) return false;
	if (hints.usesLinkedMetadata || hints.usesLinkedContent) return false;
	if (hints.volatility.length > 0) return false;
	return true;
}

function hasSafeProductionOwnerLeafNodes(ir: TemplateIR): boolean {
	for (const node of ir.nodes) {
		switch (node.kind) {
			case "static-fragment":
				break;
			case "set":
			case "text-slot":
				if (!isSafeProductionOwnerExpression(node.expression)) return false;
				break;
			case "expression-slot":
				if (node.context !== "text" || !isSafeProductionOwnerExpression(node.expression)) {
					return false;
				}
				break;
			case "attribute-slot":
				if (!node.parts) return false;
				for (const part of node.parts) {
					if (part.kind === "expression" && !isSafeProductionOwnerExpression(part.expression)) {
						return false;
					}
				}
				break;
			case "markdown-slot":
			case "content-slot":
			case "raw-html-slot":
			case "if":
			case "for":
				return false;
		}
	}
	return true;
}

function isSafeProductionOwnerExpression(expression: CompiledExpression): boolean {
	const hints = expression.dependencyHints;
	if (expression.pipeFilters !== null) return false;
	if (hints.usesSelfContent || hints.usesBases) return false;
	if (hints.staticLinkedFileTargets.length > 0 || hints.usesDynamicLinkedFile) return false;
	if (hints.usesLinkedMetadata || hints.usesLinkedContent) return false;
	if (hints.volatility.length > 0) return false;
	if (MUTABLE_FILE_STAT_EXPRESSION_RE.test(expression.expressionSource)) return false;

	if (!hints.usesSelfMetadata) return true;
	if (SAFE_OWNER_FILE_IDENTITY_EXPRESSIONS.has(expression.expressionSource)) return true;

	// Arbitrary frontmatter expressions (for example `rating > 8`) are safe here
	// because the production RuntimeDataSession observes and validates the complete
	// source metadata snapshot before this retained transaction may commit.
	return true;
}
