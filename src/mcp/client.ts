/**
 * Minimal Model-Context-Protocol (MCP) client. Implements the JSON-RPC 2.0
 * subset needed to discover tools, list resources, and call them — enough
 * for the gateway to expose MCP servers as upstream tool providers without
 * pulling in the official SDK.
 *
 * Transport: stdio (the most common local MCP setup). The server is spawned
 * as a child process; we speak JSON-RPC over its stdin/stdout.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface MCPServerSpec {
  /** Stable identifier used as a tool name prefix. */
  id: string;
  /** Executable to run (e.g. `npx`, `node`, `/usr/local/bin/mcp-foo`). */
  command: string;
  /** Args passed to the command. */
  args: string[];
  /** Environment variables merged with process.env. */
  env?: Record<string, string>;
  /** Working directory. */
  cwd?: string;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPCallResult {
  content: Array<{ type: 'text' | 'image' | 'resource'; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class MCPClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private toolCache: MCPTool[] | null = null;

  constructor(public readonly spec: MCPServerSpec) {}

  start(): void {
    if (this.proc) return;
    const env = { ...process.env, ...(this.spec.env ?? {}) } as NodeJS.ProcessEnv;
    this.proc = spawn(this.spec.command, this.spec.args, {
      env,
      ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr?.setEncoding('utf8');
    this.proc.on('exit', (code) => this.onExit(code));
    this.proc.on('error', (err) => this.failAll(err));
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    await new Promise<void>((resolve) => {
      if (!p.kill('SIGTERM')) resolve();
      else p.once('exit', () => resolve());
    });
    this.failAll(new Error('mcp: server stopped'));
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async listTools(force = false): Promise<MCPTool[]> {
    if (this.toolCache && !force) return this.toolCache;
    const result = (await this.request('tools/list', {})) as { tools: Array<{ name: string; description?: string; inputSchema: unknown }> };
    this.toolCache = (result.tools ?? []).map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    }));
    return this.toolCache;
  }

  async listResources(): Promise<MCPResource[]> {
    const result = (await this.request('resources/list', {})) as { resources: MCPResource[] };
    return result.resources ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as MCPCallResult;
    return result;
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin) throw new Error('mcp: server not started');
    const id = this.nextId;
    this.nextId += 1;
    const req: JSONRPCRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    const payload = JSON.stringify(req) + '\n';
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(payload);
    return result;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: JSONRPCResponse;
      try { msg = JSON.parse(line) as JSONRPCResponse; } catch { continue; }
      const cb = this.pending.get(msg.id);
      if (!cb) continue;
      this.pending.delete(msg.id);
      if (msg.error) cb.reject(new MCPError(msg.error.code, msg.error.message));
      else cb.resolve(msg.result);
    }
  }

  private onExit(code: number | null): void {
    this.proc = null;
    this.failAll(new Error(`mcp: server exited with code ${code ?? 'null'}`));
  }

  private failAll(err: Error): void {
    for (const [, cb] of this.pending) cb.reject(err);
    this.pending.clear();
  }
}

export class MCPError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`[mcp ${code}] ${message}`);
  }
}

export class MCPManager {
  private readonly clients = new Map<string, MCPClient>();

  register(spec: MCPServerSpec): MCPClient {
    let c = this.clients.get(spec.id);
    if (!c) {
      c = new MCPClient(spec);
      c.start();
      this.clients.set(spec.id, c);
    }
    return c;
  }

  get(id: string): MCPClient | null {
    return this.clients.get(id) ?? null;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((c) => c.stop()));
    this.clients.clear();
  }
}

export function mcpToolId(serverId: string, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

export function newRequestId(): string {
  return randomUUID();
}
