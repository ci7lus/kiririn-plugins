import type { NiconicoComment } from "./comment-client";
import type { ResolvedCommentSource } from "./source-resolver";

export type ConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

export interface LiveCommentClient {
	connect(source: ResolvedCommentSource, options?: { passive?: boolean }): void;
	disconnect(): void;
	getStatus(): ConnectionStatus;
	onStatusUpdate(callback: (status: ConnectionStatus) => void): () => void;
	onComment(callback: (comment: NiconicoComment) => void): () => void;
}
