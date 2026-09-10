import { RenderController, type RenderPreparer } from "./render-controller";

/**
 * Explicit owner -> controller registry. Owners are MarkdownView instances or
 * Canvas node objects. We intentionally do not key controllers by TFile.
 */
export class RenderControllerRegistry<Owner extends object, Input> {
	private readonly controllers = new Map<Owner, RenderController<Input>>();

	constructor(private readonly createPreparer: (owner: Owner) => RenderPreparer<Input>) {}

	getOrCreate(owner: Owner): RenderController<Input> {
		let controller = this.controllers.get(owner);
		if (!controller) {
			controller = new RenderController<Input>(this.createPreparer(owner));
			this.controllers.set(owner, controller);
		}
		return controller;
	}

	get(owner: Owner): RenderController<Input> | undefined {
		return this.controllers.get(owner);
	}

	invalidate(owner: Owner): void {
		this.controllers.get(owner)?.invalidate();
	}

	delete(owner: Owner): void {
		const controller = this.controllers.get(owner);
		if (!controller) return;
		controller.dispose();
		this.controllers.delete(owner);
	}

	/** Snapshot-friendly iteration for lifecycle owners that need to reap closed views. */
	owners(): IterableIterator<Owner> {
		return this.controllers.keys();
	}

	dispose(): void {
		for (const controller of this.controllers.values()) controller.dispose();
		this.controllers.clear();
	}

	get size(): number {
		return this.controllers.size;
	}
}
