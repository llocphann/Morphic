import { describe, expect, it } from "vitest";
import type { CompletionResult } from "@codemirror/autocomplete";
import { enhanceCompletionResult } from "../editor-language-completions";

function baseResult(from: number, labels: string[]): CompletionResult {
	return {
		from,
		options: labels.map(label => ({ label })),
	};
}

function option(result: CompletionResult | null, label: string) {
	return result?.options.find(item => item.label === label);
}

describe("Custom Views 0.4 editor completion parity", () => {
	it("adds semantic completion types for HTML tags and attributes", () => {
		const tag = enhanceCompletionResult(
			"html",
			"<di",
			3,
			false,
			baseResult(1, ["div"]),
		);
		expect(option(tag, "div")?.type).toBe("type");

		const attribute = enhanceCompletionResult(
			"html",
			"<div cl",
			7,
			false,
			baseResult(5, ["class"]),
		);
		expect(option(attribute, "class")?.type).toBe("property");
	});

	it("suggests CSS values for the active property", () => {
		const displayText = "display: fl";
		const display = enhanceCompletionResult("css", displayText, displayText.length, false, null);
		expect(option(display, "flex")?.type).toBe("constant");
		expect(display?.from).toBe(displayText.length - 2);

		const positionText = "position: ab";
		const position = enhanceCompletionResult("css", positionText, positionText.length, false, null);
		expect(option(position, "absolute")?.type).toBe("constant");
	});

	it("adds JavaScript locals without dropping existing keyword/global completions", () => {
		const text = "const movie = {};\nmov";
		const result = enhanceCompletionResult(
			"javascript",
			text,
			text.length,
			false,
			baseResult(text.length - 3, ["Map", "move"]),
		);
		expect(option(result, "movie")?.type).toBe("variable");
		expect(option(result, "Map")?.type).toBe("class");
	});

	it("suggests DOM document methods after member access", () => {
		const text = "document.qu";
		const result = enhanceCompletionResult(
			"javascript",
			text,
			text.length,
			false,
			baseResult(text.length - 2, ["querySelector"]),
		);
		expect(option(result, "querySelector")?.type).toBe("method");
		expect(option(result, "querySelectorAll")?.type).toBe("method");
	});

	it("infers element-like locals created from document queries", () => {
		const text = 'const card = document.querySelector(".card");\ncard.add';
		const result = enhanceCompletionResult(
			"javascript",
			text,
			text.length,
			false,
			null,
		);
		expect(option(result, "addEventListener")?.type).toBe("method");
		expect(option(result, "classList")?.type).toBe("property");
	});
});
