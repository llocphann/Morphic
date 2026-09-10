import { beforeEach, describe, expect, it } from "vitest";
import {
	clearTemplateCompatCache,
	compileTemplateCompat,
} from "../compiler/template-compat";

describe("template compatibility compilation cache", () => {
	beforeEach(() => {
		clearTemplateCompatCache();
	});

	it("reuses compiled IR for the same template source", () => {
		const source = "<article>{{ file.name }}</article>";

		const first = compileTemplateCompat(source);
		const second = compileTemplateCompat(source);

		expect(second).toBe(first);
		expect(second.sourceHash).toBe(first.sourceHash);
	});

	it("does not alias different template revisions", () => {
		const first = compileTemplateCompat("<article>alpha</article>");
		const second = compileTemplateCompat("<article>beta</article>");

		expect(second).not.toBe(first);
		expect(second.sourceHash).not.toBe(first.sourceHash);
	});

	it("drops cached identity after an explicit lifecycle clear", () => {
		const source = "<article>{{ file.basename }}</article>";
		const first = compileTemplateCompat(source);

		clearTemplateCompatCache();
		const second = compileTemplateCompat(source);

		expect(second).not.toBe(first);
		expect(second.sourceHash).toBe(first.sourceHash);
	});

	it("fences implicit wiki-link property traversal while keeping file identity self-only", () => {
		const linked = compileTemplateCompat("<article>{{ friend.status }}</article>");
		expect(linked.dependencyHints.usesLinkedMetadata).toBe(true);
		expect(linked.dependencyHints.usesDynamicLinkedFile).toBe(true);

		const selfFile = compileTemplateCompat("<article>{{ file.name }}</article>");
		expect(selfFile.dependencyHints.usesLinkedMetadata).toBe(false);
		expect(selfFile.dependencyHints.usesDynamicLinkedFile).toBe(false);
	});
});
