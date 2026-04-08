import { type ToolSet } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';
import type { Message } from '~/types/message';

const logger = createScopedLogger('mcp-service');

export const stdioServerConfigSchema = z
  .object({
    type: z.enum(['stdio']).optional(),
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
  })
  .transform((data) => ({
    ...data,
    type: 'stdio' as const,
  }));
export type STDIOServerConfig = z.infer<typeof stdioServerConfigSchema>;

export const sseServerConfigSchema = z
  .object({
    type: z.enum(['sse']).optional(),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string()).optional(),
  })
  .transform((data) => ({
    ...data,
    type: 'sse' as const,
  }));
export type SSEServerConfig = z.infer<typeof sseServerConfigSchema>;

export const streamableHTTPServerConfigSchema = z
  .object({
    type: z.enum(['streamable-http']).optional(),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string()).optional(),
  })
  .transform((data) => ({
    ...data,
    type: 'streamable-http' as const,
  }));

export type StreamableHTTPServerConfig = z.infer<typeof streamableHTTPServerConfigSchema>;

export const mcpServerConfigSchema = z.union([
  stdioServerConfigSchema,
  sseServerConfigSchema,
  streamableHTTPServerConfigSchema,
]);
export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
});
export type MCPConfig = z.infer<typeof mcpConfigSchema>;

export type MCPClient = {
  tools: () => Promise<ToolSet>;
  close: () => Promise<void>;
} & {
  serverName: string;
};

export type ToolCall = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type MCPServerTools = Record<string, MCPServer>;

export type MCPServerAvailable = {
  status: 'available';
  tools: ToolSet;
  client: MCPClient;
  config: MCPServerConfig;
};
export type MCPServerUnavailable = {
  status: 'unavailable';
  error: string;
  client: MCPClient | null;
  config: MCPServerConfig;
};
export type MCPServer = MCPServerAvailable | MCPServerUnavailable;

/**
 * Stubbed MCP service for ai@6 migration.
 * MCP client APIs (experimental_createMCPClient, Experimental_StdioMCPTransport)
 * were removed in ai@6. This class preserves the singleton pattern and public API
 * but all methods are no-ops returning empty/passthrough results.
 */
export class MCPService {
  private static _instance: MCPService;
  private _tools: ToolSet = {};
  private _toolsWithoutExecute: ToolSet = {};
  private _mcpToolsPerServer: MCPServerTools = {};
  private _toolNamesToServerNames = new Map<string, string>();
  private _config: MCPConfig = {
    mcpServers: {},
  };

  static getInstance(): MCPService {
    if (!MCPService._instance) {
      MCPService._instance = new MCPService();
    }

    return MCPService._instance;
  }

  async updateConfig(config: MCPConfig) {
    logger.debug('MCP is stubbed in ai@6 - config update is a no-op', JSON.stringify(config));
    this._config = config;

    return this._mcpToolsPerServer;
  }

  async checkServersAvailabilities() {
    logger.debug('MCP is stubbed in ai@6 - server availability check is a no-op');
    return this._mcpToolsPerServer;
  }

  isValidToolName(_toolName: string): boolean {
    return false;
  }

  processToolCall(_toolCall: ToolCall, _writer: any): void {
    // no-op in ai@6
  }

  async processToolInvocations(messages: Message[], _writer: any): Promise<Message[]> {
    // passthrough - return messages as-is
    return messages;
  }

  get tools() {
    return this._tools;
  }

  get toolsWithoutExecute() {
    return this._toolsWithoutExecute;
  }
}
