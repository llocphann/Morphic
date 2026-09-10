import { describe, expect, it, vi } from "vitest";
import { RenderController, type RenderTransaction } from "../core/render-controller";

function transaction(label: string, commits: string[]): RenderTransaction {
	return { commit: () => { commits.push(label); } };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("Morphic RenderController", () => {
	it("allows only the newest async generation to commit", async () => {
		const commits: string[] = [];
		const slow = deferred<RenderTransaction>();
		const controller = new RenderController<string>((input) => {
			if (input === "slow") return slow.promise;
			return transaction(input, commits);
		});

		const first = controller.render("slow", "slow-key");
		expect(controller.currentPendingKey).toBe("slow-key");
		const second = controller.render("fast", "fast-key");
		expect(controller.currentPendingKey).toBe("fast-key");
		expect((await second).status).toBe("committed");
		expect(controller.currentPendingKey).toBeNull();

		slow.resolve(transaction("slow", commits));
		expect((await first).status).toBe("stale");
		expect(commits).toEqual(["fast"]);
	});

	it("skips an unchanged committed key until invalidated", async () => {
		const commits: string[] = [];
		const controller = new RenderController<string>((input) => transaction(input, commits));

		expect((await controller.render("one", "same")).status).toBe("committed");
		expect((await controller.render("one", "same")).status).toBe("skipped");
		controller.invalidate();
		expect((await controller.render("two", "same")).status).toBe("committed");
		expect(commits).toEqual(["one", "two"]);
	});

	it("does not replace the last good commit when preparation fails", async () => {
		const commits: string[] = [];
		const controller = new RenderController<string>((input) => {
			if (input === "bad") throw new Error("prepare failed");
			return transaction(input, commits);
		});

		await controller.render("good", "good");
		await expect(controller.render("bad", "bad")).rejects.toThrow("prepare failed");
		expect(controller.lastCommittedKey).toBe("good");
		expect(controller.currentPendingKey).toBeNull();
		expect(commits).toEqual(["good"]);
	});

	it("cancels pending work without disturbing the last committed scope", async () => {
		const commits: string[] = [];
		const slow = deferred<RenderTransaction>();
		const controller = new RenderController<string>((input) => {
			if (input === "slow") return slow.promise;
			return transaction(input, commits);
		});

		await controller.render("good", "good");
		const pending = controller.render("slow", "slow");
		expect(controller.currentPendingKey).toBe("slow");
		controller.cancelPending();
		expect(controller.currentPendingKey).toBeNull();
		expect(controller.lastCommittedKey).toBe("good");

		slow.resolve(transaction("slow", commits));
		expect((await pending).status).toBe("stale");
		expect(commits).toEqual(["good"]);
	});

	it("rejects a transaction whose owner state is invalid at commit time", async () => {
		const commits: string[] = [];
		const controller = new RenderController<string>((input) => {
			if (input === "invalid") {
				return {
					isValid: () => false,
					commit: () => { commits.push("invalid"); },
				};
			}
			return transaction(input, commits);
		});

		await controller.render("good", "good");
		const result = await controller.render("invalid", "invalid");
		expect(result.status).toBe("stale");
		expect(controller.lastCommittedKey).toBe("good");
		expect(controller.currentPendingKey).toBeNull();
		expect(commits).toEqual(["good"]);
	});

	it("releases committed scope resources without disposing the owner controller", async () => {
		const commits: string[] = [];
		const release = vi.fn();
		const controller = new RenderController<string>((input, context) => {
			context.scope.registerDisposer(release);
			return transaction(input, commits);
		});

		expect((await controller.render("first", "same")).status).toBe("committed");
		controller.releaseCommitted();
		expect(release).toHaveBeenCalledTimes(1);
		expect(controller.lastCommittedKey).toBeNull();
		expect((await controller.render("second", "same")).status).toBe("committed");
		expect(commits).toEqual(["first", "second"]);
	});

	it("refuses work after disposal", async () => {
		const controller = new RenderController<string>(() => ({ commit() { /* noop */ } }));
		controller.dispose();
		expect((await controller.render("x", "x")).status).toBe("disposed");
	});
});
