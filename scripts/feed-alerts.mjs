// Open a GitHub issue when a published data feed pauses its automatic updates, and close it on recovery.
//
//   node --experimental-strip-types scripts/feed-alerts.mjs            CI job after the Pages deploy
//   node --experimental-strip-types scripts/feed-alerts.mjs --dry-run  print the planned actions only
//
// Update scripts record an upstream failure in the published snapshot and exit successfully, so the
// site keeps deploying; a run with only a warning annotation notifies nobody. This job reads what
// the site actually serves and keeps one issue per paused feed: created once (mentioning the
// repository owner), left alone while the pause lasts, commented and closed after recovery.
// An unreadable feed changes nothing, so a transient Pages hiccup neither opens nor closes issues.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MARKER = (id) => `<!-- tamatamatori-feed:${id} -->`;
const BOT = 'github-actions[bot]';
export const FEEDS = [
  {
    id: 'stations', path: 'orbits/stations.json', title: '空间站轨道自动更新已暂停', resume: 'resume_orbits', command: 'npm run update:orbits -- --resume',
    doc: 'docs/plan/space-stations.md',
    detail: (data) => (data.objects ?? []).map((entry) => `${entry.OBJECT_NAME ?? entry.NORAD_CAT_ID} 历元 ${entry.EPOCH}`).join('；'),
  },
  {
    id: 'comets', path: 'comets/catalog.json', title: '彗星目录自动更新已暂停', resume: 'resume_comets', command: 'npm run update:comets -- --resume',
    doc: 'docs/plan/comets.md',
    detail: (data) => `${(data.comets ?? []).length} 次回归`,
  },
];

/** Status of one published feed: `paused`, `running`, or `unreadable` (no decision). */
export function feedState(data) {
  if (!data || typeof data !== 'object' || typeof data.blocked !== 'boolean' || !['seed', 'ready', 'error'].includes(data.status)) return { state: 'unreadable' };
  return { state: data.blocked ? 'paused' : 'running', error: data.error ?? null, fetchedAt: data.fetchedAt ?? null, attemptedAt: data.attemptedAt ?? null };
}

export function issueBody(feed, data, { owner, runUrl }) {
  const s = feedState(data);
  return [
    MARKER(feed.id),
    `${owner ? `@${owner} ` : ''}已发布的数据处于暂停状态：自动更新不会再访问上游，直到维护者恢复。站点继续提供暂停前的最后一份有效数据。`,
    '',
    `- 错误：${s.error ?? '（未记录）'}`,
    `- 最近一次尝试：${s.attemptedAt ?? '无'}`,
    `- 最近一次成功：${s.fetchedAt ?? '无'}`,
    `- 当前数据：${feed.detail(data) || '无'}`,
    `- 发现于：${runUrl ?? '本地运行'}`,
    '',
    '恢复步骤：',
    '1. 核对上面的错误：上游服务是否已恢复、返回的数据是否异常。',
    `2. 在 Actions 中手动运行 CI，勾选 \`${feed.resume}\`；或在本地运行 \`${feed.command}\` 后提交推送新的快照。两种方式都遵守冷却时间。`,
    '3. 恢复后，下一次 CI 会在这里留言并自动关闭此 Issue。',
    '',
    `说明见 \`${feed.doc}\`。`,
  ].join('\n');
}

/** Pure decision: which issues to open and which to close for the published feeds. */
export function planAlerts(states, openIssues) {
  const actions = [];
  for (const feed of FEEDS) {
    const { data, state } = states[feed.id] ?? { state: 'unreadable' };
    const mine = openIssues.filter((issue) => !issue.pull_request && issue.user?.login === BOT && String(issue.body ?? '').includes(MARKER(feed.id)));
    if (state === 'paused' && !mine.length) actions.push({ type: 'open', feed, data });
    if (state === 'running') for (const issue of mine) actions.push({ type: 'close', feed, data, issue });
  }
  return actions;
}

function github({ token, repository, fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tamatamatori-feed-alerts' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  return {
    openIssues: () => call('GET', `/issues?state=open&creator=${encodeURIComponent(BOT)}&per_page=100`),
    create: (title, body) => call('POST', '/issues', { title, body }),
    comment: (number, body) => call('POST', `/issues/${number}/comments`, { body }),
    close: (number) => call('PATCH', `/issues/${number}`, { state: 'closed', state_reason: 'completed' }),
  };
}

/** Read each published feed, bypassing the CDN copy; an unreadable feed is reported, never acted on. */
export async function readFeeds(site, { runId = Date.now(), fetchImpl = fetch, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const states = {};
  for (const feed of FEEDS) {
    let data = null;
    for (let attempt = 0; attempt < 3 && !data; attempt++) {
      try {
        const response = await fetchImpl(`${site}${feed.path}?alert=${runId}-${attempt}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (response.ok) data = await response.json();
      } catch {}
      if (!data && attempt < 2) await pause(10000);
    }
    states[feed.id] = { data, ...feedState(data) };
  }
  return states;
}

export async function runAlerts({ site, token, repository, owner, runUrl, runId, dryRun = false, fetchImpl = fetch, pause, log = console.log }) {
  const states = await readFeeds(site, { runId, fetchImpl, pause });
  for (const feed of FEEDS) log(`${feed.id}: ${states[feed.id].state}${states[feed.id].error ? ` · ${states[feed.id].error}` : ''}`);
  const api = github({ token, repository, fetchImpl });
  const open = dryRun && !token ? [] : await api.openIssues();
  const actions = planAlerts(states, open);
  for (const action of actions) {
    if (action.type === 'open') {
      log(`${dryRun ? '[dry-run] ' : ''}开 Issue：${action.feed.title}`);
      if (!dryRun) await api.create(action.feed.title, issueBody(action.feed, action.data, { owner, runUrl }));
    } else {
      log(`${dryRun ? '[dry-run] ' : ''}关闭 Issue #${action.issue.number}：${action.feed.id} 已恢复`);
      if (!dryRun) {
        const s = feedState(action.data);
        await api.comment(action.issue.number, `已恢复：最近一次成功 ${s.fetchedAt ?? '未知'}，当前数据 ${action.feed.detail(action.data) || '无'}。${runUrl ? `（${runUrl}）` : ''}`);
        await api.close(action.issue.number);
      }
    }
  }
  for (const feed of FEEDS) if (states[feed.id].state === 'unreadable') console.warn(`::warning::已发布的 ${feed.path} 暂时无法读取，本次不改变提醒 Issue`);
  return { states, actions };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const repository = process.env.GITHUB_REPOSITORY ?? 'Imanity/Tamatamatori';
  const [owner, name] = repository.split('/');
  const token = process.env.GITHUB_TOKEN;
  if (!dryRun && !token) throw new Error('缺少 GITHUB_TOKEN');
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  await runAlerts({ site: `https://${owner.toLowerCase()}.github.io/${name}/`, token, repository, owner: process.env.GITHUB_REPOSITORY_OWNER ?? owner,
    runUrl, runId: process.env.GITHUB_RUN_ID ?? Date.now(), dryRun });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
