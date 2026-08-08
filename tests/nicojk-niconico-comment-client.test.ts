import assert from "node:assert/strict";
import test from "node:test";

import protobuf from "@n-air-app/nicolive-comment-protobuf";
import { LengthDelimitedReader } from "../src/plugins/nicojk/ndgr-protobuf";
import {
	getNiconicoLiveVpos,
	modifierToMail,
	NiconicoCommentClient,
} from "../src/plugins/nicojk/niconico-comment-client";
import type { ResolvedCommentSource } from "../src/plugins/nicojk/source-resolver";

const { dwango } = protobuf;
const { ChunkedEntry, ChunkedMessage, MessageSegment } =
	dwango.nicolive.chat.service.edge;
const { Chat } = dwango.nicolive.chat.data;

function frame(body: Uint8Array) {
	const prefix: number[] = [];
	let length = body.length;
	while (length >= 0x80) {
		prefix.push((length & 0x7f) | 0x80);
		length >>>= 7;
	}
	prefix.push(length);
	return Uint8Array.from([...prefix, ...body]);
}

function concat(...parts: Uint8Array[]) {
	const result = new Uint8Array(
		parts.reduce((length, part) => length + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function streamOf(...chunks: Uint8Array[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function streamThatErrorsAfter(chunk: Uint8Array, error: Error, delay = 0) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			setTimeout(() => controller.error(error), delay);
		},
	});
}

function streamUntilAbort(chunks: Uint8Array[], signal: AbortSignal) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			if (signal.aborted) {
				controller.error(
					new DOMException("The stream was aborted", "AbortError"),
				);
				return;
			}
			signal.addEventListener(
				"abort",
				() =>
					controller.error(
						new DOMException("The stream was aborted", "AbortError"),
					),
				{ once: true },
			);
		},
	});
}

function source(): ResolvedCommentSource {
	return {
		key: "primary:jk1:na:1700000000",
		kind: "primary",
		jkId: "jk1",
		channelName: "fixture",
		nicoliveCommunityId: "co1",
		startAt: 1_700_000_000,
		endAt: 1_700_000_060,
	};
}

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	sent: string[] = [];
	url: string;
	readyState = 0;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(value: string) {
		this.sent.push(value);
	}

	close() {
		this.readyState = 3;
		this.onclose?.();
	}

	open() {
		this.readyState = 1;
		this.onopen?.();
	}

	message(data: unknown) {
		this.onmessage?.({ data } as MessageEvent);
	}
}

class FakeBroadcastChannel {
	static channels = new Map<string, Set<FakeBroadcastChannel>>();
	onmessage: ((event: MessageEvent) => void) | null = null;
	private closed = false;
	private readonly name: string;

	constructor(name: string) {
		this.name = name;
		const channels = FakeBroadcastChannel.channels.get(name) ?? new Set();
		channels.add(this);
		FakeBroadcastChannel.channels.set(name, channels);
	}

	postMessage(data: unknown) {
		if (this.closed) return;
		for (const channel of FakeBroadcastChannel.channels.get(this.name) ?? []) {
			if (channel === this || channel.closed) continue;
			queueMicrotask(() => channel.onmessage?.({ data } as MessageEvent));
		}
	}

	close() {
		this.closed = true;
		FakeBroadcastChannel.channels.get(this.name)?.delete(this);
	}
}

test("converts NDGR modifiers to renderer mail commands", () => {
	assert.deepEqual(
		modifierToMail({
			position: "ue",
			size: "big",
			namedColor: "red",
			fullColor: "#010203",
			font: "gothic",
			opacity: "Translucent",
		}),
		["ue", "big", "red", "#010203", "gothic", "nico:opacity:0.5"],
	);
	assert.deepEqual(modifierToMail({ opacity: "Normal" }), ["nico:opacity:1"]);
});

test("reports an incomplete length-delimited frame at end of stream", () => {
	const reader = new LengthDelimitedReader();
	assert.deepEqual(reader.push(Uint8Array.of(3, 1)), []);
	assert.equal(reader.hasPendingFrame(), true);
});

