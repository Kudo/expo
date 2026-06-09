# PR Sandbox Evidence Controller

The maintained in-repo backend is `et pr-sandbox-gh`, which dispatches
`.github/workflows/pr-sandbox-session.yml` and runs PR-controlled commands inside Docker on a
GitHub-hosted runner. The legacy `et pr-sandbox` command can still talk to an externally deployed
Cloudflare Worker, but this repository no longer contains Worker source.

Neither backend sends Codex/OpenAI/GitHub write credentials into PR-controlled execution.

## Legacy Worker Actions

- `create_pr_job`: create a sandbox job pinned to a repo, PR number, and exact head SHA.
- `run_preset`: run one allowlisted preset in that job. Long actions are started as sandbox tasks
  and polled by the CLI instead of holding one HTTP request open.
- `run_command`: run an ad hoc command inside the same sandbox job for interactive investigation.
  Long commands use the same sandbox task polling path.
- `get_logs`: return capped/redacted sandbox logs.
- `read_file`: read a relative path from the checked-out repo.
- `destroy_job`: destroy the sandbox job.
- `collect_evidence`: run the V1 evidence flow and emit JSON with a `context` field for
  `deep-code-review`.

## Legacy Worker Handoff

If you have an externally deployed compatible Worker:

```sh
et pr-sandbox collect_evidence \
  --pr-url https://github.com/owner/repo/pull/123 \
  --worker-url "$PR_SANDBOX_WORKER_URL" \
  --auth-token "$PR_SANDBOX_AUTH_TOKEN" \
  --output /tmp/pr-123-sandbox-evidence.json \
  --destroy-job
```

Feed the generated `context` plus the regular PR metadata/diff into `/deep-code-review <PR_URL>`.
The existing `deep-code-review` skill remains responsible for writing
`code-review-{pull_number}.json` and for its preview/post-pending/submit gates.

## Legacy Worker Interactive Execution

An agent can keep the sandbox job alive and run follow-up commands while reviewing:

```sh
et pr-sandbox create_pr_job \
  --pr-url https://github.com/owner/repo/pull/123 \
  --worker-url "$PR_SANDBOX_WORKER_URL" \
  --auth-token "$PR_SANDBOX_AUTH_TOKEN" \
  --output /tmp/pr-123-job.json

et pr-sandbox run_preset --job-id pr-owner-repo-123-abcdef123456 --preset checkout

et pr-sandbox run_command \
  --job-id pr-owner-repo-123-abcdef123456 \
  --command "pnpm lint" \
  --timeout 300000

et pr-sandbox run_command \
  --job-id pr-owner-repo-123-abcdef123456 \
  --command "node -e \"const pkg=require('./package.json'); console.log(pkg.scripts)\""
```

Commands run inside `/workspace/repo` by default. Use `--cwd packages/foo` to run from a
repo-relative subdirectory. `get_logs` shows a running task marker while long actions are still in
progress, then appends stdout/stderr/exit code after the task completes. Treat all command output as
untrusted PR-controlled data.

## GitHub Actions Session Backend

`et pr-sandbox-gh` is the default backend for repository-managed sandbox execution. It dispatches
`.github/workflows/pr-sandbox-session.yml`, checks out the exact PR head once on a GitHub-hosted
runner, then opens a runner-initiated HTTPS control channel to a local controller exposed by a tunnel
tool such as `cloudflared` or `ngrok`. Each command runs in Docker with the PR checkout mounted at
`/workspace/repo`; the workflow token stays on the runner side and is not passed into Docker.

The tunnel uses a random per-session token. Keep the local controller process running while the
session is active. The workflow still runs in a GitHub repository selected by `--control-repo`, but
commands and results no longer go through GitHub issues.

```sh
export GITHUB_TOKEN=...

# Terminal 1: expose the local controller. Copy the generated https URL.
cloudflared tunnel --url http://127.0.0.1:8765

# Terminal 2: start the local controller and dispatch the workflow.
et pr-sandbox-gh serve_tunnel \
  --pr-url https://github.com/expo/expo/pull/44135 \
  --control-repo Kudo/expo \
  --workflow-ref main \
  --public-url https://example.trycloudflare.com \
  --output /tmp/pr-44135-gh-sandbox-session.json

SESSION_ID="$(
  node -e "console.log(require(process.argv[1]).sessionId)" \
    /tmp/pr-44135-gh-sandbox-session.json
)"
TUNNEL_TOKEN="$(
  node -e "console.log(require(process.argv[1]).tunnelToken)" \
    /tmp/pr-44135-gh-sandbox-session.json
)"

et pr-sandbox-gh run_tunnel_command \
  --session-id "$SESSION_ID" \
  --local-server-url http://127.0.0.1:8765 \
  --tunnel-token "$TUNNEL_TOKEN" \
  --command "git config --global --add safe.directory /workspace/repo && git rev-parse HEAD && node -e \"console.log(require('./package.json').name)\""

et pr-sandbox-gh run_tunnel_command \
  --session-id "$SESSION_ID" \
  --local-server-url http://127.0.0.1:8765 \
  --tunnel-token "$TUNNEL_TOKEN" \
  --command "corepack enable pnpm && pnpm install --ignore-scripts --frozen-lockfile" \
  --network bridge \
  --timeout 1800000

et pr-sandbox-gh run_tunnel_command \
  --session-id "$SESSION_ID" \
  --local-server-url http://127.0.0.1:8765 \
  --tunnel-token "$TUNNEL_TOKEN" \
  --command "pnpm lint" \
  --timeout 1800000

et pr-sandbox-gh destroy_tunnel_session \
  --session-id "$SESSION_ID" \
  --local-server-url http://127.0.0.1:8765 \
  --tunnel-token "$TUNNEL_TOKEN"
```

Commands default to `--network none`. Use `--network bridge` only when the command needs external
network access, such as dependency installation.

To test from a fork, first make sure `.github/workflows/pr-sandbox-session.yml` exists on the fork's
default branch, then run the workflow in that fork:

```sh
et pr-sandbox-gh serve_tunnel \
  --pr-url https://github.com/expo/expo/pull/44135 \
  --control-repo Kudo/expo \
  --workflow-ref main \
  --public-url <public-tunnel-url> \
  --output /tmp/pr-44135-gh-sandbox-session.json
```

The workflow will run in `Kudo/expo`, fetch the target PR from `expo/expo`, and exchange
command/result JSON only with the local tunnel controller.

### Legacy Comment Transport

`create_session`, `run_command`, `get_logs`, and `destroy_session` are retained as a GitHub
issue-comment transport for environments where a local tunnel is unavailable. Prefer the tunnel
transport for normal interactive review because it avoids using a GitHub issue or PR as a command
log.

## Verification

Local verification covers controller validation, preset selection, command allowlisting, context
generation, log redaction/truncation, expotools build, and the full expotools test suite. GitHub
Actions session acceptance requires dispatching `pr-sandbox-session.yml` from a branch that contains
the workflow. Legacy Worker acceptance requires an externally deployed compatible Worker.
