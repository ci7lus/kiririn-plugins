import assert from "node:assert/strict";
import test from "node:test";

import protobuf from "@n-air-app/nicolive-comment-protobuf";
import {
	decodeChat,
	decodeChunkedEntry,
	decodeChunkedMessage,
	decodeNicoliveMessage,
	LengthDelimitedReader,
} from "../src/plugins/nicojk/ndgr-protobuf";

const { dwango } = protobuf;
const { ChunkedEntry, ChunkedMessage, MessageSegment } =
	dwango.nicolive.chat.service.edge;
const { Chat, NicoliveMessage } = dwango.nicolive.chat.data;

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

function varint(value: number | bigint) {
	let remaining = BigInt(value);
	const bytes: number[] = [];
	while (remaining >= 0x80n) {
		bytes.push(Number(remaining & 0x7fn) | 0x80);
		remaining >>= 7n;
	}
	bytes.push(Number(remaining));
	return Uint8Array.from(bytes);
}

function frame(body: Uint8Array) {
	return concat(varint(body.length), body);
}

function bodyFromDelimited(encoded: Uint8Array) {
	let offset = 0;
	while ((encoded[offset] ?? 0) & 0x80) {
		offset += 1;
	}
	return encoded.slice(offset + 1);
}

function appendUnknownWireTypes(body: Uint8Array) {
	return concat(
		body,
		Uint8Array.from([
			0x90, 0x03, 0x01, 0x99, 0x03, 1, 2, 3, 4, 5, 6, 7, 8, 0xa2, 0x03, 1, 0xff,
			0xad, 0x03, 1, 2, 3, 4,
		]),
	);
}

test("emits only complete frames while retaining split length and body bytes", () => {
	const segmentBody = appendUnknownWireTypes(
		bodyFromDelimited(
			Uint8Array.from(
				ChunkedEntry.encodeDelimited({
					segment: MessageSegment.create({
						uri: `https://example.test/segments/${"a".repeat(100)}`,
					}),
				}).finish(),
			),
		),
	);
	const nextBody = bodyFromDelimited(
		Uint8Array.from(
			ChunkedEntry.encodeDelimited({ next: { at: 1_700_000_000 } }).finish(),
		),
	);
	const firstFrame = frame(segmentBody);
	const secondFrame = frame(nextBody);
	const reader = new LengthDelimitedReader({ maxMessageSize: 1024 });

	assert.deepEqual(reader.push(firstFrame.slice(0, 1)), []);
	assert.deepEqual(reader.push(firstFrame.slice(1, 2)), []);
	assert.deepEqual(reader.push(firstFrame.slice(2, firstFrame.length - 1)), []);
	assert.deepEqual(
		reader.push(concat(firstFrame.slice(-1), secondFrame.slice(0, 1))),
		[segmentBody],
	);
	assert.deepEqual(reader.push(secondFrame.slice(1)), [nextBody]);

	assert.deepEqual(decodeChunkedEntry(segmentBody), {
		segment: { uri: `https://example.test/segments/${"a".repeat(100)}` },
	});
	assert.deepEqual(decodeChunkedEntry(nextBody), {
		next: { at: 1_700_000_000 },
	});
});

test("decodes generated chunked message and chat oneofs", () => {
	const chunkedMessageBody = appendUnknownWireTypes(
		bodyFromDelimited(
			Uint8Array.from(
				ChunkedMessage.encodeDelimited({
					message: {
						chat: Chat.fromObject({
							content: "hello",
							vpos: 1234,
							no: 42,
							rawUserId: "9007199254740993",
							hashedUserId: "hashed-user",
							modifier: {
								position: "ue",
								size: "big",
								namedColor: "red",
								font: "gothic",
								opacity: "Translucent",
							},
						}),
					},
				}).finish(),
			),
		),
	);
	const overflowedChatBody = bodyFromDelimited(
		Uint8Array.from(
			NicoliveMessage.encodeDelimited({
				overflowedChat: Chat.fromObject({
					content: "overflow",
					vpos: 2000,
					no: 43,
					modifier: { fullColor: { r: 1, g: 2, b: 3 } },
				}),
			}).finish(),
		),
	);

	assert.deepEqual(decodeChunkedMessage(chunkedMessageBody), {
		message: {
			chat: {
				content: "hello",
				vpos: 1234,
				no: 42,
				rawUserId: "9007199254740993",
				hashedUserId: "hashed-user",
				modifier: {
					position: "ue",
					size: "big",
					namedColor: "red",
					font: "gothic",
					opacity: "Translucent",
				},
			},
		},
	});
	assert.deepEqual(decodeNicoliveMessage(overflowedChatBody), {
		overflowedChat: {
			content: "overflow",
			vpos: 2000,
			no: 43,
			modifier: { fullColor: "#010203" },
		},
	});
});

/*
	The generated encoder is deliberately used above for all schema-bearing
	fixtures. The remaining bytes only make the reader/decoder prove that
	unknown wire types are skipped by the official generated decoder.
*/

test("uses generated defaults for an empty chat", () => {
	assert.deepEqual(decodeChat(new Uint8Array()), {
		content: "",
		vpos: 0,
		no: 0,
	});
});

test("rejects a malformed outer length varint", () => {
	const reader = new LengthDelimitedReader();
	assert.throws(
		() => reader.push(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80)),
		/varint/i,
	);
});

test("rejects a frame length above the configured bound", () => {
	const reader = new LengthDelimitedReader({ maxMessageSize: 3 });
	assert.throws(() => reader.push(varint(4)), /length/i);
});
