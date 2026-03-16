import { Agent, AgentSideConnection, AuthenticateRequest, CancelNotification, ClientCapabilities, ForkSessionRequest, ForkSessionResponse, InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse, ListSessionsRequest, ListSessionsResponse, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse, ResumeSessionRequest, ResumeSessionResponse, SessionNotification, SetSessionModelRequest, SetSessionModelResponse, SetSessionModeRequest, SetSessionModeResponse, TerminalHandle, TerminalOutputResponse, WriteTextFileRequest, WriteTextFileResponse } from "@agentclientprotocol/sdk";
import { SettingsManager } from "./settings.js";
import { CanUseTool, Options, PermissionMode, Query, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Pushable } from "./utils.js";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
export declare const CLAUDE_CONFIG_DIR: string;
/**
 * Logger interface for customizing logging output
 */
export interface Logger {
    log: (...args: any[]) => void;
    error: (...args: any[]) => void;
}
type Session = {
    query: Query;
    input: Pushable<SDKUserMessage>;
    cancelled: boolean;
    permissionMode: PermissionMode;
    settingsManager: SettingsManager;
};
type BackgroundTerminal = {
    handle: TerminalHandle;
    status: "started";
    lastOutput: TerminalOutputResponse | null;
} | {
    status: "aborted" | "exited" | "killed" | "timedOut";
    pendingOutput: TerminalOutputResponse;
};
/**
 * Extra metadata that can be given to Claude Code when creating a new session.
 */
export type NewSessionMeta = {
    claudeCode?: {
        /**
         * Options forwarded to Claude Code when starting a new session.
         * Those parameters will be ignored and managed by ACP:
         *   - cwd
         *   - includePartialMessages
         *   - allowDangerouslySkipPermissions
         *   - permissionMode
         *   - canUseTool
         *   - executable
         * Those parameters will be used and updated to work with ACP:
         *   - hooks (merged with ACP's hooks)
         *   - mcpServers (merged with ACP's mcpServers)
         *   - disallowedTools (merged with ACP's disallowedTools)
         */
        options?: Options;
    };
};
/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
    claudeCode?: {
        toolName: string;
        toolResponse?: unknown;
    };
};
export type ToolUseCache = {
    [key: string]: {
        type: "tool_use" | "server_tool_use" | "mcp_tool_use";
        id: string;
        name: string;
        input: unknown;
    };
};
export declare class ClaudeAcpAgent implements Agent {
    sessions: {
        [key: string]: Session;
    };
    client: AgentSideConnection;
    toolUseCache: ToolUseCache;
    backgroundTerminals: {
        [key: string]: BackgroundTerminal;
    };
    clientCapabilities?: ClientCapabilities;
    logger: Logger;
    constructor(client: AgentSideConnection, logger?: Logger);
    initialize(request: InitializeRequest): Promise<InitializeResponse>;
    newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
    unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse>;
    unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
    /**
     * Find a session file by ID, first checking the given cwd's project directory,
     * then falling back to scanning all project directories.
     * Returns the absolute file path if found, or null if not found.
     */
    private findSessionFile;
    loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
    /**
     * List Claude Code sessions by parsing JSONL files
     * Sessions are stored in ~/.claude/projects/<path-encoded>/
     * Implements the draft session/list RFD spec
     */
    unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;
    authenticate(_params: AuthenticateRequest): Promise<void>;
    prompt(params: PromptRequest): Promise<PromptResponse>;
    cancel(params: CancelNotification): Promise<void>;
    unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse | void>;
    setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;
    private replaySessionHistory;
    readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
    canUseTool(sessionId: string): CanUseTool;
    private sendAvailableCommandsUpdate;
    private createSession;
}
export declare function promptToClaude(prompt: PromptRequest): SDKUserMessage;
/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export declare function toAcpNotifications(content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[], role: "assistant" | "user", sessionId: string, toolUseCache: ToolUseCache, client: AgentSideConnection, logger: Logger, options?: {
    registerHooks?: boolean;
}): SessionNotification[];
export declare function streamEventToAcpNotifications(message: SDKPartialAssistantMessage, sessionId: string, toolUseCache: ToolUseCache, client: AgentSideConnection, logger: Logger): SessionNotification[];
export declare function runAcp(): void;
export {};
//# sourceMappingURL=acp-agent.d.ts.map