test("anchors live comments to receive time while preserving their timestamp", () => {
	const receivedAt = 1_700_000_123_450;
	const dateUsec = 456_000;
	assert.equal(
		getNiconicoLiveVpos(receivedAt, dateUsec),
		Math.floor(receivedAt / 10) +
			200 +
			Math.floor((dateUsec % 100_000) / 2_000),
	);
});

test("moves to error without fetching when the community ID is missing", () => {
	FakeWebSocket.instances = [];
	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	globalThis.fetch = async () => {
		fetchCalled = true;
		return new Response();
	};

	const client = new NiconicoCommentClient();
	try {
		client.connect({ ...source(), nicoliveCommunityId: undefined });
		assert.equal(client.getStatus(), "error");
		assert.equal(fetchCalled, false);
		assert.equal(FakeWebSocket.instances.length, 0);
	} finally {
		client.disconnect();
		globalThis.fetch = originalFetch;
	}
});

test("passive mode connects without opening sockets or fetching streams", () => {
	FakeWebSocket.instances = [];
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	(
		globalThis as typeof globalThis & { WebSocket: typeof FakeWebSocket }
	).WebSocket = FakeWebSocket as never;
	globalThis.fetch = async () => {
		fetchCalled = true;
		return new Response();
	};

	const client = new NiconicoCommentClient();
	try {
		client.connect(source(), { passive: true });
		assert.equal(client.getStatus(), "connected");
		assert.equal(fetchCalled, false);
		assert.equal(FakeWebSocket.instances.length, 0);
	} finally {
		client.disconnect();
		globalThis.fetch = originalFetch;
		(
			globalThis as typeof globalThis & { WebSocket: typeof WebSocket }
		).WebSocket = originalWebSocket;
	}
});

