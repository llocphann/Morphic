import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import {
	clearCompiledScriptCache,
	executeCustomViewJavaScript,
	warmCustomViewScriptEngine,
} from "../script-engine";
import type { CustomViewScriptContext } from "../script-engine";

function makeContext(): CustomViewScriptContext {
	const doc = new DOMParser().parseFromString("<div></div>", "text/html");
	const container = doc.body.firstElementChild as HTMLElement;
	return {
		app: new App(),
		file: new TFile(),
		container,
		frontmatter: undefined,
		bodyContent: "",
		viewConfig: undefined,
		activeDocument: doc,
		activeWindow: doc.defaultView as Window,
	};
}

describe("script engine", () => {
	it("executes JavaScript with the rendered container as this", async () => {
		const context = makeContext();
		await executeCustomViewJavaScript("this.dataset.ready = 'true';", context);
		expect(context.container.dataset.ready).toBe("true");
	});

	it("passes the complete tp context to scripts", async () => {
		const context = makeContext();
		context.bodyContent = "hello";
		await executeCustomViewJavaScript("this.textContent = tp.bodyContent;", context);
		expect(context.container.textContent).toBe("hello");
	});

	it("keeps the old warm-up hook as a harmless compatibility no-op", async () => {
		await expect(warmCustomViewScriptEngine()).resolves.toBeUndefined();
	});

	it("can clear compiled scripts between isolated lifetimes", async () => {
		const context = makeContext();
		await executeCustomViewJavaScript("this.dataset.one = '1';", context);
		clearCompiledScriptCache();
		await executeCustomViewJavaScript("this.dataset.two = '2';", context);
		expect(context.container.dataset.one).toBe("1");
		expect(context.container.dataset.two).toBe("2");
	});
});
