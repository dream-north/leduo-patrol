import { PlanEntry, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { ToolResultBlockParam, WebSearchToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaBashCodeExecutionToolResultBlockParam, BetaCodeExecutionToolResultBlockParam, BetaRequestMCPToolResultBlockParam, BetaTextEditorCodeExecutionToolResultBlockParam, BetaToolResultBlockParam, BetaToolSearchToolResultBlockParam, BetaWebFetchToolResultBlockParam, BetaWebSearchToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta.mjs";
export declare const ACP_TOOL_NAME_PREFIX = "mcp__acp__";
export declare const acpToolNames: {
    read: string;
    edit: string;
    write: string;
    bash: string;
    killShell: string;
    bashOutput: string;
};
export declare const EDIT_TOOL_NAMES: string[];
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { Logger } from "./acp-agent.js";
import { SettingsManager } from "./settings.js";
interface ToolInfo {
    title: string;
    kind: ToolKind;
    content: ToolCallContent[];
    locations?: ToolCallLocation[];
}
interface ToolUpdate {
    title?: string;
    content?: ToolCallContent[];
    locations?: ToolCallLocation[];
}
export declare function toolInfoFromToolUse(toolUse: any): ToolInfo;
export declare function toolUpdateFromToolResult(toolResult: ToolResultBlockParam | BetaToolResultBlockParam | BetaWebSearchToolResultBlockParam | BetaWebFetchToolResultBlockParam | WebSearchToolResultBlockParam | BetaCodeExecutionToolResultBlockParam | BetaBashCodeExecutionToolResultBlockParam | BetaTextEditorCodeExecutionToolResultBlockParam | BetaRequestMCPToolResultBlockParam | BetaToolSearchToolResultBlockParam, toolUse: any | undefined): ToolUpdate;
export type ClaudePlanEntry = {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
};
export declare function planEntries(input: {
    todos: ClaudePlanEntry[];
}): PlanEntry[];
export declare function markdownEscape(text: string): string;
export declare const registerHookCallback: (toolUseID: string, { onPostToolUseHook, }: {
    onPostToolUseHook?: (toolUseID: string, toolInput: unknown, toolResponse: unknown) => Promise<void>;
}) => void;
export declare const createPostToolUseHook: (logger?: Logger, options?: {
    onEnterPlanMode?: () => Promise<void>;
}) => HookCallback;
/**
 * Creates a PreToolUse hook that checks permissions using the SettingsManager.
 * This runs before the SDK's built-in permission rules, allowing us to enforce
 * our own permission settings for ACP-prefixed tools.
 */
export declare const createPreToolUseHook: (settingsManager: SettingsManager, logger?: Logger) => HookCallback;
export {};
//# sourceMappingURL=tools.d.ts.map