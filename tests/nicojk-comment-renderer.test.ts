import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CommentRenderer } from "../src/plugins/nicojk/comment-renderer";

/** Count resources owned by the installed renderer without requiring a GPU. */
function createBrowserStandIns(t: TestContext, fallback = false) {
	const resources = {
		programs: new Set<object>(),
		buffers: new Set<object>(),
		vertexArrays: new Set<object>(),
		textures: new Set<object>(),
	};
	const resourceMethods = new Map([
		["createProgram", resources.programs],
		["deleteProgram", resources.programs],
		["createBuffer", resources.buffers],
		["deleteBuffer", resources.buffers],
		["createVertexArray", resources.vertexArrays],
		["deleteVertexArray", resources.vertexArrays],
		["createTexture", resources.textures],
		["deleteTexture", resources.textures],
	]);
	const timers = new Map<number, () => void>();
	let nextTimer = 0;
	const clearTimeout = globalThis.clearTimeout;
	t.mock.method(
		globalThis,
		"clearTimeout",
		(timer: Parameters<typeof globalThis.clearTimeout>[0]) => {
			if (typeof timer === "number") timers.delete(timer);
			else clearTimeout(timer);
		},
	);
	const canvases: CanvasStandIn[] = [];
	class CanvasStandIn {
		width = 300;
		height = 150;
		style: Record<string, string> = {};
		listeners = new Map<string, Set<() => void>>();
		parentNode: typeof container | null = null;
		contextLost = false;
		gl = new Proxy(
			{},
			{
				get: (_target, name) => {
					const resourceSet = resourceMethods.get(String(name));
					if (resourceSet) {
						return (resource: object) => {
							if (String(name).startsWith("delete")) {
								resourceSet.delete(resource);
								return;
							}
							const created = {};
							resourceSet.add(created);
							return created;
						};
					}
					if (name === "getExtension")
						return () => ({
							loseContext: () => {
								this.contextLost = true;
								assert.equal(this.listenerCount(), 0);
							},
						});
					if (name === "isContextLost") return () => this.contextLost;
					if (name === "createShader" || name === "getUniformLocation")
						return () => ({});
					if (name === "getShaderParameter" || name === "getProgramParameter")
						return () => true;
					if (name === "getParameter") return () => 4096;
					if (typeof name === "string" && /^[A-Z0-9_]+$/.test(name)) return 1;
					return () => {};
				},
			},
		);

		constructor() {
			canvases.push(this);
		}

		getContext(kind: string) {
			if (fallback && canvases[0] === this) return null;
			if (kind === "webgl2") return this.contextLost ? null : this.gl;
			return new Proxy(
				{ font: "10px sans-serif" },
				{
					get: (target, name) => {
						if (name in target) return Reflect.get(target, name);
						if (name === "getTransform")
							return () => ({ a: 1, d: 1, e: 0, f: 0 });
						if (name === "getImageData")
							return () => ({ data: [255, 255, 255, 255] });
						if (name === "measureText")
							return (text: string) => ({
								width: text.length * 20,
								actualBoundingBoxAscent: 20,
								actualBoundingBoxDescent: 5,
							});
						return () => {};
					},
				},
			);
		}

		addEventListener(name: string, listener: () => void) {
			if (!this.listeners.has(name)) this.listeners.set(name, new Set());
			this.listeners.get(name)?.add(listener);
		}

		removeEventListener(name: string, listener: () => void) {
			this.listeners.get(name)?.delete(listener);
		}

		listenerCount() {
			return [...this.listeners.values()].reduce(
				(count, listeners) => count + listeners.size,
				0,
			);
		}

		remove() {
			if (!this.parentNode) return;
			this.parentNode.children = this.parentNode.children.filter(
				(child) => child !== this,
			);
			this.parentNode = null;
		}

		replaceWith(canvas: CanvasStandIn) {
			const parent = this.parentNode;
			this.remove();
			parent?.append(canvas);
		}
	}
	const document = { createElement: () => new CanvasStandIn() };
	const container = {
		ownerDocument: document,
		children: [] as CanvasStandIn[],
		append(canvas: CanvasStandIn) {
			this.children.push(canvas);
			canvas.parentNode = this;
		},
		querySelector: () => container.children[0] ?? null,
	};
	for (const [name, value] of Object.entries({
		document,
		window: {
			setTimeout(callback: () => void) {
				timers.set(++nextTimer, callback);
				return nextTimer;
			},
		},
		HTMLCanvasElement: CanvasStandIn,
		HTMLVideoElement: class {},
	})) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, value });
		t.after(() => {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		});
	}
	return { container, canvases, resources, timers };
}

test("repeated renderer rebuilds release GL resources and use a fresh canvas", (t) => {
	const { container, canvases, resources } = createBrowserStandIns(t);
	for (let generation = 0; generation < 100; generation++) {
		const renderer = new CommentRenderer(
			container as unknown as HTMLElement,
			[],
			"empty",
		);
		const canvas = container.children[0];
		assert.equal(container.children.length, 1);
		assert.equal(canvas.width, 1920);
		assert.equal(canvas.height, 1080);
		assert.equal(canvas.contextLost, false);
		assert.equal(canvas.listenerCount(), 2);
		assert.equal(resources.programs.size, 2);
		renderer.destroy();
		renderer.destroy();
		assert.equal(container.children.length, 0);
		assert.equal(canvas.listenerCount(), 0);
		assert.equal(canvas.contextLost, true);
		assert.equal(canvas.width, 0);
		assert.equal(canvas.height, 0);
		for (const resourceSet of Object.values(resources)) {
			assert.equal(resourceSet.size, 0);
		}
	}
	const displayedCanvases = canvases.filter((canvas) => canvas.contextLost);
	assert.equal(new Set(displayedCanvases).size, 100);
});

test("disposes the replacement canvas after the library falls back to 2D", (t) => {
	const { container, canvases } = createBrowserStandIns(t, true);
	t.mock.method(console, "warn", () => {});
	const renderer = new CommentRenderer(
		container as unknown as HTMLElement,
		[],
		"empty",
	);
	const replacement = container.children[0];
	assert.notEqual(replacement, canvases[0]);
	assert.equal(canvases[0].width, 0);
	assert.equal(replacement.width, 1920);
	renderer.destroy();
	assert.equal(container.children.length, 0);
	assert.equal(replacement.width, 0);
	assert.equal(replacement.height, 0);
});

test("rebuilding after drawing live comments releases textures and image timers", (t) => {
	const { container, resources, timers } = createBrowserStandIns(t);
	for (let id = 0; id < 20; id++) {
		const renderer = new CommentRenderer(
			container as unknown as HTMLElement,
			[],
			"empty",
		);
		renderer.addComments({
			id,
			vpos: 1000,
			content: `live comment ${id}`,
			date: 0,
			date_usec: 0,
			owner: false,
			premium: false,
			mail: [],
			user_id: -1,
			layer: 0,
			is_my_post: false,
		});
		renderer.drawCanvas(1100);
		assert.ok(resources.textures.size > 0);
		assert.ok(timers.size > 0);
		renderer.destroy();
		assert.equal(resources.textures.size, 0);
		assert.equal(timers.size, 0);
	}
});
