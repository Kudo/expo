import { Command } from '@expo/commander';
import fs from 'fs-extra';
import path from 'path';

import {
  DEFAULT_GITHUB_SANDBOX_WORKFLOW_FILE,
  DEFAULT_GITHUB_SANDBOX_WORKFLOW_REF,
  createGitHubSandboxSessionAsync,
  destroyGitHubSandboxSessionAsync,
  dispatchGitHubSandboxWorkflowAsync,
  getAuthenticatedUserLoginAsync,
  listGitHubSandboxLogEntriesAsync,
  normalizeGitHubSandboxControlRepo,
  postGitHubSandboxCommandAsync,
  resolveGitHubSandboxPullRequestRefAsync,
  waitForGitHubSandboxCommandResultAsync,
} from '../pr-sandbox/github-actions-session';
import {
  createGitHubSandboxTunnelSession,
  destroyTunnelSessionAsync,
  postTunnelCommandAsync,
  startTunnelServer,
} from '../pr-sandbox/tunnel-session';

type ActionOptions = {
  prUrl?: string;
  repo?: string;
  pullNumber?: string;
  headSha?: string;
  controlRepo?: string;
  controlIssue?: string;
  workflowFile?: string;
  workflowRef?: string;
  idleTimeout?: string;
  sessionId?: string;
  command?: string;
  cwd?: string;
  timeout?: string;
  network?: string;
  image?: string;
  resultTimeout?: string;
  pollInterval?: string;
  publicUrl?: string;
  listenPort?: string;
  listenHost?: string;
  localServerUrl?: string;
  tunnelToken?: string;
  queueOnly?: boolean;
  output?: string;
};

async function writeResultAsync(result: unknown, output?: string) {
  if (output) {
    await fs.outputJson(path.resolve(output), result, { spaces: 2 });
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Provide ${name}.`);
  }
  return value;
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number
): number {
  if (value == null || value === '') {
    return defaultValue;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function action(actionName: string | undefined, options: ActionOptions) {
  if (!actionName) {
    throw new Error(
      'Provide an action: create_session, serve_tunnel, run_command, run_tunnel_command, get_logs, destroy_session, or destroy_tunnel_session.'
    );
  }

  switch (actionName) {
    case 'create_session':
      await writeResultAsync(
        await createGitHubSandboxSessionAsync({
          prUrl: options.prUrl,
          repo: options.repo,
          pullNumber: options.pullNumber,
          headSha: options.headSha,
          controlRepo: options.controlRepo,
          controlIssue: options.controlIssue,
          workflowFile: options.workflowFile,
          workflowRef: options.workflowRef,
          idleTimeoutSeconds: options.idleTimeout,
        }),
        options.output
      );
      return;
    case 'serve_tunnel': {
      const ref = await resolveGitHubSandboxPullRequestRefAsync({
        prUrl: options.prUrl,
        repo: options.repo,
        pullNumber: options.pullNumber,
        headSha: options.headSha,
      });
      const controlRepo = normalizeGitHubSandboxControlRepo(options.controlRepo);
      const workflowFile = options.workflowFile ?? DEFAULT_GITHUB_SANDBOX_WORKFLOW_FILE;
      const workflowRef = options.workflowRef ?? DEFAULT_GITHUB_SANDBOX_WORKFLOW_REF;
      const idleTimeoutSeconds = parsePositiveInteger(options.idleTimeout, '--idle-timeout', 1_800);
      const listenPort = parsePositiveInteger(options.listenPort, '--listen-port', 8_765);
      const listenHost = options.listenHost ?? '127.0.0.1';
      const localServerUrl = options.localServerUrl ?? `http://${listenHost}:${listenPort}`;
      const publicUrl = requireOption(options.publicUrl, '--public-url');
      const controllerLogin = await getAuthenticatedUserLoginAsync();
      const session = createGitHubSandboxTunnelSession({
        ref,
        controlRepo: controlRepo.repo,
        workflowFile,
        workflowRef,
        idleTimeoutSeconds,
        controllerLogin,
        tunnelUrl: publicUrl,
        localServerUrl,
        tunnelToken: options.tunnelToken,
      });
      session.tunnelUrl = joinUrl(publicUrl, `/sessions/${session.sessionId}`);

      const server = startTunnelServer({
        session,
        port: listenPort,
        host: listenHost,
      });
      await server.ready;
      await dispatchGitHubSandboxWorkflowAsync(controlRepo, workflowFile, workflowRef, {
        session_id: session.sessionId,
        repo: ref.repo,
        pull_number: String(ref.pullNumber),
        head_sha: ref.headSha,
        control_issue: '',
        idle_timeout_seconds: String(idleTimeoutSeconds),
        controller_login: controllerLogin,
        transport: 'tunnel',
        tunnel_url: session.tunnelUrl,
        tunnel_token: session.tunnelToken,
      });
      await writeResultAsync(session, options.output);
      console.error(
        `Tunnel controller listening at ${localServerUrl} for session ${session.sessionId}. Keep this process running.`
      );
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await server.closeAsync();
      return;
    }
    case 'run_command': {
      const command = await postGitHubSandboxCommandAsync({
        controlIssue: requireOption(options.controlIssue, '--control-issue'),
        controlRepo: options.controlRepo,
        sessionId: requireOption(options.sessionId, '--session-id'),
        command: requireOption(options.command, '--command'),
        cwd: options.cwd,
        timeout: options.timeout,
        network: options.network,
        image: options.image,
      });
      if (options.queueOnly) {
        await writeResultAsync(command, options.output);
        return;
      }
      await writeResultAsync(
        await waitForGitHubSandboxCommandResultAsync({
          controlIssue: requireOption(options.controlIssue, '--control-issue'),
          controlRepo: options.controlRepo,
          sessionId: command.sessionId,
          commandId: command.commandId,
          resultTimeoutMs: options.resultTimeout
            ? options.resultTimeout
            : String(command.timeout + 600_000),
          pollIntervalMs: options.pollInterval,
        }),
        options.output
      );
      return;
    }
    case 'run_tunnel_command':
      await writeResultAsync(
        await postTunnelCommandAsync({
          localServerUrl: requireOption(options.localServerUrl, '--local-server-url'),
          sessionId: requireOption(options.sessionId, '--session-id'),
          tunnelToken: requireOption(options.tunnelToken, '--tunnel-token'),
          command: requireOption(options.command, '--command'),
          cwd: options.cwd,
          timeout: options.timeout,
          network: options.network,
          image: options.image,
        }),
        options.output
      );
      return;
    case 'get_logs':
      await writeResultAsync(
        await listGitHubSandboxLogEntriesAsync({
          controlIssue: requireOption(options.controlIssue, '--control-issue'),
          controlRepo: options.controlRepo,
          sessionId: requireOption(options.sessionId, '--session-id'),
        }),
        options.output
      );
      return;
    case 'destroy_tunnel_session':
      await writeResultAsync(
        await destroyTunnelSessionAsync({
          localServerUrl: requireOption(options.localServerUrl, '--local-server-url'),
          sessionId: requireOption(options.sessionId, '--session-id'),
          tunnelToken: requireOption(options.tunnelToken, '--tunnel-token'),
        }),
        options.output
      );
      return;
    case 'destroy_session':
      await writeResultAsync(
        await destroyGitHubSandboxSessionAsync({
          controlIssue: requireOption(options.controlIssue, '--control-issue'),
          controlRepo: options.controlRepo,
          sessionId: requireOption(options.sessionId, '--session-id'),
        }),
        options.output
      );
      return;
    default:
      throw new Error(`Unsupported pr-sandbox-gh action "${actionName}".`);
  }
}

