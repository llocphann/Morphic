import type { App, Plugin } from "obsidian";
import {
	allPropertyDataDependencyKey,
	propertyDataDependencyKey,
	type DependencyKey,
} from "./core";
import { installCustomViews04Capabilities } from "./cv04-capability-adapter";

interface MetadataTypeManagerLike {
	on(event: "changed", callback: (propertyName: string) => void): unknown;
	off(event: "changed", callback: (propertyName: string) => void): void;
}

interface LifecycleRegistrar {
	register(callback: () => void): void;
}

interface DependencyInvalidator {
	invalidateMany(keys: Iterable<DependencyKey>): readonly unknown[];
}

/**
 * Bridge Obsidian's vault-wide assigned property-type event into Morphic's
 * existing precise property-data dependency graph. This onload seam also owns
 * installation of additive Custom Views 0.4 capability adaptations because it
 * runs after Core V2 controller/data initialization and before first rendering.
 */
export function registerAssignedPropertyTypeInvalidation(
	lifecycle: LifecycleRegistrar,
	app: App,
	invalidation: DependencyInvalidator | null,
): void {
	const plugin = lifecycle as unknown as Partial<Plugin>;
	if (typeof plugin.addCommand === "function" && typeof plugin.register === "function") {
		installCustomViews04Capabilities(lifecycle as unknown as Plugin, app);
		registerCapabilityStyles(lifecycle);
	}

	if (!invalidation) return;
	const manager = (app as unknown as { metadataTypeManager?: MetadataTypeManagerLike }).metadataTypeManager;
	if (!manager || typeof manager.on !== "function" || typeof manager.off !== "function") return;

	const onChanged = (propertyName: string) => {
		if (!propertyName) return;
		invalidation.invalidateMany([
			propertyDataDependencyKey(propertyName),
			allPropertyDataDependencyKey(),
		]);
	};

	manager.on("changed", onChanged);
	lifecycle.register(() => manager.off("changed", onChanged));
}

function registerCapabilityStyles(lifecycle: LifecycleRegistrar): void {
	const style = activeDocument.createElement("style");
	style.setAttribute("data-morphic-cv04-capabilities", "true");
	style.textContent = `
.workspace-leaf-content.cv-hide-navigation > .view-header {
	display: none;
}
.morphic-navigation-hold {
	background: var(--background-primary);
}
`;
	activeDocument.head.appendChild(style);
	lifecycle.register(() => style.remove());
}
