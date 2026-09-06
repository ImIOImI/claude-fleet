// Unit tests for the pure image-pull helpers: interpreting a `docker pull`
// progress stream for embedded errors, and deciding whether a resumed
// container is running a stale image. No electron, no dockerode, no network —
// these mirror the dependency-free style of ociCore.test.ts so they run in
// isolation.

import { describe, expect, it } from 'vitest';
import { pullErrorFromEvent, needsRecreateForImage, shouldCheckResumeImage } from './imagePull';

describe('pullErrorFromEvent', () => {
  it('returns null for a normal status line', () => {
    expect(pullErrorFromEvent({ status: 'Pulling from imioimi/claude-fleet/runner', id: 'abc' })).toBeNull();
  });

  it('returns null for a progress line with no error', () => {
    expect(
      pullErrorFromEvent({ status: 'Downloading', progressDetail: { current: 1, total: 2 }, id: 'abc' })
    ).toBeNull();
  });

  it('returns the message from a top-level `error` field', () => {
    expect(
      pullErrorFromEvent({ error: 'manifest unknown', errorDetail: { message: 'manifest unknown' } })
    ).toBe('manifest unknown');
  });

  it('falls back to errorDetail.message when `error` is absent', () => {
    expect(pullErrorFromEvent({ errorDetail: { message: 'denied: requested access to the resource is denied' } })).toBe(
      'denied: requested access to the resource is denied'
    );
  });

  it('ignores a non-string error field', () => {
    // Defensive: malformed events must not crash the stream reader.
    expect(pullErrorFromEvent({ error: 42 as unknown as string })).toBeNull();
  });
});

describe('needsRecreateForImage', () => {
  it('recreates when the container image id differs from the local ref id', () => {
    expect(needsRecreateForImage('sha256:aaa', 'sha256:bbb')).toBe(true);
  });

  it('does not recreate when the ids match', () => {
    expect(needsRecreateForImage('sha256:aaa', 'sha256:aaa')).toBe(false);
  });

  it('does not recreate when the local id is unknown (fail safe → plain start)', () => {
    expect(needsRecreateForImage('sha256:aaa', undefined)).toBe(false);
  });

  it('does not recreate when the container id is unknown', () => {
    expect(needsRecreateForImage(undefined, 'sha256:bbb')).toBe(false);
  });
});

describe('shouldCheckResumeImage', () => {
  it('checks a stopped (exited) container workspace', () => {
    expect(shouldCheckResumeImage('container', 'exited')).toBe(true);
  });

  it('checks a created-but-never-started container', () => {
    expect(shouldCheckResumeImage('container', 'created')).toBe(true);
  });

  it('skips a running container (no forced recreate under a live session)', () => {
    expect(shouldCheckResumeImage('container', 'running')).toBe(false);
  });

  it('skips a paused container (suspended expert sessions must not be destroyed)', () => {
    expect(shouldCheckResumeImage('container', 'paused')).toBe(false);
  });

  it('skips local workspaces (no image)', () => {
    expect(shouldCheckResumeImage('local', 'exited')).toBe(false);
  });

  it('skips when the state is unknown', () => {
    expect(shouldCheckResumeImage('container', undefined)).toBe(false);
  });
});
