import type * as Protobuf from "@n-air-app/nicolive-comment-protobuf";
import protobuf from "@n-air-app/nicolive-comment-protobuf";

const { dwango } = protobuf;

const { ChunkedEntry, ChunkedMessage, MessageSegment } =
	dwango.nicolive.chat.service.edge;
const { Chat, NicoliveMessage } = dwango.nicolive.chat.data;

export interface SegmentDescriptor {
	uri: string;
}

export interface NextView {
	at: number;
}

export interface DecodedModifier {
	position?: string;
	size?: string;
	namedColor?: string;
	fullColor?: string;
	font?: string;
	opacity?: string;
}

export interface DecodedChat {
	content: string;
	vpos: number;
	no: number;
	rawUserId?: string;
	hashedUserId?: string;
	modifier?: DecodedModifier;
}

export interface DecodedChunkedEntry {
	segment?: SegmentDescriptor;
	next?: NextView;
}

export interface DecodedChunkedMessage {
	message?: DecodedNicoliveMessage;
}

export interface DecodedNicoliveMessage {
	chat?: DecodedChat;
	overflowedChat?: DecodedChat;
}

export class NdgrProtobufError extends Error {
	override readonly name = "NdgrProtobufError";
}

export interface LengthDelimitedReaderOptions {
	maxMessageSize?: number;
}

const DEFAULT_MAX_MESSAGE_SIZE = 16 * 1024 * 1024;
const MAX_LENGTH_VARINT_BYTES = 5;

/** Reads NDGR's stream of protobuf messages framed by a varint byte length. */
export class LengthDelimitedReader {
	private pending = new Uint8Array();
	private readonly maxMessageSize: number;

	constructor(options: LengthDelimitedReaderOptions = {}) {
		const maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
		if (!Number.isSafeInteger(maxMessageSize) || maxMessageSize < 0) {
			throw new RangeError(
				"maxMessageSize must be a non-negative safe integer",
			);
		}
		this.maxMessageSize = maxMessageSize;
	}

	hasPendingFrame(): boolean {
		return this.pending.length > 0;
	}

	push(chunk: Uint8Array): Uint8Array[] {
		if (chunk.length > 0) {
			this.pending = concatBytes(this.pending, chunk);
		}

		const frames: Uint8Array[] = [];
		let offset = 0;
		while (offset < this.pending.length) {
			const lengthValue = readLengthVarint(this.pending, offset);
			if (!lengthValue) {
				break;
			}

			if (lengthValue.value > BigInt(this.maxMessageSize)) {
				throw new NdgrProtobufError(
					`Length-delimited frame exceeds ${this.maxMessageSize} bytes`,
				);
			}

			const bodyStart = lengthValue.offset;
			const bodyEnd = bodyStart + Number(lengthValue.value);
			if (bodyEnd > this.pending.length) {
				break;
			}

			frames.push(this.pending.slice(bodyStart, bodyEnd));
			offset = bodyEnd;
		}

		this.pending = this.pending.slice(offset);
		return frames;
	}
}

type GeneratedNicoliveMessage =
	Protobuf.dwango.nicolive.chat.data.NicoliveMessage.$Properties;
type GeneratedChat = Protobuf.dwango.nicolive.chat.data.Chat.$Properties;
type GeneratedModifier =
	Protobuf.dwango.nicolive.chat.data.Chat.Modifier.$Properties;

export function decodeChunkedEntry(bytes: Uint8Array): DecodedChunkedEntry {
	const entry = ChunkedEntry.decode(bytes);
	return {
		...(entry.segment ? { segment: { uri: entry.segment.uri ?? "" } } : {}),
		...(entry.next ? { next: { at: toSafeNumber(entry.next.at) } } : {}),
	};
}

export function decodeMessageSegment(bytes: Uint8Array): SegmentDescriptor {
	const segment = MessageSegment.decode(bytes);
	return { uri: segment.uri };
}

export function decodeReadyForNext(bytes: Uint8Array): NextView {
	const next = ChunkedEntry.ReadyForNext.decode(bytes);
	return { at: toSafeNumber(next.at) };
}

