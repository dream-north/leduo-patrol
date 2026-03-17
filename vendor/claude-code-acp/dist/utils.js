// A pushable async iterable: allows you to push items and consume them with for-await.
import { WritableStream, ReadableStream } from "node:stream/web";
import { readFileSync } from "node:fs";
import { getManagedSettingsPath } from "./settings.js";
// Useful for bridging push-based and async-iterator-based code.
export class Pushable {
    constructor() {
        this.queue = [];
        this.resolvers = [];
        this.done = false;
    }
    push(item) {
        if (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve({ value: item, done: false });
        }
        else {
            this.queue.push(item);
        }
    }
    end() {
        this.done = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve({ value: undefined, done: true });
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                if (this.queue.length > 0) {
                    const value = this.queue.shift();
                    return Promise.resolve({ value, done: false });
                }
                if (this.done) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) => {
                    this.resolvers.push(resolve);
                });
            },
        };
    }
}
// Helper to convert Node.js streams to Web Streams
export function nodeToWebWritable(nodeStream) {
    return new WritableStream({
        write(chunk) {
            return new Promise((resolve, reject) => {
                nodeStream.write(Buffer.from(chunk), (err) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            });
        },
    });
}
export function nodeToWebReadable(nodeStream) {
    return new ReadableStream({
        start(controller) {
            nodeStream.on("data", (chunk) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on("end", () => controller.close());
            nodeStream.on("error", (err) => controller.error(err));
        },
    });
}
export function unreachable(value, logger = console) {
    let valueAsString;
    try {
        valueAsString = JSON.stringify(value);
    }
    catch {
        valueAsString = value;
    }
    logger.error(`Unexpected case: ${valueAsString}`);
}
export function sleep(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}
export function loadManagedSettings() {
    try {
        return JSON.parse(readFileSync(getManagedSettingsPath(), "utf8"));
    }
    catch {
        return null;
    }
}
export function applyEnvironmentSettings(settings) {
    if (settings.env) {
        for (const [key, value] of Object.entries(settings.env)) {
            process.env[key] = value;
        }
    }
}
/**
 * Extracts lines from file content with byte limit enforcement.
 *
 * @param fullContent - The complete file content
 * @param maxContentLength - Maximum number of UTF-16 Code Units to return
 * @returns Object containing extracted content and metadata
 */
export function extractLinesWithByteLimit(fullContent, maxContentLength) {
    if (fullContent === "") {
        return {
            content: "",
            wasLimited: false,
            linesRead: 1,
        };
    }
    let linesSeen = 0;
    let index = 0;
    let contentLength = 0;
    let wasLimited = false;
    while (true) {
        const nextIndex = fullContent.indexOf("\n", index);
        if (nextIndex < 0) {
            // Last line in file (no trailing newline)
            if (linesSeen > 0 && fullContent.length > maxContentLength) {
                wasLimited = true;
                break;
            }
            linesSeen += 1;
            contentLength = fullContent.length;
            break;
        }
        else {
            // Line with newline - include up to the newline
            const newContentLength = nextIndex + 1;
            if (linesSeen > 0 && newContentLength > maxContentLength) {
                wasLimited = true;
                break;
            }
            linesSeen += 1;
            contentLength = newContentLength;
            index = newContentLength;
        }
    }
    return {
        content: fullContent.slice(0, contentLength),
        wasLimited,
        linesRead: linesSeen,
    };
}
// Helper to encode a path like Claude does:
// - Unix: "/Users/test" -> "-Users-test"
// - Windows: "C:\Users\test" -> "C--Users-test"
export function encodeProjectPath(cwd) {
    return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
