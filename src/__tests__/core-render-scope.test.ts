import { describe, expect, it, vi } from "vitest";
import { RenderScope } from "../core/render-scope";

describe("Morphic RenderScope", () => {
	it("aborts and disposes render-owned resources exactly once", () => {
		const scope = new RenderScope();
		const disposer = vi.fn();
		const observer = new MutationObserver(() => undefined);
		const disconnect = vi.spyOn(observer, "disconnect");
		scope.load();
		scope.registerDisposer(disposer);
		scope.registerObserver(observer);

		expect(scope.signal.aborted).toBe(false);
		scope.dispose();
		expect(scope.signal.aborted).toBe(true);
		expect(scope.isDisposed).toBe(true);
		expect(disposer).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalledTimes(1);

		scope.dispose();
		expect(disposer).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it("immediately releases resources registered after disposal", () => {
		const scope = new RenderScope();
		const lateDisposer = vi.fn();
		scope.load();
		scope.dispose();

		scope.registerDisposer(lateDisposer);
		expect(lateDisposer).toHaveBeenCalledTimes(1);
	});
});
