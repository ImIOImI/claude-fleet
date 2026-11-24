// Split test only: a fake fleet-host credential server (:8081) and GitHub REST API (:8090) serving
// `git archive` tarballs of a real repo built at start. FAKE_FAIL_TAGS: tags whose tarball answers 500.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const TOKEN = `ghs_${'f'.repeat(36)}`;
const repo = '/tmp/fake-loadouts';
const base = '/repos/SumerSports/claude-fleet-loadouts';
const fail = new Set((process.env.FAKE_FAIL_TAGS ?? '').split(',').filter(Boolean));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@example.com', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@example.com' };
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] });
const gitText = (...args) => git(...args).toString('utf8').trim();
const put = (path, text) => {
  mkdirSync(`${repo}/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
  writeFileSync(`${repo}/${path}`, text);
};
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const log = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

mkdirSync(repo, { recursive: true });
git('init', '-q', '-b', 'main');
for (const v of ['1.0.0', '2.0.0']) {
  put('loadouts/demo/loadout.md', `---\ntitle: Demo\ndescription: split test loadout\nversion: ${v}\n---\nDemo.\n`);
  put('loadouts/demo/skills/demo/SKILL.md', `---\nname: demo\ndescription: demo ${v}\n---\nDemo skill ${v}.\n`);
  git('add', '-A');
  git('commit', '-qm', `demo ${v}`);
  git('tag', `demo/v${v}`);
}
const main = gitText('rev-parse', 'main');

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    log({ token_request: JSON.parse(body || '{}') });
    json(res, 200, { token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
}).listen(8081, '0.0.0.0');

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fake').pathname;
  log({ method: req.method, path, auth: Boolean(req.headers.authorization) });
  if (path.startsWith('/codeload/')) {
    if (req.headers.authorization) return json(res, 400, { message: 'Authorization sent to codeload' });
    const commit = path.slice('/codeload/'.length);
    if (!/^[0-9a-f]{40}$/.test(commit)) return json(res, 404, { message: 'Not Found' });
    const tgz = git('archive', '--format=tar.gz', `--prefix=SumerSports-claude-fleet-loadouts-${commit.slice(0, 7)}/`, commit);
    res.writeHead(200, { 'content-type': 'application/x-gzip' });
    return res.end(tgz);
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { message: 'Bad credentials' });
  if (path === base) return json(res, 200, { default_branch: 'main' });
  if (path.startsWith(`${base}/git/ref/tags/`)) {
    const tag = decodeURIComponent(path.slice(`${base}/git/ref/tags/`.length));
    try {
      return json(res, 200, { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: gitText('rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`) } });
    } catch {
      return json(res, 404, { message: 'Not Found' });
    }
  }
  const cmp = new RegExp(`^${base}/compare/([0-9a-f]{40})\\.\\.\\.main$`).exec(path);
  if (cmp) {
    try {
      git('merge-base', '--is-ancestor', cmp[1], 'main');
      return json(res, 200, { status: cmp[1] === main ? 'identical' : 'ahead' });
    } catch {
      return json(res, 200, { status: 'diverged' });
    }
  }
  const tb = new RegExp(`^${base}/tarball/([0-9a-f]{40})$`).exec(path);
  if (tb) {
    if (gitText('tag', '--points-at', tb[1]).split('\n').some((t) => fail.has(t))) return json(res, 500, { message: 'Server Error' });
    return json(res, 302, {}, { location: `http://${req.headers.host}/codeload/${tb[1]}` });
  }
  json(res, 404, { message: 'Not Found' });
}).listen(8090, '0.0.0.0');
log({ ready: true });
