import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGitHubSandboxTunnelSession, createTunnelToken } from './tunnel-session';
import type { PullRequestRef } from './types';

const REF: PullRequestRef = {
  owner: 'expo',
  name: 'expo',
  repo: 'expo/expo',
  pullNumber: 44135,
  headSha: '101071d59a0ccebb9bc5579bfa8977b38cc83ec9',
  prUrl: 'https://github.com/expo/expo/pull/44135',
};

describe('GitHub Actions tunnel session', () => {
  it('should create a session with a generated tunnel token', () => {
    const session = createGitHubSandboxTunnelSession({
      ref: REF,
      controlRepo: 'Kudo/expo',
      workflowFile: 'pr-sandbox-session.yml',
      workflowRef: 'main',
      idleTimeoutSeconds: 1800,
      controllerLogin: 'kudo',
      tunnelUrl: 'https://example.trycloudflare.com/sessions/pending',
      localServerUrl: 'http://127.0.0.1:8765',
    });

    assert.equal(session.transport, 'tunnel');
    assert.equal(session.controlRepo, 'Kudo/expo');
    assert.equal(session.repo, 'expo/expo');
    assert.match(session.sessionId, /^gha-pr-expo-expo-44135-101071d59a0c-/);
    assert.match(session.tunnelToken, /^[a-f0-9]{64}$/);
  });

  it('should create random-looking tunnel tokens', () => {
    const first = createTunnelToken();
    const second = createTunnelToken();

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.match(second, /^[a-f0-9]{64}$/);
    assert.notEqual(first, second);
  });
});