export default (program: Command) => {
  program
    .command('pr-sandbox-gh [action]')
    .description('Runs a GitHub Actions backed interactive PR sandbox session.')
    .option('--pr-url <url>', 'Public GitHub pull request URL for create_session.')
    .option('--repo <owner/name>', 'GitHub repository in owner/name format for create_session.')
    .option('--pull-number <number>', 'Pull request number for create_session.')
    .option('--head-sha <sha>', 'Exact PR head commit SHA for create_session.')
    .option(
      '--control-repo <owner/name>',
      'Repository that runs the workflow. Defaults to expo/expo.'
    )
    .option('--control-issue <number>', 'Issue or PR number used by the legacy comment transport.')
    .option('--workflow-file <file>', 'Workflow filename. Defaults to pr-sandbox-session.yml.')
    .option('--workflow-ref <ref>', 'Branch or tag containing the workflow. Defaults to main.')
    .option('--idle-timeout <seconds>', 'Seconds before an idle session exits. Defaults to 1800.')
    .option('--session-id <id>', 'GitHub sandbox session ID.')
    .option('--public-url <url>', 'Public tunnel base URL forwarding to the local tunnel server.')
    .option(
      '--listen-port <number>',
      'Local tunnel server port for serve_tunnel. Defaults to 8765.'
    )
    .option(
      '--listen-host <host>',
      'Local tunnel server host for serve_tunnel. Defaults to 127.0.0.1.'
    )
    .option('--local-server-url <url>', 'Local tunnel server URL.')
    .option('--tunnel-token <token>', 'Tunnel session token. Generated by serve_tunnel if omitted.')
    .option('--command <command>', 'Command to run inside Docker for run_command.')
    .option('--cwd <path>', 'Repo-relative working directory for run_command.')
    .option('--timeout <ms>', 'Docker command timeout in milliseconds. Defaults to 300000.')
    .option(
      '--network <mode>',
      'Docker network mode for run_command: none, bridge, or default. Defaults to none.'
    )
    .option('--image <image>', 'Docker image for run_command. Defaults to node:22-bookworm.')
    .option(
      '--result-timeout <ms>',
      'Maximum time to wait for a legacy comment-transport result. Defaults to command timeout plus 600000.'
    )
    .option('--poll-interval <ms>', 'Result polling interval. Defaults to 5000.')
    .option(
      '--queue-only',
      'Queue legacy comment-transport run_command and return without waiting for the result.',
      false
    )
    .option('--output <path>', 'Optional JSON output path.')
    .asyncAction(action);
};
