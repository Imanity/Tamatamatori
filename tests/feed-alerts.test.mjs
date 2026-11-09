import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FEEDS, feedState, issueBody, planAlerts, runAlerts } from '../scripts/feed-alerts.mjs';

const stationsPaused = { version: 1, status: 'error', blocked: true, error: '上游 HTTP 503，自动更新已暂停，需维护者检查后手动恢复',
  fetchedAt: '2026-11-06T23:29:50.476Z', attemptedAt: '2026-11-07T05:28:14.522Z', objects: [{ OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, EPOCH: '2026-11-06T11:57:30.504672' }] };
const stationsReady = { ...stationsPaused, status: 'ready', blocked: false, error: null, fetchedAt: '2026-11-09T19:28:10Z', attemptedAt: '2026-11-09T19:28:10Z',
  objects: [{ OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, EPOCH: '2026-11-09T04:58:46.240896' }] };
const cometsReady = { version: 2, status: 'ready', blocked: false, error: null, fetchedAt: '2026-11-09T18:25:00Z', attemptedAt: '2026-11-09T18:25:00Z', comets: [{}, {}] };
const cometsPaused = { ...cometsReady, status: 'error', blocked: true, error: 'cobs.si HTTP 500，自动更新已暂停，需维护者检查后手动恢复' };
const bot = { login: 'github-actions[bot]' };
const issue = (number, feed, extra = {}) => ({ number, user: bot, body: `<!-- tamatamatori-feed:${feed} -->\n…`, ...extra });
const states = (stations, comets) => ({ stations: { data: stations, ...feedState(stations) }, comets: { data: comets, ...feedState(comets) } });

test('暂停提醒：暂停且无提醒时开一个，已有则不重复；恢复后关闭；读不到数据时不动；只认机器人带标记的 Issue', () => {
  assert.deepEqual([feedState(stationsPaused).state, feedState(stationsReady).state, feedState(null).state, feedState({ status: 'ready' }).state],
    ['paused', 'running', 'unreadable', 'unreadable']);
  const open = planAlerts(states(stationsPaused, cometsReady), []);
  assert.deepEqual(open.map((a) => [a.type, a.feed.id]), [['open', 'stations']]);
  assert.deepEqual(planAlerts(states(stationsPaused, cometsReady), [issue(7, 'stations')]), []);
  // Recovery closes every open alert of that feed; the other feed's alert stays while it is paused.
  const recovered = planAlerts(states(stationsReady, cometsPaused), [issue(7, 'stations'), issue(9, 'comets')]);
  assert.deepEqual(recovered.map((a) => [a.type, a.feed.id, a.issue?.number]), [['close', 'stations', 7]]);
  // A feed that could not be read neither opens nor closes anything.
  assert.deepEqual(planAlerts(states(null, null), [issue(7, 'stations')]), []);
  // Pull requests and issues by people are not alerts, even with the marker.
  const lookalikes = [issue(3, 'stations', { pull_request: {} }), issue(4, 'stations', { user: { login: 'Imanity' } })];
  assert.deepEqual(planAlerts(states(stationsReady, cometsReady), lookalikes), []);
  assert.deepEqual(planAlerts(states(stationsPaused, cometsReady), lookalikes).map((a) => a.type), ['open']);
  const body = issueBody(FEEDS[0], stationsPaused, { owner: 'Imanity', runUrl: 'https://example.test/run/1' });
  assert.match(body, /^<!-- tamatamatori-feed:stations -->\n@Imanity /);
  assert.match(body, /上游 HTTP 503/);
  assert.match(body, /ISS \(ZARYA\) 历元 2026-11-06T11:57:30\.504672/);
  assert.match(body, /勾选 `resume_orbits`.*npm run update:orbits -- --resume/s);
  assert.match(issueBody(FEEDS[1], cometsPaused, {}), /勾选 `resume_comets`.*2 次回归|2 次回归[\s\S]*resume_comets/);
});