test("receives anonymous NDGR comments through the shared client boundary", async () => {
	FakeWebSocket.instances = [];
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;
	const originalDateNow = Date.now;
	const segment = frame(
		Uint8Array.from(
			ChunkedMessage.encode({
				message: {
					overflowedChat: Chat.fromObject({
						content: "hello",
						no: 7,
						vpos: 125,
					}),
				},
			}).finish(),
		),
	);
	const view = frame(
		Uint8Array.from(
			ChunkedEntry.encode({
				segment: MessageSegment.create({ uri: "https://example.test/segment" }),
			}).finish(),
		),
	);
	const next = frame(
		Uint8Array.from(ChunkedEntry.encode({ next: { at: 123 } }).finish()),
	);
	const page = `<script id="embedded-data" data-props='{"program":{"nicoliveProgramId":"lv1","vposBaseTime":1700000000},"site":{"relive":{"webSocketUrl":"wss://example.test/watch"}}}'></script>`;
	const requests: string[] = [];
	(
		globalThis as typeof globalThis & { WebSocket: typeof FakeWebSocket }
	).WebSocket = FakeWebSocket as never;
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.startsWith("https://live.nicovideo.jp/watch/")) {
			const response = new Response(page, {
				status: 200,
				headers: { "content-type": "text/html" },
			});
			Object.defineProperty(response, "url", {
				value: "https://live.nicovideo.jp/watch/lv1",
			});
			return response;
		}
		if (url.includes("/view?at=now")) {
			return new Response(streamOf(concat(view, next)), { status: 200 });
		}
		if (url.includes("/view?at=123")) {
			return new Response(streamOf(), { status: 200 });
		}
		return new Response(streamOf(segment), { status: 200 });
	};
	Date.now = () => 1_700_000_002_000;

	try {
		const client = new NiconicoCommentClient();
		const comments: unknown[] = [];
		const statuses: string[] = [];
		client.onStatusUpdate((status) => statuses.push(status));
		client.onComment((comment) => comments.push(comment));
		client.connect(source());
		await new Promise((resolve) => setTimeout(resolve, 0));
		const socket = FakeWebSocket.instances[0];
		assert.ok(socket);
		socket.open();
		assert.deepEqual(JSON.parse(socket.sent[0]), {
			type: "startWatching",
			data: { reconnect: false },
		});
		socket.message(JSON.stringify({ type: "ping", data: {} }));
		assert.deepEqual(JSON.parse(socket.sent[1]), { type: "pong" });
		socket.message(
			JSON.stringify({
				type: "messageServer",
				data: { viewUri: "https://example.test/view" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(statuses.includes("connected"));
		assert.ok(requests.includes("https://example.test/view?at=now"));
		assert.ok(requests.includes("https://example.test/view?at=123"));
		assert.deepEqual(comments[0], {
			id: 7,
			no: 7,
			vpos: 170000000425,
			content: "hello",
			date: 1700000001,
			date_usec: 250000,
			mail: [],
			user_id: "guest",
			premium: 0,
			anonymity: 1,
			origin: "ws",
		});
		client.disconnect();
		assert.equal(client.getStatus(), "disconnected");
	} finally {
		globalThis.fetch = originalFetch;
		Date.now = originalDateNow;
		(
			globalThis as typeof globalThis & { WebSocket: typeof WebSocket }
		).WebSocket = originalWebSocket;
	}
});

test("propagates comments across clients via BroadcastChannel", async () => {
	FakeWebSocket.instances = [];
	const originalWebSocket = globalThis.WebSocket;
	const originalBroadcastChannel = globalThis.BroadcastChannel;
	const originalFetch = globalThis.fetch;
	const originalNavigatorLocks = globalThis.navigator?.locks;
	const segment = frame(
		Uint8Array.from(
			ChunkedMessage.encode({
				message: {
					chat: Chat.fromObject({
						content: "broadcast comment",
						no: 1,
						vpos: 100,
					}),
				},
			}).finish(),
		),
	);
	const view = frame(
		Uint8Array.from(
			ChunkedEntry.encode({
				segment: MessageSegment.create({ uri: "https://example.test/segment" }),
			}).finish(),
		),
	);
	const page = `<script id="embedded-data" data-props='{"program":{"nicoliveProgramId":"lv1","vposBaseTime":1700000000},"site":{"relive":{"webSocketUrl":"wss://example.test/watch"}}}'></script>`;
	(
		globalThis as typeof globalThis & { WebSocket: typeof FakeWebSocket }
	).WebSocket = FakeWebSocket as never;
	(
		globalThis as typeof globalThis & {
			BroadcastChannel: typeof FakeBroadcastChannel;
		}
	).BroadcastChannel = FakeBroadcastChannel as never;
	if (globalThis.navigator) {
		Object.defineProperty(globalThis.navigator, "locks", {
			configurable: true,
			value: undefined,
		});
	}
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.startsWith("https://live.nicovideo.jp/watch/")) {
			const response = new Response(page, { status: 200 });
			Object.defineProperty(response, "url", {
				value: "https://live.nicovideo.jp/watch/lv1",
			});
			return response;
		}
		if (url.includes("/view/a")) {
			return new Response(streamOf(view), { status: 200 });
		}
		if (url.includes("/view/b")) {
			return new Response(streamOf(), { status: 200 });
		}
		return new Response(streamOf(segment), { status: 200 });
	};

	const clientA = new NiconicoCommentClient();
	const clientB = new NiconicoCommentClient();
	const commentsA: { origin?: string; content: string }[] = [];
	const commentsB: { origin?: string; content: string }[] = [];
	clientA.onComment((comment) => commentsA.push(comment));
	clientB.onComment((comment) => commentsB.push(comment));

	try {
		clientA.connect(source());
		clientB.connect(source());
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(FakeWebSocket.instances.length, 2);

		FakeWebSocket.instances[0]?.open();
		FakeWebSocket.instances[1]?.open();
		FakeWebSocket.instances[0]?.message(
			JSON.stringify({
				type: "messageServer",
				data: { viewUri: "https://example.test/view/a" },
			}),
		);
		FakeWebSocket.instances[1]?.message(
			JSON.stringify({
				type: "messageServer",
				data: { viewUri: "https://example.test/view/b" },
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(commentsA.length, 1);
		assert.equal(commentsA[0]?.content, "broadcast comment");
		assert.equal(commentsA[0]?.origin, "ws");
		assert.equal(commentsB.length, 1);
		assert.equal(commentsB[0]?.content, "broadcast comment");
		assert.equal(commentsB[0]?.origin, "broadcast");
	} finally {
		clientA.disconnect();
		clientB.disconnect();
		globalThis.fetch = originalFetch;
		(
			globalThis as typeof globalThis & { WebSocket: typeof WebSocket }
		).WebSocket = originalWebSocket;
		(
			globalThis as typeof globalThis & {
				BroadcastChannel: typeof BroadcastChannel;
			}
		).BroadcastChannel = originalBroadcastChannel;
		if (globalThis.navigator) {
			Object.defineProperty(globalThis.navigator, "locks", {
				configurable: true,
				value: originalNavigatorLocks,
			});
		}
	}
});

test("keeps connected status when an individual segment fails", async () => {
	FakeWebSocket.instances = [];
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;
	const originalConsoleError = console.error;
	const segmentError = new Error("segment stream failed");
	const view = frame(
		Uint8Array.from(
			ChunkedEntry.encode({
				segment: MessageSegment.create({ uri: "https://example.test/segment" }),
			}).finish(),
		),
	);
	const page = `<script id="embedded-data" data-props='{"program":{"nicoliveProgramId":"lv1","vposBaseTime":1700000000},"site":{"relive":{"webSocketUrl":"wss://example.test/watch"}}}'></script>`;
	const errors: unknown[][] = [];
	console.error = (...args: unknown[]) => errors.push(args);
	(
		globalThis as typeof globalThis & { WebSocket: typeof FakeWebSocket }
	).WebSocket = FakeWebSocket as never;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.startsWith("https://live.nicovideo.jp/watch/")) {
			const response = new Response(page, { status: 200 });
			Object.defineProperty(response, "url", {
				value: "https://live.nicovideo.jp/watch/lv1",
			});
			return response;
		}
		if (url.includes("/view?at=now")) {
			if (!init?.signal) throw new Error("view signal is missing");
			return new Response(streamUntilAbort([view], init.signal), {
				status: 200,
			});
		}
		return new Response(streamThatErrorsAfter(new Uint8Array(), segmentError), {
			status: 200,
		});
	};

	try {
		const client = new NiconicoCommentClient();
		const statuses: string[] = [];
		client.onStatusUpdate((status) => statuses.push(status));
		client.connect(source());
		await new Promise((resolve) => setTimeout(resolve, 0));
		const socket = FakeWebSocket.instances[0];
		assert.ok(socket);
		socket.open();
		socket.message(
			JSON.stringify({
				type: "messageServer",
				data: { viewUri: "https://example.test/view" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(statuses.at(-1), "connected");
		assert.ok(
			errors.some((args) =>
				args.some(
					(arg) =>
						typeof arg === "string" &&
						arg.includes("NicoNico comment segment failed"),
				),
			),
		);
		client.disconnect();
	} finally {
		console.error = originalConsoleError;
		globalThis.fetch = originalFetch;
		(
			globalThis as typeof globalThis & { WebSocket: typeof WebSocket }
		).WebSocket = originalWebSocket;
	}
});

test("aborts view and segment streams when NicoNico disconnects", async () => {
	FakeWebSocket.instances = [];
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;
	const view = frame(
		Uint8Array.from(
			ChunkedEntry.encode({
				segment: MessageSegment.create({ uri: "https://example.test/segment" }),
			}).finish(),
		),
	);
	const page = `<script id="embedded-data" data-props='{"program":{"nicoliveProgramId":"lv1","vposBaseTime":1700000000},"site":{"relive":{"webSocketUrl":"wss://example.test/watch"}}}'></script>`;
	let viewSignal: AbortSignal | undefined;
	let segmentSignal: AbortSignal | undefined;
	(
		globalThis as typeof globalThis & { WebSocket: typeof FakeWebSocket }
	).WebSocket = FakeWebSocket as never;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.startsWith("https://live.nicovideo.jp/watch/")) {
			const response = new Response(page, { status: 200 });
			Object.defineProperty(response, "url", {
				value: "https://live.nicovideo.jp/watch/lv1",
			});
			return response;
		}
		if (url.includes("/view?at=now")) {
			if (!init?.signal) throw new Error("view signal is missing");
			viewSignal = init.signal;
			return new Response(streamUntilAbort([view], init.signal), {
				status: 200,
			});
		}
		if (url.includes("/segment")) {
			if (!init?.signal) throw new Error("segment signal is missing");
			segmentSignal = init.signal;
			return new Response(streamUntilAbort([], init.signal), { status: 200 });
		}
		throw new Error(`Unexpected request: ${url}`);
	};

	try {
		const client = new NiconicoCommentClient();
		client.connect(source());
		await new Promise((resolve) => setTimeout(resolve, 0));
		const socket = FakeWebSocket.instances[0];
		assert.ok(socket);
		socket.open();
		socket.message(
			JSON.stringify({
				type: "messageServer",
				data: { viewUri: "https://example.test/view" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(viewSignal);
		assert.ok(segmentSignal);

		socket.message(
			JSON.stringify({
				type: "disconnect",
				data: { reason: "PING_TIMEOUT" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(viewSignal.aborted, true);
		assert.equal(segmentSignal.aborted, true);
		assert.equal(client.getStatus(), "connecting");
		client.disconnect();
	} finally {
		globalThis.fetch = originalFetch;
		(
			globalThis as typeof globalThis & { WebSocket: typeof WebSocket }
		).WebSocket = originalWebSocket;
	}
});

test("reconnects after the view stream fails without an unhandled rejection", async () => {
	FakeWebSocket.instances = [];
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;
	const originalConsoleError = console.error;
	const unhandled: unknown[] = [];
	const viewError = new Error("view stream failed");
	const segmentError = new Error("segment stream failed");
	const view = frame(
		Uint8Array.from(
			ChunkedEntry.encode({
				segment: MessageSegment.create({ uri: "https://example.test/segment" }),
			}).finish(),
		),
	);
	const page = `<script id="embedded-data" data-props='{"program":{"nicoliveProgramId":"lv1","vposBaseTime":1700000000},"site":{"relive":{"webSocketUrl":"wss://example.test/watch"}}}'></script>`;
	const errors: unknown[][] = [];
	const onUnhandledRejection = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandledRejection);
	console.error = (...args: unknown[]) => errors.push(args);
	(
		globalThis as typeof globalThis & { WebSocket: typeof FakeWebSocket }
	).WebSocket = FakeWebSocket as never;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.startsWith("https://live.nicovideo.jp/watch/")) {
			const response = new Response(page, { status: 200 });
			Object.defineProperty(response, "url", {
				value: "https://live.nicovideo.jp/watch/lv1",
			});
			return response;
		}
		if (url.includes("/view?at=now")) {
			return new Response(streamThatErrorsAfter(view, viewError), {
				status: 200,
			});
		}
		return new Response(
			streamThatErrorsAfter(new Uint8Array(), segmentError, 10),
			{ status: 200 },
		);
	};

	try {
		const client = new NiconicoCommentClient();
		const statuses: string[] = [];
		client.onStatusUpdate((status) => statuses.push(status));
		client.connect(source());
		await new Promise((resolve) => setTimeout(resolve, 0));
		const socket = FakeWebSocket.instances[0];
		assert.ok(socket);
		socket.open();
		socket.message(
			JSON.stringify({
				type: "messageServer",
				data: { viewUri: "https://example.test/view" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(unhandled, []);
		assert.equal(statuses.at(-1), "connecting");
		assert.ok(
			errors.some((args) =>
				args.some(
					(arg) =>
						typeof arg === "string" &&
						arg.includes("NicoNico comment session failed; reconnecting"),
				),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 5_100));
		assert.equal(FakeWebSocket.instances.length, 2);
		client.disconnect();
	} finally {
		process.removeListener("unhandledRejection", onUnhandledRejection);
		console.error = originalConsoleError;
		globalThis.fetch = originalFetch;
		(
			globalThis as typeof globalThis & { WebSocket: typeof WebSocket }
		).WebSocket = originalWebSocket;
	}
});
