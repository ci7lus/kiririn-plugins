import assert from "node:assert/strict";
import test from "node:test";

import protobuf from "@n-air-app/nicolive-comment-protobuf";
import { NiconicoCommentClient } from "../src/plugins/nicojk/niconico-comment-client";
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

function streamOf(...chunks: Uint8Array[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
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

test("receives anonymous NDGR comments through the shared client boundary", async () => {
	FakeWebSocket.instances = [];
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;
	const segment = frame(
		Uint8Array.from(
			ChunkedMessage.encode({
				message: {
					chat: Chat.fromObject({ content: "hello", no: 7, vpos: 125 }),
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
	const requests: string[] = [];
	(globalThis as typeof globalThis & { WebSocket: typeof FakeWebSocket }).WebSocket =
		FakeWebSocket as never;
	globalThis.fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.startsWith("https://live.nicovideo.jp/watch/")) {
			const response = new Response(page, { status: 200, headers: { "content-type": "text/html" } });
			Object.defineProperty(response, "url", { value: "https://live.nicovideo.jp/watch/lv1" });
			return response;
		}
		if (url.includes("/view?at=now")) {
			return new Response(streamOf(view), { status: 200 });
		}
		return new Response(streamOf(segment), { status: 200 });
	};

	try {
		const client = new NiconicoCommentClient();
		const comments: unknown[] = [];
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
		socket.message({ type: "messageServer", data: { viewUri: "https://example.test/view" } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(requests.includes("https://example.test/view?at=now"));
		assert.deepEqual(comments[0], {
			id: 7,
			no: 7,
			vpos: 170000000125,
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
		(globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
	}
});
