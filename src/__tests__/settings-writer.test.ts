import { describe, expect, it, vi } from "vitest";
import { getSharedSettingsWriter, SettingsWriter } from "../settings-writer";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

describe("SettingsWriter", () => {
	it("serializes writes and collapses queued edits into the latest snapshot", async () => {
		const firstWrite = deferred();
		const writes: { value: number }[] = [];
		const write = vi.fn(async (value: { value: number }) => {
			writes.push(value);
			if (writes.length === 1) await firstWrite.promise;
		});
		const writer = new SettingsWriter(write);

		const first = writer.save({ value: 1 });
		await Promise.resolve();
		const second = writer.save({ value: 2 });
		const third = writer.save({ value: 3 });

		expect(writes).toEqual([{ value: 1 }]);
		firstWrite.resolve();
		await Promise.all([first, second, third]);

		expect(writes).toEqual([{ value: 1 }, { value: 3 }]);
		expect(write).toHaveBeenCalledTimes(2);
	});

	it("persists an immutable snapshot instead of a later-mutated settings object", async () => {
		const gate = deferred();
		const writes: { nested: { value: number } }[] = [];
		const writer = new SettingsWriter<{ nested: { value: number } }>(async value => {
			await gate.promise;
			writes.push(value);
		});
		const settings = { nested: { value: 1 } };

		const saving = writer.save(settings);
		settings.nested.value = 99;
		gate.resolve();
		await saving;

		expect(writes).toEqual([{ nested: { value: 1 } }]);
	});

	it("reuses one queue for the same app across hot-reload style wrapper creation", async () => {
		const app = {};
		const gate = deferred();
		const writes: number[] = [];
		const first = getSharedSettingsWriter<number>(app, async value => {
			writes.push(value);
			await gate.promise;
		});
		const second = getSharedSettingsWriter<number>(app, async value => {
			writes.push(value);
		});

		const a = first.save(1);
		await Promise.resolve();
		const b = second.save(2);
		gate.resolve();
		await Promise.all([a, b]);

		expect(writes).toEqual([1, 2]);
	});

	it("resolves whenIdle only after both active and coalesced writes finish", async () => {
		const gate = deferred();
		const writer = new SettingsWriter(async (value: number) => {
			if (value === 1) await gate.promise;
		});

		const first = writer.save(1);
		await Promise.resolve();
		const second = writer.save(2);
		let idle = false;
		const idlePromise = writer.whenIdle().then(() => { idle = true; });

		await Promise.resolve();
		expect(idle).toBe(false);
		gate.resolve();
		await Promise.all([first, second, idlePromise]);
		expect(idle).toBe(true);
	});
});
