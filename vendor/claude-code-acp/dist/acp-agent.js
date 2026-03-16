import { AgentSideConnection, ndJsonStream, RequestError, } from "@agentclientprotocol/sdk";
import { SettingsManager } from "./settings.js";
import { query, } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as os from "node:os";
import { encodeProjectPath, nodeToWebReadable, nodeToWebWritable, Pushable, unreachable, } from "./utils.js";
import { createMcpServer } from "./mcp-server.js";
import { EDIT_TOOL_NAMES, acpToolNames } from "./tools.js";
import { toolInfoFromToolUse, planEntries, toolUpdateFromToolResult, registerHookCallback, createPostToolUseHook, createPreToolUseHook, } from "./tools.js";
import packageJson from "../package.json" with { type: "json" };
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
function sessionFilePath(cwd, sessionId) {
    return path.join(CLAUDE_CONFIG_DIR, "projects", encodeProjectPath(cwd), `${sessionId}.jsonl`);
}
const MAX_TITLE_LENGTH = 128;
function sanitizeTitle(text) {
    // Replace newlines and collapse whitespace
    const sanitized = text
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (sanitized.length <= MAX_TITLE_LENGTH) {
        return sanitized;
    }
    return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}
// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;
// Implement the ACP Agent interface
export class ClaudeAcpAgent {
    constructor(client, logger) {
        this.backgroundTerminals = {};
        this.sessions = {};
        this.client = client;
        this.toolUseCache = {};
        this.logger = logger ?? console;
    }
    async initialize(request) {
        this.clientCapabilities = request.clientCapabilities;
        // Default authMethod
        const authMethod = {
            description: "Run `claude /login` in the terminal",
            name: "Log in with Claude Code",
            id: "claude-login",
        };
        // If client supports terminal-auth capability, use that instead.
        if (request.clientCapabilities?._meta?.["terminal-auth"] === true) {
            const cliPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk/cli.js"));
            authMethod._meta = {
                "terminal-auth": {
                    command: "node",
                    args: [cliPath],
                    label: "Claude Code Login",
                },
            };
        }
        return {
            protocolVersion: 1,
            agentCapabilities: {
                promptCapabilities: {
                    image: true,
                    embeddedContext: true,
                },
                mcpCapabilities: {
                    http: true,
                    sse: true,
                },
                loadSession: true,
                sessionCapabilities: {
                    fork: {},
                    list: {},
                    resume: {},
                },
            },
            agentInfo: {
                name: packageJson.name,
                title: "Claude Code",
                version: packageJson.version,
            },
            authMethods: [authMethod],
        };
    }
    async newSession(params) {
        if (fs.existsSync(path.resolve(os.homedir(), ".claude.json.backup")) &&
            !fs.existsSync(path.resolve(os.homedir(), ".claude.json"))) {
            throw RequestError.authRequired();
        }
        const response = await this.createSession(params, {
            // Revisit these meta values once we support resume
            resume: params._meta?.claudeCode?.options?.resume,
        });
        // Needs to happen after we return the session
        setTimeout(() => {
            this.sendAvailableCommandsUpdate(response.sessionId);
        }, 0);
        return response;
    }
    async unstable_forkSession(params) {
        const response = await this.createSession({
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            _meta: params._meta,
        }, {
            resume: params.sessionId,
            forkSession: true,
        });
        // Needs to happen after we return the session
        setTimeout(() => {
            this.sendAvailableCommandsUpdate(response.sessionId);
        }, 0);
        return response;
    }
    async unstable_resumeSession(params) {
        const response = await this.createSession({
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            _meta: params._meta,
        }, {
            resume: params.sessionId,
        });
        // Needs to happen after we return the session
        setTimeout(() => {
            this.sendAvailableCommandsUpdate(response.sessionId);
        }, 0);
        return response;
    }
    /**
     * Find a session file by ID, first checking the given cwd's project directory,
     * then falling back to scanning all project directories.
     * Returns the absolute file path if found, or null if not found.
     */
    async findSessionFile(sessionId, cwd) {
        const fileName = `${sessionId}.jsonl`;
        // Fast path: check the expected location based on cwd
        const expectedPath = sessionFilePath(cwd, sessionId);
        try {
            await fs.promises.access(expectedPath);
            return expectedPath;
        }
        catch {
            // Not found at expected path, scan all project directories
        }
        const claudeDir = path.join(CLAUDE_CONFIG_DIR, "projects");
        try {
            const projectDirs = await fs.promises.readdir(claudeDir);
            for (const encodedPath of projectDirs) {
                const projectDir = path.join(claudeDir, encodedPath);
                const stat = await fs.promises.stat(projectDir);
                if (!stat.isDirectory())
                    continue;
                const candidatePath = path.join(projectDir, fileName);
                try {
                    await fs.promises.access(candidatePath);
                    return candidatePath;
                }
                catch {
                    continue;
                }
            }
        }
        catch {
            // projects directory doesn't exist or isn't readable
        }
        return null;
    }
    async loadSession(params) {
        const filePath = await this.findSessionFile(params.sessionId, params.cwd);
        if (!filePath) {
            throw new Error("Session not found");
        }
        const response = await this.createSession({
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            _meta: params._meta,
        }, {
            resume: params.sessionId,
        });
        await this.replaySessionHistory(params.sessionId, filePath);
        // Send available commands after replay so it doesn't interleave with history
        setTimeout(() => {
            this.sendAvailableCommandsUpdate(params.sessionId);
        }, 0);
        return {
            modes: response.modes,
            models: response.models,
        };
    }
    /**
     * List Claude Code sessions by parsing JSONL files
     * Sessions are stored in ~/.claude/projects/<path-encoded>/
     * Implements the draft session/list RFD spec
     */
    async unstable_listSessions(params) {
        // Note: We load all sessions into memory for sorting, so pagination here is for
        // API response size limits rather than memory efficiency. This matches the RFD spec.
        const PAGE_SIZE = 50;
        const claudeDir = path.join(CLAUDE_CONFIG_DIR, "projects");
        try {
            await fs.promises.access(claudeDir);
        }
        catch {
            return { sessions: [] };
        }
        // Collect all sessions across all project directories
        const allSessions = [];
        const encodedCwdFilter = params.cwd ? encodeProjectPath(params.cwd) : null;
        try {
            const projectDirs = await fs.promises.readdir(claudeDir);
            for (const encodedPath of projectDirs) {
                const projectDir = path.join(claudeDir, encodedPath);
                const stat = await fs.promises.stat(projectDir);
                if (!stat.isDirectory())
                    continue;
                // Path encoding is not always reversible (hyphens can be separators or literals),
                // so only use encoded value as a coarse pre-filter.
                if (encodedCwdFilter && encodedPath !== encodedCwdFilter)
                    continue;
                const files = await fs.promises.readdir(projectDir);
                // Filter to user session files only. Skip agent-*.jsonl files which contain
                // internal agent metadata and system logs, not user-visible conversation sessions.
                const jsonlFiles = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
                for (const file of jsonlFiles) {
                    const filePath = path.join(projectDir, file);
                    try {
                        const content = await fs.promises.readFile(filePath, "utf-8");
                        const lines = content.trim().split("\n").filter(Boolean);
                        const sessionId = file.replace(".jsonl", "");
                        let parsedAnyEntry = false;
                        let sessionCwd;
                        // Find first user message for title
                        let title;
                        for (const line of lines) {
                            try {
                                const entry = JSON.parse(line);
                                parsedAnyEntry = true;
                                if (entry.isSidechain === true) {
                                    continue;
                                }
                                const entrySessionId = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
                                if (typeof entry.sessionId === "string" && entry.sessionId !== entrySessionId) {
                                    continue;
                                }
                                if (typeof entry.cwd === "string") {
                                    sessionCwd = entry.cwd;
                                }
                                if (!title && entry.type === "user" && entry.message?.content) {
                                    const msgContent = entry.message.content;
                                    if (typeof msgContent === "string") {
                                        title = sanitizeTitle(msgContent);
                                    }
                                    if (Array.isArray(msgContent) && msgContent.length > 0) {
                                        const first = msgContent[0];
                                        const text = typeof first === "string"
                                            ? first
                                            : first && typeof first === "object" && typeof first.text === "string"
                                                ? first.text
                                                : undefined;
                                        if (text) {
                                            title = sanitizeTitle(text);
                                        }
                                    }
                                }
                                // Continue scanning until we have both fields, since cwd can appear
                                // in later entries even after the first user title-bearing message.
                                if (title && sessionCwd) {
                                    break;
                                }
                            }
                            catch {
                                // Skip malformed lines
                            }
                        }
                        if (!parsedAnyEntry)
                            continue;
                        // SessionInfo.cwd is currently required. For entries that do not
                        // include an explicit cwd in the session JSONL (typically metadata-only files),
                        // we skip them instead of decoding folder names because path encoding is lossy.
                        if (!sessionCwd)
                            continue;
                        // Even after encoded-path pre-filtering, verify per-entry cwd to disambiguate
                        // collisions such as "/a-b" and "/a/b" that map to the same encoded folder name.
                        if (params.cwd && sessionCwd !== params.cwd)
                            continue;
                        // Get file modification time as updatedAt
                        const fileStat = await fs.promises.stat(filePath);
                        const updatedAt = fileStat.mtime.toISOString();
                        allSessions.push({
                            sessionId,
                            cwd: sessionCwd,
                            title: title ?? null,
                            updatedAt,
                        });
                    }
                    catch (err) {
                        this.logger.error(`[unstable_listSessions] Failed to parse session file: ${filePath}`, err);
                    }
                }
            }
        }
        catch (err) {
            this.logger.error("[unstable_listSessions] Failed to list sessions", err);
            return { sessions: [] };
        }
        // Sort by updatedAt descending (most recent first)
        allSessions.sort((a, b) => {
            const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return timeB - timeA;
        });
        // Handle pagination with cursor
        let startIndex = 0;
        if (params.cursor) {
            try {
                const decoded = Buffer.from(params.cursor, "base64").toString("utf-8");
                const cursorData = JSON.parse(decoded);
                startIndex = cursorData.offset ?? 0;
            }
            catch {
                // Invalid cursor, start from beginning
            }
        }
        const pageOfSessions = allSessions.slice(startIndex, startIndex + PAGE_SIZE);
        const hasMore = startIndex + PAGE_SIZE < allSessions.length;
        const response = {
            sessions: pageOfSessions,
        };
        if (hasMore) {
            const nextCursor = Buffer.from(JSON.stringify({ offset: startIndex + PAGE_SIZE })).toString("base64");
            response.nextCursor = nextCursor;
        }
        return response;
    }
    async authenticate(_params) {
        throw new Error("Method not implemented.");
    }
    async prompt(params) {
        if (!this.sessions[params.sessionId]) {
            throw new Error("Session not found");
        }
        this.sessions[params.sessionId].cancelled = false;
        const { query, input } = this.sessions[params.sessionId];
        input.push(promptToClaude(params));
        while (true) {
            const { value: message, done } = await query.next();
            if (done || !message) {
                if (this.sessions[params.sessionId].cancelled) {
                    return { stopReason: "cancelled" };
                }
                break;
            }
            switch (message.type) {
                case "system":
                    switch (message.subtype) {
                        case "init":
                            break;
                        case "compact_boundary":
                        case "hook_started":
                        case "task_notification":
                        case "hook_progress":
                        case "hook_response":
                        case "status":
                        case "files_persisted":
                            // Todo: process via status api: https://docs.claude.com/en/docs/claude-code/hooks#hook-output
                            break;
                        default:
                            unreachable(message, this.logger);
                            break;
                    }
                    break;
                case "result": {
                    if (this.sessions[params.sessionId].cancelled) {
                        return { stopReason: "cancelled" };
                    }
                    switch (message.subtype) {
                        case "success": {
                            if (message.result.includes("Please run /login")) {
                                throw RequestError.authRequired();
                            }
                            if (message.is_error) {
                                throw RequestError.internalError(undefined, message.result);
                            }
                            return { stopReason: "end_turn" };
                        }
                        case "error_during_execution":
                            if (message.is_error) {
                                throw RequestError.internalError(undefined, message.errors.join(", ") || message.subtype);
                            }
                            return { stopReason: "end_turn" };
                        case "error_max_budget_usd":
                        case "error_max_turns":
                        case "error_max_structured_output_retries":
                            if (message.is_error) {
                                throw RequestError.internalError(undefined, message.errors.join(", ") || message.subtype);
                            }
                            return { stopReason: "max_turn_requests" };
                        default:
                            unreachable(message, this.logger);
                            break;
                    }
                    break;
                }
                case "stream_event": {
                    for (const notification of streamEventToAcpNotifications(message, params.sessionId, this.toolUseCache, this.client, this.logger)) {
                        await this.client.sessionUpdate(notification);
                    }
                    break;
                }
                case "user":
                case "assistant": {
                    if (this.sessions[params.sessionId].cancelled) {
                        break;
                    }
                    // Slash commands like /compact can generate invalid output... doesn't match
                    // their own docs: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-slash-commands#%2Fcompact-compact-conversation-history
                    if (typeof message.message.content === "string" &&
                        message.message.content.includes("<local-command-stdout>")) {
                        // Handle /context by sending its reply as regular agent message.
                        if (message.message.content.includes("Context Usage")) {
                            for (const notification of toAcpNotifications(message.message.content
                                .replace("<local-command-stdout>", "")
                                .replace("</local-command-stdout>", ""), "assistant", params.sessionId, this.toolUseCache, this.client, this.logger)) {
                                await this.client.sessionUpdate(notification);
                            }
                        }
                        this.logger.log(message.message.content);
                        break;
                    }
                    if (typeof message.message.content === "string" &&
                        message.message.content.includes("<local-command-stderr>")) {
                        this.logger.error(message.message.content);
                        break;
                    }
                    // Skip these user messages for now, since they seem to just be messages we don't want in the feed
                    if (message.type === "user" &&
                        (typeof message.message.content === "string" ||
                            (Array.isArray(message.message.content) &&
                                message.message.content.length === 1 &&
                                message.message.content[0].type === "text"))) {
                        break;
                    }
                    if (message.type === "assistant" &&
                        message.message.model === "<synthetic>" &&
                        Array.isArray(message.message.content) &&
                        message.message.content.length === 1 &&
                        message.message.content[0].type === "text" &&
                        message.message.content[0].text.includes("Please run /login")) {
                        throw RequestError.authRequired();
                    }
                    const content = message.type === "assistant"
                        ? // Handled by stream events above
                            message.message.content.filter((item) => !["text", "thinking"].includes(item.type))
                        : message.message.content;
                    for (const notification of toAcpNotifications(content, message.message.role, params.sessionId, this.toolUseCache, this.client, this.logger)) {
                        await this.client.sessionUpdate(notification);
                    }
                    break;
                }
                case "tool_progress":
                case "tool_use_summary":
                    break;
                case "auth_status":
                    break;
                default:
                    unreachable(message);
                    break;
            }
        }
        throw new Error("Session did not end in result");
    }
    async cancel(params) {
        if (!this.sessions[params.sessionId]) {
            throw new Error("Session not found");
        }
        this.sessions[params.sessionId].cancelled = true;
        await this.sessions[params.sessionId].query.interrupt();
    }
    async unstable_setSessionModel(params) {
        if (!this.sessions[params.sessionId]) {
            throw new Error("Session not found");
        }
        await this.sessions[params.sessionId].query.setModel(params.modelId);
    }
    async setSessionMode(params) {
        if (!this.sessions[params.sessionId]) {
            throw new Error("Session not found");
        }
        switch (params.modeId) {
            case "default":
            case "acceptEdits":
            case "bypassPermissions":
            case "dontAsk":
            case "plan":
                this.sessions[params.sessionId].permissionMode = params.modeId;
                try {
                    await this.sessions[params.sessionId].query.setPermissionMode(params.modeId);
                }
                catch (error) {
                    if (error instanceof Error) {
                        if (!error.message) {
                            error.message = "Invalid Mode";
                        }
                        throw error;
                    }
                    else {
                        // eslint-disable-next-line preserve-caught-error
                        throw new Error("Invalid Mode");
                    }
                }
                return {};
            default:
                throw new Error("Invalid Mode");
        }
    }
    async replaySessionHistory(sessionId, filePath) {
        const toolUseCache = {};
        const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
        const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
        try {
            for await (const line of reader) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                let entry;
                try {
                    entry = JSON.parse(trimmed);
                }
                catch {
                    continue;
                }
                if (entry.type !== "user" && entry.type !== "assistant") {
                    continue;
                }
                if (entry.isSidechain) {
                    continue;
                }
                if (entry.sessionId && entry.sessionId !== sessionId) {
                    continue;
                }
                const message = entry.message;
                if (!message) {
                    continue;
                }
                const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
                if (!role) {
                    continue;
                }
                const content = message.content;
                if (typeof content !== "string" && !Array.isArray(content)) {
                    continue;
                }
                for (const notification of toAcpNotifications(content, role, sessionId, toolUseCache, this.client, this.logger, { registerHooks: false })) {
                    await this.client.sessionUpdate(notification);
                }
            }
        }
        finally {
            reader.close();
        }
    }
    async readTextFile(params) {
        const response = await this.client.readTextFile(params);
        return response;
    }
    async writeTextFile(params) {
        const response = await this.client.writeTextFile(params);
        return response;
    }
    canUseTool(sessionId) {
        return async (toolName, toolInput, { signal, suggestions, toolUseID }) => {
            const session = this.sessions[sessionId];
            if (!session) {
                return {
                    behavior: "deny",
                    message: "Session not found",
                    interrupt: true,
                };
            }
            // ── leduo-patrol patch: intercept native Read/Write/AskUserQuestion ──
            // When the LLM ignores disallowedTools and still calls the native
            // tools (Read, Write, AskUserQuestion), handle them so the user
            // experience is identical to the mcp__acp__-prefixed counterparts.

            // Native Read / Write: simply allow — the native handler executes
            // on the local filesystem (same machine as the ACP agent) and
            // produces the same result as mcp__acp__Read / mcp__acp__Write.
            // The tool_call_update shows "completed" just like the prefixed
            // version; the user sees no difference.
            if (toolName === "Read" && this.clientCapabilities?.fs?.readTextFile) {
                return {
                    behavior: "allow",
                    updatedInput: toolInput,
                };
            }
            if (toolName === "Write" && this.clientCapabilities?.fs?.writeTextFile) {
                return {
                    behavior: "allow",
                    updatedInput: toolInput,
                };
            }

            // Native AskUserQuestion: the native handler uses stdin which
            // doesn't work in ACP, so we must intercept it.  We route it
            // through requestPermission → session-manager converts to the
            // question panel.  We return "deny" with the user's answer so
            // Claude receives it; the session-manager overrides the status
            // to "completed" in the timeline for a seamless display.
            if (toolName === "AskUserQuestion") {
                const response = await this.client.requestPermission({
                    options: [
                        { kind: "allow_once", name: "Answer", optionId: "allow" },
                        { kind: "reject_once", name: "Reject", optionId: "reject" },
                    ],
                    sessionId,
                    toolCall: {
                        toolCallId: toolUseID,
                        rawInput: toolInput,
                        title: "AskUserQuestion",
                    },
                });
                if (signal.aborted || response.outcome?.outcome === "cancelled") {
                    throw new Error("Tool use aborted");
                }
                if (response.outcome?.outcome === "selected" && response.outcome.optionId === "allow") {
                    const answer = response.outcome._meta?.note ?? "";
                    return {
                        behavior: "deny",
                        message: answer || "(no answer provided)",
                    };
                }
                return {
                    behavior: "deny",
                    message: "User declined to answer the question.",
                    interrupt: true,
                };
            }
            // ── end leduo-patrol patch ──

            if (toolName === "ExitPlanMode") {
                const response = await this.client.requestPermission({
                    options: [
                        {
                            kind: "allow_always",
                            name: "Yes, and auto-accept edits",
                            optionId: "acceptEdits",
                        },
                        { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
                        { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
                    ],
                    sessionId,
                    toolCall: {
                        toolCallId: toolUseID,
                        rawInput: toolInput,
                        title: toolInfoFromToolUse({ name: toolName, input: toolInput }).title,
                    },
                });
                if (signal.aborted || response.outcome?.outcome === "cancelled") {
                    throw new Error("Tool use aborted");
                }
                if (response.outcome?.outcome === "selected" &&
                    (response.outcome.optionId === "default" || response.outcome.optionId === "acceptEdits")) {
                    session.permissionMode = response.outcome.optionId;
                    await this.client.sessionUpdate({
                        sessionId,
                        update: {
                            sessionUpdate: "current_mode_update",
                            currentModeId: response.outcome.optionId,
                        },
                    });
                    return {
                        behavior: "allow",
                        updatedInput: toolInput,
                        updatedPermissions: suggestions ?? [
                            { type: "setMode", mode: response.outcome.optionId, destination: "session" },
                        ],
                    };
                }
                else {
                    return {
                        behavior: "deny",
                        message: "User rejected request to exit plan mode.",
                        interrupt: true,
                    };
                }
            }
            if (session.permissionMode === "bypassPermissions" ||
                (session.permissionMode === "acceptEdits" && EDIT_TOOL_NAMES.includes(toolName))) {
                return {
                    behavior: "allow",
                    updatedInput: toolInput,
                    updatedPermissions: suggestions ?? [
                        { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
                    ],
                };
            }
            const response = await this.client.requestPermission({
                options: [
                    {
                        kind: "allow_always",
                        name: "Always Allow",
                        optionId: "allow_always",
                    },
                    { kind: "allow_once", name: "Allow", optionId: "allow" },
                    { kind: "reject_once", name: "Reject", optionId: "reject" },
                ],
                sessionId,
                toolCall: {
                    toolCallId: toolUseID,
                    rawInput: toolInput,
                    title: toolInfoFromToolUse({ name: toolName, input: toolInput }).title,
                },
            });
            if (signal.aborted || response.outcome?.outcome === "cancelled") {
                throw new Error("Tool use aborted");
            }
            if (response.outcome?.outcome === "selected" &&
                (response.outcome.optionId === "allow" || response.outcome.optionId === "allow_always")) {
                // If Claude Code has suggestions, it will update their settings already
                if (response.outcome.optionId === "allow_always") {
                    return {
                        behavior: "allow",
                        updatedInput: toolInput,
                        updatedPermissions: suggestions ?? [
                            {
                                type: "addRules",
                                rules: [{ toolName }],
                                behavior: "allow",
                                destination: "session",
                            },
                        ],
                    };
                }
                return {
                    behavior: "allow",
                    updatedInput: toolInput,
                };
            }
            else {
                return {
                    behavior: "deny",
                    message: "User refused permission to run tool",
                    interrupt: true,
                };
            }
        };
    }
    async sendAvailableCommandsUpdate(sessionId) {
        const session = this.sessions[sessionId];
        if (!session)
            return;
        const commands = await session.query.supportedCommands();
        await this.client.sessionUpdate({
            sessionId,
            update: {
                sessionUpdate: "available_commands_update",
                availableCommands: getAvailableSlashCommands(commands),
            },
        });
    }
    async createSession(params, creationOpts = {}) {
        // We want to create a new session id unless it is resume,
        // but not resume + forkSession.
        let sessionId;
        if (creationOpts.forkSession) {
            sessionId = randomUUID();
        }
        else if (creationOpts.resume) {
            sessionId = creationOpts.resume;
        }
        else {
            sessionId = randomUUID();
        }
        const input = new Pushable();
        const settingsManager = new SettingsManager(params.cwd, {
            logger: this.logger,
        });
        await settingsManager.initialize();
        const mcpServers = {};
        if (Array.isArray(params.mcpServers)) {
            for (const server of params.mcpServers) {
                if ("type" in server) {
                    mcpServers[server.name] = {
                        type: server.type,
                        url: server.url,
                        headers: server.headers
                            ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
                            : undefined,
                    };
                }
                else {
                    mcpServers[server.name] = {
                        type: "stdio",
                        command: server.command,
                        args: server.args,
                        env: server.env
                            ? Object.fromEntries(server.env.map((e) => [e.name, e.value]))
                            : undefined,
                    };
                }
            }
        }
        // Only add the acp MCP server if built-in tools are not disabled
        if (!params._meta?.disableBuiltInTools) {
            const server = createMcpServer(this, sessionId, this.clientCapabilities);
            mcpServers["acp"] = {
                type: "sdk",
                name: "acp",
                instance: server,
            };
        }
        let systemPrompt = { type: "preset", preset: "claude_code" };
        if (params._meta?.systemPrompt) {
            const customPrompt = params._meta.systemPrompt;
            if (typeof customPrompt === "string") {
                systemPrompt = customPrompt;
            }
            else if (typeof customPrompt === "object" &&
                "append" in customPrompt &&
                typeof customPrompt.append === "string") {
                systemPrompt.append = customPrompt.append;
            }
        }
        const permissionMode = "default";
        // Extract options from _meta if provided
        const userProvidedOptions = params._meta?.claudeCode?.options;
        // Configure thinking tokens from environment variable
        const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
            ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
            : undefined;
        const options = {
            systemPrompt,
            settingSources: ["user", "project", "local"],
            stderr: (err) => this.logger.error(err),
            ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
            ...userProvidedOptions,
            // Override certain fields that must be controlled by ACP
            cwd: params.cwd,
            includePartialMessages: true,
            mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers },
            // If we want bypassPermissions to be an option, we have to allow it here.
            // But it doesn't work in root mode, so we only activate it if it will work.
            allowDangerouslySkipPermissions: ALLOW_BYPASS,
            permissionMode,
            canUseTool: this.canUseTool(sessionId),
            // note: although not documented by the types, passing an absolute path
            // here works to find zed's managed node version.
            executable: process.execPath,
            ...(process.env.CLAUDE_CODE_EXECUTABLE && {
                pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
            }),
            tools: { type: "preset", preset: "claude_code" },
            hooks: {
                ...userProvidedOptions?.hooks,
                PreToolUse: [
                    ...(userProvidedOptions?.hooks?.PreToolUse || []),
                    {
                        hooks: [createPreToolUseHook(settingsManager, this.logger)],
                    },
                ],
                PostToolUse: [
                    ...(userProvidedOptions?.hooks?.PostToolUse || []),
                    {
                        hooks: [
                            createPostToolUseHook(this.logger, {
                                onEnterPlanMode: async () => {
                                    const session = this.sessions[sessionId];
                                    if (session) {
                                        session.permissionMode = "plan";
                                    }
                                    await this.client.sessionUpdate({
                                        sessionId,
                                        update: {
                                            sessionUpdate: "current_mode_update",
                                            currentModeId: "plan",
                                        },
                                    });
                                },
                            }),
                        ],
                    },
                ],
            },
            ...creationOpts,
        };
        if (creationOpts?.resume === undefined || creationOpts?.forkSession) {
            // Set our own session id if not resuming an existing session.
            options.sessionId = sessionId;
        }
        const allowedTools = [];
        // Disable this for now, not a great way to expose this over ACP at the moment (in progress work so we can revisit)
        const disallowedTools = ["AskUserQuestion"];
        // Check if built-in tools should be disabled
        const disableBuiltInTools = params._meta?.disableBuiltInTools === true;
        if (!disableBuiltInTools) {
            if (this.clientCapabilities?.fs?.readTextFile) {
                allowedTools.push(acpToolNames.read);
                disallowedTools.push("Read");
            }
            if (this.clientCapabilities?.fs?.writeTextFile) {
                disallowedTools.push("Write", "Edit");
            }
            if (this.clientCapabilities?.terminal) {
                allowedTools.push(acpToolNames.bashOutput, acpToolNames.killShell);
                disallowedTools.push("Bash", "BashOutput", "KillShell");
            }
        }
        else {
            // When built-in tools are disabled, explicitly disallow all of them
            disallowedTools.push(acpToolNames.read, acpToolNames.write, acpToolNames.edit, acpToolNames.bash, acpToolNames.bashOutput, acpToolNames.killShell, "Read", "Write", "Edit", "Bash", "BashOutput", "KillShell", "Glob", "Grep", "Task", "TodoWrite", "ExitPlanMode", "WebSearch", "WebFetch", "AskUserQuestion", "SlashCommand", "Skill", "NotebookEdit");
        }
        if (allowedTools.length > 0) {
            options.allowedTools = allowedTools;
        }
        if (disallowedTools.length > 0) {
            options.disallowedTools = [...(options.disallowedTools || []), ...disallowedTools];
        }
        // Handle abort controller from meta options
        const abortController = userProvidedOptions?.abortController;
        if (abortController?.signal.aborted) {
            throw new Error("Cancelled");
        }
        const q = query({
            prompt: input,
            options,
        });
        this.sessions[sessionId] = {
            query: q,
            input: input,
            cancelled: false,
            permissionMode,
            settingsManager,
        };
        const initializationResult = await q.initializationResult();
        const models = await getAvailableModels(q, initializationResult.models, settingsManager);
        const availableModes = [
            {
                id: "default",
                name: "Default",
                description: "Standard behavior, prompts for dangerous operations",
            },
            {
                id: "acceptEdits",
                name: "Accept Edits",
                description: "Auto-accept file edit operations",
            },
            {
                id: "plan",
                name: "Plan Mode",
                description: "Planning mode, no actual tool execution",
            },
            {
                id: "dontAsk",
                name: "Don't Ask",
                description: "Don't prompt for permissions, deny if not pre-approved",
            },
        ];
        // Only works in non-root mode
        if (ALLOW_BYPASS) {
            availableModes.push({
                id: "bypassPermissions",
                name: "Bypass Permissions",
                description: "Bypass all permission checks",
            });
        }
        return {
            sessionId,
            models,
            modes: {
                currentModeId: permissionMode,
                availableModes,
            },
        };
    }
}
async function getAvailableModels(query, models, settingsManager) {
    const settings = settingsManager.getSettings();
    let currentModel = models[0];
    if (settings.model) {
        const match = models.find((m) => m.value === settings.model ||
            m.value.includes(settings.model) ||
            settings.model.includes(m.value) ||
            m.displayName.toLowerCase() === settings.model.toLowerCase() ||
            m.displayName.toLowerCase().includes(settings.model.toLowerCase()));
        if (match) {
            currentModel = match;
        }
    }
    await query.setModel(currentModel.value);
    return {
        availableModels: models.map((model) => ({
            modelId: model.value,
            name: model.displayName,
            description: model.description,
        })),
        currentModelId: currentModel.value,
    };
}
function getAvailableSlashCommands(commands) {
    const UNSUPPORTED_COMMANDS = [
        "cost",
        "keybindings-help",
        "login",
        "logout",
        "output-style:new",
        "release-notes",
        "todos",
    ];
    return commands
        .map((command) => {
        const input = command.argumentHint
            ? {
                hint: Array.isArray(command.argumentHint)
                    ? command.argumentHint.join(" ")
                    : command.argumentHint,
            }
            : null;
        let name = command.name;
        if (command.name.endsWith(" (MCP)")) {
            name = `mcp:${name.replace(" (MCP)", "")}`;
        }
        return {
            name,
            description: command.description || "",
            input,
        };
    })
        .filter((command) => !UNSUPPORTED_COMMANDS.includes(command.name));
}
function formatUriAsLink(uri) {
    try {
        if (uri.startsWith("file://")) {
            const path = uri.slice(7); // Remove "file://"
            const name = path.split("/").pop() || path;
            return `[@${name}](${uri})`;
        }
        else if (uri.startsWith("zed://")) {
            const parts = uri.split("/");
            const name = parts[parts.length - 1] || uri;
            return `[@${name}](${uri})`;
        }
        return uri;
    }
    catch {
        return uri;
    }
}
export function promptToClaude(prompt) {
    const content = [];
    const context = [];
    for (const chunk of prompt.prompt) {
        switch (chunk.type) {
            case "text": {
                let text = chunk.text;
                // change /mcp:server:command args -> /server:command (MCP) args
                const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(\s+.*)?$/);
                if (mcpMatch) {
                    const [, server, command, args] = mcpMatch;
                    text = `/${server}:${command} (MCP)${args || ""}`;
                }
                content.push({ type: "text", text });
                break;
            }
            case "resource_link": {
                const formattedUri = formatUriAsLink(chunk.uri);
                content.push({
                    type: "text",
                    text: formattedUri,
                });
                break;
            }
            case "resource": {
                if ("text" in chunk.resource) {
                    const formattedUri = formatUriAsLink(chunk.resource.uri);
                    content.push({
                        type: "text",
                        text: formattedUri,
                    });
                    context.push({
                        type: "text",
                        text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
                    });
                }
                // Ignore blob resources (unsupported)
                break;
            }
            case "image":
                if (chunk.data) {
                    content.push({
                        type: "image",
                        source: {
                            type: "base64",
                            data: chunk.data,
                            media_type: chunk.mimeType,
                        },
                    });
                }
                else if (chunk.uri && chunk.uri.startsWith("http")) {
                    content.push({
                        type: "image",
                        source: {
                            type: "url",
                            url: chunk.uri,
                        },
                    });
                }
                break;
            // Ignore audio and other unsupported types
            default:
                break;
        }
    }
    content.push(...context);
    return {
        type: "user",
        message: {
            role: "user",
            content: content,
        },
        session_id: prompt.sessionId,
        parent_tool_use_id: null,
    };
}
/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(content, role, sessionId, toolUseCache, client, logger, options) {
    const registerHooks = options?.registerHooks !== false;
    if (typeof content === "string") {
        return [
            {
                sessionId,
                update: {
                    sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
                    content: {
                        type: "text",
                        text: content,
                    },
                },
            },
        ];
    }
    const output = [];
    // Only handle the first chunk for streaming; extend as needed for batching
    for (const chunk of content) {
        let update = null;
        switch (chunk.type) {
            case "text":
            case "text_delta":
                update = {
                    sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
                    content: {
                        type: "text",
                        text: chunk.text,
                    },
                };
                break;
            case "image":
                update = {
                    sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
                    content: {
                        type: "image",
                        data: chunk.source.type === "base64" ? chunk.source.data : "",
                        mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
                        uri: chunk.source.type === "url" ? chunk.source.url : undefined,
                    },
                };
                break;
            case "thinking":
            case "thinking_delta":
                update = {
                    sessionUpdate: "agent_thought_chunk",
                    content: {
                        type: "text",
                        text: chunk.thinking,
                    },
                };
                break;
            case "tool_use":
            case "server_tool_use":
            case "mcp_tool_use": {
                toolUseCache[chunk.id] = chunk;
                if (chunk.name === "TodoWrite") {
                    // @ts-expect-error - sometimes input is empty object
                    if (Array.isArray(chunk.input.todos)) {
                        update = {
                            sessionUpdate: "plan",
                            entries: planEntries(chunk.input),
                        };
                    }
                }
                else {
                    if (registerHooks) {
                        registerHookCallback(chunk.id, {
                            onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
                                const toolUse = toolUseCache[toolUseId];
                                if (toolUse) {
                                    const update = {
                                        _meta: {
                                            claudeCode: {
                                                toolResponse,
                                                toolName: toolUse.name,
                                            },
                                        },
                                        toolCallId: toolUseId,
                                        sessionUpdate: "tool_call_update",
                                    };
                                    await client.sessionUpdate({
                                        sessionId,
                                        update,
                                    });
                                }
                                else {
                                    logger.error(`[claude-code-acp] Got a tool response for tool use that wasn't tracked: ${toolUseId}`);
                                }
                            },
                        });
                    }
                    let rawInput;
                    try {
                        rawInput = JSON.parse(JSON.stringify(chunk.input));
                    }
                    catch {
                        // ignore if we can't turn it to JSON
                    }
                    update = {
                        _meta: {
                            claudeCode: {
                                toolName: chunk.name,
                            },
                        },
                        toolCallId: chunk.id,
                        sessionUpdate: "tool_call",
                        rawInput,
                        status: "pending",
                        ...toolInfoFromToolUse(chunk),
                    };
                }
                break;
            }
            case "tool_result":
            case "tool_search_tool_result":
            case "web_fetch_tool_result":
            case "web_search_tool_result":
            case "code_execution_tool_result":
            case "bash_code_execution_tool_result":
            case "text_editor_code_execution_tool_result":
            case "mcp_tool_result": {
                const toolUse = toolUseCache[chunk.tool_use_id];
                if (!toolUse) {
                    logger.error(`[claude-code-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`);
                    break;
                }
                if (toolUse.name !== "TodoWrite") {
                    update = {
                        _meta: {
                            claudeCode: {
                                toolName: toolUse.name,
                            },
                        },
                        toolCallId: chunk.tool_use_id,
                        sessionUpdate: "tool_call_update",
                        status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
                        rawOutput: chunk.content,
                        ...toolUpdateFromToolResult(chunk, toolUseCache[chunk.tool_use_id]),
                    };
                }
                break;
            }
            case "document":
            case "search_result":
            case "redacted_thinking":
            case "input_json_delta":
            case "citations_delta":
            case "signature_delta":
            case "container_upload":
            case "compaction":
            case "compaction_delta":
                break;
            default:
                unreachable(chunk, logger);
                break;
        }
        if (update) {
            output.push({ sessionId, update });
        }
    }
    return output;
}
export function streamEventToAcpNotifications(message, sessionId, toolUseCache, client, logger) {
    const event = message.event;
    switch (event.type) {
        case "content_block_start":
            return toAcpNotifications([event.content_block], "assistant", sessionId, toolUseCache, client, logger);
        case "content_block_delta":
            return toAcpNotifications([event.delta], "assistant", sessionId, toolUseCache, client, logger);
        // No content
        case "message_start":
        case "message_delta":
        case "message_stop":
        case "content_block_stop":
            return [];
        default:
            unreachable(event, logger);
            return [];
    }
}
export function runAcp() {
    const input = nodeToWebWritable(process.stdout);
    const output = nodeToWebReadable(process.stdin);
    const stream = ndJsonStream(input, output);
    new AgentSideConnection((client) => new ClaudeAcpAgent(client), stream);
}