function fakeGitHub(feeds, issues) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body && JSON.parse(options.body), auth: options.headers?.Authorization });
    if (url.startsWith('https://site.test/')) {
      const feed = FEEDS.find((f) => url.startsWith(`https://site.test/${f.path}?alert=`));
      const value = feeds[feed.id];
      return value instanceof Error ? Promise.reject(value) : new Response(JSON.stringify(value), { status: value ? 200 : 404 });
    }
    if (url.includes('/issues?state=open')) return Response.json(issues);
    if (options.method === 'POST' && url.endsWith('/issues')) return Response.json({ number: 12 }, { status: 201 });
    if (options.method === 'POST' && url.includes('/comments')) return Response.json({ id: 1 }, { status: 201 });
    if (options.method === 'PATCH') return Response.json({ state: 'closed' });
    throw new Error(`unexpected ${options.method} ${url}`);
  };
  return { calls, fetchImpl };
}
const run = (fake, extra = {}) => runAlerts({ site: 'https://site.test/', token: 'tok', repository: 'Imanity/Tamatamatori', owner: 'Imanity',
  runUrl: 'https://github.com/Imanity/Tamatamatori/actions/runs/5', runId: 5, fetchImpl: fake.fetchImpl, pause: async () => {}, log: () => {}, ...extra });

test('暂停提醒：读取已发布数据（绕过 CDN 缓存），按计划调用 GitHub 接口；演练模式不写入', async () => {
  const opening = fakeGitHub({ stations: stationsPaused, comets: cometsReady }, []);
  await run(opening);
  const feedCalls = opening.calls.filter((c) => c.url.startsWith('https://site.test/'));
  assert.deepEqual(feedCalls.map((c) => c.url), ['https://site.test/orbits/stations.json?alert=5-0', 'https://site.test/comets/catalog.json?alert=5-0']);
  const api = opening.calls.filter((c) => c.url.startsWith('https://api.github.com/'));
  assert.deepEqual(api.map((c) => [c.method, c.url.replace('https://api.github.com/repos/Imanity/Tamatamatori', '')]),
    [['GET', '/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100'], ['POST', '/issues']]);
  assert.ok(api.every((c) => c.auth === 'Bearer tok'));
  assert.equal(api[1].body.title, '空间站轨道自动更新已暂停');
  assert.match(api[1].body.body, /actions\/runs\/5/);

  const closing = fakeGitHub({ stations: stationsReady, comets: cometsReady }, [issue(7, 'stations')]);
  await run(closing);
  const writes = closing.calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(writes.map((c) => [c.method, c.url.replace('https://api.github.com/repos/Imanity/Tamatamatori', '')]), [['POST', '/issues/7/comments'], ['PATCH', '/issues/7']]);
  assert.match(writes[0].body.body, /已恢复：最近一次成功 2026-11-09T19:28:10Z.*ISS \(ZARYA\) 历元 2026-11-09/);
  assert.deepEqual(writes[1].body, { state: 'closed', state_reason: 'completed' });

  const dry = fakeGitHub({ stations: stationsPaused, comets: cometsPaused }, []);
  const planned = await run(dry, { dryRun: true });
  assert.deepEqual(planned.actions.map((a) => a.feed.id), ['stations', 'comets']);
  assert.ok(dry.calls.every((c) => c.method === 'GET'));

  // Unreachable site: three attempts per feed, then no issue changes.
  const down = fakeGitHub({ stations: new Error('network'), comets: null }, [issue(7, 'stations')]);
  const result = await run(down);
  assert.deepEqual([result.states.stations.state, result.states.comets.state], ['unreadable', 'unreadable']);
  assert.equal(down.calls.filter((c) => c.url.startsWith('https://site.test/orbits')).length, 3);
  assert.ok(down.calls.every((c) => c.method === 'GET'));
});

test('暂停提醒任务：发布之后运行，只有它能写 Issue，其余任务保持只读', async () => {
  // The working copy may use CRLF line endings.
  const workflow = (await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10));
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  const job = workflow.slice(workflow.indexOf('  feed-alerts:'));
  assert.match(job, /needs: deploy/);
  assert.match(job, /permissions:\n      contents: read\n      issues: write/);
  assert.match(job, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(job, /scripts\/feed-alerts\.mjs/);
  assert.equal(workflow.match(/issues: write/g).length, 1);
  const build = workflow.slice(workflow.indexOf('  test-and-build:'), workflow.indexOf('  deploy:'));
  assert.doesNotMatch(build, /issues:|GITHUB_TOKEN/);
});
