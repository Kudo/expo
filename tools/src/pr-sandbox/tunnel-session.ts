import { randomBytes, randomUUID } from 'crypto';
import http from 'http';

import {
  GitHubSandboxCommand,
  GitHubSandboxCommandResult,
  GitHubSandboxSession,
  createGitHubSandboxSessionId,
  normalizeGitHubSandboxCommandRequest,
} from './github-actions-session';
import type { PullRequestRef } from './types';

type TunnelCommandQueueItem = {
  commandId: string;
  request: GitHubSandboxCommand;
};

export type GitHubSandboxTunnelSession = GitHubSandboxSession & {
  transport: 'tunnel';
  tunnelUrl: string;
  localServerUrl: string;
  tunnelToken: string;
};

export type TunnelServerOptions = {
  session: GitHubSandboxTunnelSession;
  port: number;
  host?: string;
};

export type TunnelServer = {
  closeAsync(): Promise<void>;
  ready: Promise<void>;
};

type PendingResult = {
  resolve: (result: GitHubSandboxCommandResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

function getBearerToken(request: http.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }
  return authorization.slice('Bearer '.length);
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body, null, 2));
}

async function readJsonAsync<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as T;
}

function waitForNextCommandAsync(
  queue: TunnelCommandQueueItem[],
  destroyRequested: () => boolean,
  timeoutMs: number
): Promise<TunnelCommandQueueItem | { type: 'none' } | { type: 'destroy' }> {
  if (destroyRequested()) {
    return Promise.resolve({ type: 'destroy' });
  }
  const next = queue.shift();
  if (next) {
    return Promise.resolve(next);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(destroyRequested() ? { type: 'destroy' } : { type: 'none' });
    }, timeoutMs);
    const interval = setInterval(() => {
      if (destroyRequested()) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve({ type: 'destroy' });
        return;
      }
      const queued = queue.shift();
      if (queued) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(queued);
      }
    }, 250);
  });
}

export function createTunnelToken(): string {
  return randomBytes(32).toString('hex');
}

export function createGitHubSandboxTunnelSession(input: {
  ref: PullRequestRef;
  controlRepo: string;
  workflowFile: string;
  workflowRef: string;
  idleTimeoutSeconds: number;
  controllerLogin: string;
  tunnelUrl: string;
  localServerUrl: string;
  tunnelToken?: string;
}): GitHubSandboxTunnelSession {
  const sessionId = createGitHubSandboxSessionId(input.ref);
  return {
    provider: 'github_actions',
    transport: 'tunnel',
    sessionId,
    repo: input.ref.repo,
    pullNumber: input.ref.pullNumber,
    headSha: input.ref.headSha,
    controlRepo: input.controlRepo,
    controlIssue: 0,
    workflowFile: input.workflowFile,
    workflowRef: input.workflowRef,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    controllerLogin: input.controllerLogin,
    createdAt: new Date().toISOString(),
    tunnelUrl: input.tunnelUrl,
    localServerUrl: input.localServerUrl,
    tunnelToken: input.tunnelToken ?? createTunnelToken(),
  };
}

