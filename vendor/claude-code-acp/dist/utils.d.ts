import { Readable, Writable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";
import { Logger } from "./acp-agent.js";
import { ClaudeCodeSettings } from "./settings.js";
export declare class Pushable<T> implements AsyncIterable<T> {
    private queue;
    private resolvers;
    private done;
    push(item: T): void;
    end(): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
export declare function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array>;
export declare function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array>;
export declare function unreachable(value: never, logger?: Logger): void;
export declare function sleep(time: number): Promise<void>;
export declare function loadManagedSettings(): ClaudeCodeSettings | null;
export declare function applyEnvironmentSettings(settings: ClaudeCodeSettings): void;
export interface ExtractLinesResult {
    content: string;
    wasLimited: boolean;
    linesRead: number;
}
/**
 * Extracts lines from file content with byte limit enforcement.
 *
 * @param fullContent - The complete file content
 * @param maxContentLength - Maximum number of UTF-16 Code Units to return
 * @returns Object containing extracted content and metadata
 */
export declare function extractLinesWithByteLimit(fullContent: string, maxContentLength: number): ExtractLinesResult;
export declare function encodeProjectPath(cwd: string): string;
//# sourceMappingURL=utils.d.ts.map