export function decodeChunkedMessage(bytes: Uint8Array): DecodedChunkedMessage {
	const chunkedMessage = ChunkedMessage.decode(bytes);
	return chunkedMessage.message
		? { message: decodeNicoliveMessage(chunkedMessage.message) }
		: {};
}

export function decodeNicoliveMessage(
	bytes: Uint8Array | GeneratedNicoliveMessage,
): DecodedNicoliveMessage {
	const message =
		bytes instanceof Uint8Array ? NicoliveMessage.decode(bytes) : bytes;
	return {
		...(message.chat ? { chat: decodeChat(message.chat) } : {}),
		...(message.overflowedChat
			? { overflowedChat: decodeChat(message.overflowedChat) }
			: {}),
	};
}

export function decodeChat(bytes: Uint8Array | GeneratedChat): DecodedChat {
	const chat = bytes instanceof Uint8Array ? Chat.decode(bytes) : bytes;
	return {
		content: chat.content ?? "",
		vpos: chat.vpos ?? 0,
		no: chat.no ?? 0,
		...(hasOwn(chat, "rawUserId") && chat.rawUserId != null
			? { rawUserId: String(chat.rawUserId) }
			: {}),
		...(hasOwn(chat, "hashedUserId") && chat.hashedUserId != null
			? { hashedUserId: chat.hashedUserId }
			: {}),
		...(chat.modifier ? { modifier: decodeModifier(chat.modifier) } : {}),
	};
}

function decodeModifier(modifier: GeneratedModifier): DecodedModifier {
	return {
		...(hasOwn(modifier, "position") && modifier.position != null
			? { position: enumName(Chat.Modifier.Pos, modifier.position) }
			: {}),
		...(hasOwn(modifier, "size") && modifier.size != null
			? { size: enumName(Chat.Modifier.Size, modifier.size) }
			: {}),
		...(hasOwn(modifier, "namedColor") && modifier.namedColor != null
			? { namedColor: enumName(Chat.Modifier.ColorName, modifier.namedColor) }
			: {}),
		...(modifier.fullColor
			? { fullColor: formatFullColor(modifier.fullColor) }
			: {}),
		...(hasOwn(modifier, "font") && modifier.font != null
			? { font: enumName(Chat.Modifier.Font, modifier.font) }
			: {}),
		...(hasOwn(modifier, "opacity") && modifier.opacity != null
			? { opacity: enumName(Chat.Modifier.Opacity, modifier.opacity) }
			: {}),
	};
}

function readLengthVarint(
	bytes: Uint8Array,
	offset: number,
): { value: bigint; offset: number } | null {
	let value = 0n;
	for (let index = 0; index < MAX_LENGTH_VARINT_BYTES; index += 1) {
		const byte = bytes[offset + index];
		if (byte === undefined) {
			return null;
		}

		value |= BigInt(byte & 0x7f) << BigInt(index * 7);
		if ((byte & 0x80) === 0) {
			return { value, offset: offset + index + 1 };
		}
	}

	throw new NdgrProtobufError("Malformed length varint");
}

function toSafeNumber(
	value: number | { toNumber(): number } | null | undefined,
): number {
	const number =
		value == null ? 0 : typeof value === "number" ? value : value.toNumber();
	if (!Number.isSafeInteger(number)) {
		throw new NdgrProtobufError(
			"Protobuf integer exceeds JavaScript safe range",
		);
	}
	return number;
}

function enumName(values: object, value: number) {
	return Object.entries(values).find(
		([, candidate]) => candidate === value,
	)?.[0];
}

function formatFullColor(color: {
	r?: number | null;
	g?: number | null;
	b?: number | null;
}) {
	return `#${[color.r, color.g, color.b]
		.map((value) => (value ?? 0).toString(16).padStart(2, "0"))
		.join("")}`;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
}

function concatBytes(first: Uint8Array, second: Uint8Array) {
	const result = new Uint8Array(first.length + second.length);
	result.set(first);
	result.set(second, first.length);
	return result;
}
