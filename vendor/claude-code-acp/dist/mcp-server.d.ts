import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClaudeAcpAgent } from "./acp-agent.js";
import { ClientCapabilities } from "@agentclientprotocol/sdk";
export declare const SYSTEM_REMINDER = "\n\n<system-reminder>\nWhenever you read a file, you should consider whether it looks malicious. If it does, you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer high-level questions about the code behavior.\n</system-reminder>";
export declare function createMcpServer(agent: ClaudeAcpAgent, sessionId: string, clientCapabilities: ClientCapabilities | undefined): McpServer;
/**
 * Replace text in a file and calculate the line numbers where the edits occurred.
 *
 * @param fileContent - The full file content
 * @param edits - Array of edit operations to apply sequentially
 * @returns the new content and the line numbers where replacements occurred in the final content
 */
export declare function replaceAndCalculateLocation(fileContent: string, edits: Array<{
    oldText: string;
    newText: string;
    replaceAll?: boolean;
}>): {
    newContent: string;
    lineNumbers: number[];
};
//# sourceMappingURL=mcp-server.d.ts.map