export function startTunnelServer(options: TunnelServerOptions): TunnelServer {
  const { session } = options;
  const commandQueue: TunnelCommandQueueItem[] = [];
  const pendingResults = new Map<string, PendingResult>();
  let runnerReady = false;
  let runnerStatus: Record<string, unknown> | null = null;
  let destroyRequested = false;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const sessionPrefix = `/sessions/${encodeURIComponent(session.sessionId)}`;
      if (!url.pathname.startsWith(sessionPrefix)) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      if (getBearerToken(request) !== session.tunnelToken) {
        sendJson(response, 401, { error: 'Unauthorized.' });
        return;
      }

      const relativePath = url.pathname.slice(sessionPrefix.length) || '/';
      if (request.method === 'GET' && relativePath === '/status') {
        sendJson(response, 200, {
          sessionId: session.sessionId,
          runnerReady,
          runnerStatus,
          queuedCommands: commandQueue.length,
          pendingResults: pendingResults.size,
          destroyRequested,
        });
        return;
      }

      if (request.method === 'POST' && relativePath === '/runner/hello') {
        runnerReady = true;
        runnerStatus = await readJsonAsync<Record<string, unknown>>(request);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && relativePath === '/runner/idle-timeout') {
        runnerReady = false;
        runnerStatus = await readJsonAsync<Record<string, unknown>>(request);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && relativePath === '/runner/destroyed') {
        runnerReady = false;
        runnerStatus = await readJsonAsync<Record<string, unknown>>(request);
        destroyRequested = true;
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && relativePath === '/commands/next') {
        const timeout = Number(url.searchParams.get('timeout') ?? 25_000);
        const next = await waitForNextCommandAsync(
          commandQueue,
          () => destroyRequested,
          Number.isInteger(timeout) && timeout > 0 ? Math.min(timeout, 30_000) : 25_000
        );
        if ('type' in next) {
          sendJson(response, 200, next);
        } else {
          sendJson(response, 200, {
            type: 'command',
            commandId: next.commandId,
            request: next.request,
          });
        }
        return;
      }

      if (request.method === 'POST' && relativePath.startsWith('/results/')) {
        const commandId = decodeURIComponent(relativePath.slice('/results/'.length));
        const result = await readJsonAsync<GitHubSandboxCommandResult>(request);
        const pending = pendingResults.get(commandId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingResults.delete(commandId);
          pending.resolve(result);
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && relativePath === '/commands') {
        if (!runnerReady) {
          sendJson(response, 409, { error: 'Runner is not connected yet.' });
          return;
        }
        const requestBody = await readJsonAsync<{
          command?: string;
          cwd?: string;
          timeout?: string | number;
          network?: string;
          image?: string;
        }>(request);
        const normalizedRequest = normalizeGitHubSandboxCommandRequest(requestBody);
        const commandId = randomUUID();
        const command: GitHubSandboxCommand = {
          ...normalizedRequest,
          sessionId: session.sessionId,
          commandId,
          createdAt: new Date().toISOString(),
        };
        commandQueue.push({ commandId, request: command });
        const result = await new Promise<GitHubSandboxCommandResult>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingResults.delete(commandId);
            reject(new Error(`Timed out waiting for tunnel result ${commandId}.`));
          }, normalizedRequest.timeout + 600_000);
          pendingResults.set(commandId, { resolve, reject, timeout });
        });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && relativePath === '/destroy') {
        destroyRequested = true;
        sendJson(response, 200, {
          sessionId: session.sessionId,
          destroyed: true,
        });
        return;
      }

      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const ready = new Promise<void>((resolve) => {
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve());
  });

  return {
    ready,
    async closeAsync() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

export async function postTunnelCommandAsync(options: {
  localServerUrl: string;
  sessionId: string;
  tunnelToken: string;
  command?: string;
  cwd?: string;
  timeout?: string | number;
  network?: string;
  image?: string;
}): Promise<GitHubSandboxCommandResult> {
  const url = new URL(
    `/sessions/${encodeURIComponent(options.sessionId)}/commands`,
    options.localServerUrl
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${options.tunnelToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      normalizeGitHubSandboxCommandRequest({
        command: options.command,
        cwd: options.cwd,
        timeout: options.timeout,
        network: options.network,
        image: options.image,
      })
    ),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.error ?? `Tunnel command failed: ${response.status}`);
  }
  return result as GitHubSandboxCommandResult;
}

export async function destroyTunnelSessionAsync(options: {
  localServerUrl: string;
  sessionId: string;
  tunnelToken: string;
}): Promise<{ sessionId: string; destroyed: true }> {
  const url = new URL(
    `/sessions/${encodeURIComponent(options.sessionId)}/destroy`,
    options.localServerUrl
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${options.tunnelToken}`,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.error ?? `Tunnel destroy failed: ${response.status}`);
  }
  return result as { sessionId: string; destroyed: true };
}
