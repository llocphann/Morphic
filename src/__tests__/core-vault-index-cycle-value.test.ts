import { describe, expect, it } from "vitest";
import { propertyValueIndexKey } from "../core/vault-index";

describe("VaultIndex cyclic property-value canonicalization", () => {
	it("keeps independently allocated equivalent self-cycles equal", () => {
		const left: Record<string, unknown> = { label: "same" };
		left.self = left;
		const right: Record<string, unknown> = { label: "same" };
		right.self = right;

		expect(propertyValueIndexKey("payload", left)).toBe(
			propertyValueIndexKey("payload", right),
		);
	});

	it("does not alias different cycle topology", () => {
		const selfCycle: Record<string, unknown> = {};
		selfCycle.next = selfCycle;

		const twoNodeA: Record<string, unknown> = {};
		const twoNodeB: Record<string, unknown> = {};
		twoNodeA.next = twoNodeB;
		twoNodeB.next = twoNodeA;

		expect(propertyValueIndexKey("payload", selfCycle)).not.toBe(
			propertyValueIndexKey("payload", twoNodeA),
		);
	});
});
