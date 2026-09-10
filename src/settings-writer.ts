interface Completion {
	resolve(): void;
	reject(reason: unknown): void;
}

interface QueuedSnapshot<T> {
	snapshot: T;
	persist(snapshot: T): Promise<void>;
	completions: Completion[];
}

interface DeferredVoid extends Completion {
	promise: Promise<void>;
}

export class SettingsWriter<T> {
	private queued: QueuedSnapshot<T> | undefined;
	private active = false;
	private readonly idleListeners = new Set<() => void>();

	constructor(private readonly defaultPersist: (snapshot: T) => Promise<void>) {}

	save(value: T, persist: (snapshot: T) => Promise<void> = this.defaultPersist): Promise<void> {
		const snapshot = structuredClone(value);
		const completion = deferredVoid();

		if (this.queued === undefined) {
			this.queued = {
				snapshot,
				persist,
				completions: [completion],
			};
		} else {
			this.queued.snapshot = snapshot;
			this.queued.persist = persist;
			this.queued.completions.push(completion);
		}

		if (!this.active) void this.flushQueue();
		return completion.promise;
	}

	whenIdle(): Promise<void> {
		if (!this.active && this.queued === undefined) return Promise.resolve();
		return new Promise(resolve => this.idleListeners.add(resolve));
	}

	private async flushQueue(): Promise<void> {
		if (this.active) return;
		this.active = true;

		try {
			while (this.queued !== undefined) {
				const current = this.queued;
				this.queued = undefined;
				try {
					await current.persist(current.snapshot);
					for (const completion of current.completions) completion.resolve();
				} catch (error) {
					for (const completion of current.completions) completion.reject(error);
				}
			}
		} finally {
			this.active = false;
			for (const listener of this.idleListeners) listener();
			this.idleListeners.clear();
		}
	}
}

const SHARED_WRITER = Symbol.for("morphic.settings-writer.v1");

type WriterHost = {
	[SHARED_WRITER]?: SettingsWriter<unknown>;
};

export function getSharedSettingsWriter<T>(app: object, persist: (value: T) => Promise<void>): {
	save(value: T): Promise<void>;
	whenIdle(): Promise<void>;
} {
	const host = app as WriterHost;
	if (!host[SHARED_WRITER]) {
		host[SHARED_WRITER] = new SettingsWriter<unknown>(async () => {
			throw new Error("A settings persistence callback is required.");
		});
	}
	const shared = host[SHARED_WRITER];
	return {
		save(value) {
			return shared.save(value, snapshot => persist(snapshot as T));
		},
		whenIdle() {
			return shared.whenIdle();
		},
	};
}

function deferredVoid(): DeferredVoid {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}
