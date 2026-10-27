#!/usr/bin/env node
/**
 * 生成个人主页的双主题 GitHub 数据面板 SVG。
 *
 * 数据来源：
 *   - full    : GitHub GraphQL API v4（需要 GITHUB_TOKEN）
 *   - public  : GitHub REST API v3（公开数据，无需 token）
 *   - fixture : 固定样例数据，仅用于本地视觉校验
 *
 * 用法：
 *   node scripts/generate-metrics.mjs
 *   node scripts/generate-metrics.mjs --public-only
 *   node scripts/generate-metrics.mjs --fixture --out .preview
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOGIN = process.env.GITHUB_LOGIN || 'ZCX-Priv';
const TOKEN = process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';
const GRAPHQL = 'https://api.github.com/graphql';
const USER_AGENT = 'ZCX-Priv-profile-metrics';

const FORCE_PUBLIC = process.argv.includes('--public-only');
const FIXTURE = process.argv.includes('--fixture');
const OUT_DIR = path.resolve(process.cwd(), readArg('--out') || 'assets');

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const PALETTES = {
  dark: {
    bg: '#0B0F0C',
    border: '#1E2B22',
    text: '#E6F2EA',
    muted: '#8A9B8F',
    dim: '#4E5E53',
    accent: '#7EE787',
    accent2: '#3FB950',
    gridOpacity: 0.045,
    heat: ['#141B16', '#1F4D31', '#2E7D46', '#4AC26B', '#7EE787'],
    lang: ['#7EE787', '#4AC26B', '#2EA043', '#238636', '#1F6F3A'],
  },
  light: {
    bg: '#F5F8F4',
    border: '#D5E0D7',
    text: '#101B14',
    muted: '#5B6B60',
    dim: '#93A398',
    accent: '#1A7F37',
    accent2: '#2DA44E',
    gridOpacity: 0.05,
    heat: ['#E8EFE9', '#C6E6CE', '#94D3A8', '#4CAF6E', '#1A7F37'],
    lang: ['#1A7F37', '#2DA44E', '#4CAF6E', '#7BC496', '#A8DDB8'],
  },
};

const FONT_STACK = "ui-monospace, 'SFMono-Regular', 'SF Mono', 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace";

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : null;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value >= 10000) {
    const compact = (value / 1000).toFixed(1);
    return `${compact.replace(/\.0$/, '')}k`;
  }
  return String(value);
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function computeStreak(weeks, now = new Date()) {
  const today = isoDate(now);
  const days = weeks
    .flatMap((week) => week.contributionDays || [])
    .filter((day) => day.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (days.length === 0) return 0;

  let index = days.length - 1;
  if (days[index].contributionCount === 0) index -= 1;

  let streak = 0;
  while (index >= 0 && days[index].contributionCount > 0) {
    streak += 1;
    index -= 1;
  }
  return streak;
}

function tallyLanguages(nodes) {
  const counts = new Map();

  for (const node of nodes) {
    const name = node.primaryLanguage?.name;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const languages = sorted.slice(0, 5).map(([name, count]) => ({
    name,
    count,
    pct: total ? (count / total) * 100 : 0,
  }));
  const topCount = languages.reduce((sum, language) => sum + language.count, 0);

  return {
    languages,
    otherPct: total ? ((total - topCount) / total) * 100 : 0,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}

async function fetchFull() {
  const query = `
    query ProfileMetrics($login: String!) {
      user(login: $login) {
        repositories(
          first: 100
          ownerAffiliations: OWNER
          isFork: false
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          totalCount
          nodes {
            name
            stargazerCount
            primaryLanguage { name }
          }
        }
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ query, variables: { login: LOGIN } }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`GraphQL: ${payload.errors.map((error) => error.message).join('; ')}`);
  }

  const user = payload.data?.user;
  if (!user) throw new Error('GraphQL 未返回用户数据');

  const nodes = user.repositories.nodes || [];
  const calendar = user.contributionsCollection?.contributionCalendar;
  const weeks = calendar?.weeks || null;
  const { languages, otherPct } = tallyLanguages(nodes);
  const now = new Date();

  return {
    mode: 'full',
    repos: user.repositories.totalCount,
    stars: nodes.reduce((sum, node) => sum + (node.stargazerCount || 0), 0),
    contributions: calendar?.totalContributions ?? null,
    streak: weeks ? computeStreak(weeks, now) : null,
    languages,
    otherPct,
    weeks,
    updatedAt: now,
  };
}

async function fetchPublic() {
  const allRepos = [];
  let page = 1;

  while (page <= 5) {
    const batch = await fetchJson(
      `${API}/users/${LOGIN}/repos?per_page=100&type=owner&sort=pushed&page=${page}`,
    );
    allRepos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  const ownRepos = allRepos.filter((repo) => !repo.fork);
  const { languages, otherPct } = tallyLanguages(
    ownRepos.map((repo) => ({ primaryLanguage: repo.language ? { name: repo.language } : null })),
  );

  return {
    mode: 'public',
    repos: ownRepos.length,
    stars: ownRepos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0),
    contributions: null,
    streak: null,
    languages,
    otherPct,
    weeks: null,
    updatedAt: new Date(),
  };
}

function createFixture() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 370);

  const weeks = [];
  let total = 0;

  for (let weekIndex = 0; weekIndex < 53; weekIndex += 1) {
    const days = [];

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + weekIndex * 7 + dayIndex);
      if (date > end) break;

      const daysAgo = Math.floor((end - date) / 86400000);
      let count;

      if (daysAgo < 37) {
        count = 1 + ((weekIndex * 3 + dayIndex) % 5);
      } else if (weekIndex >= 8 && weekIndex <= 9) {
        count = 0;
      } else {
        const roll = pseudoRandom(weekIndex * 7 + dayIndex);
        count = roll > 0.45 ? 1 + Math.floor(pseudoRandom(weekIndex * 7 + dayIndex + 31) * 8) : 0;
      }

      total += count;
      days.push({ date: isoDate(date), contributionCount: count });
    }

    if (days.length > 0) weeks.push({ contributionDays: days });
  }

  return {
    mode: 'fixture',
    repos: 21,
    stars: 24,
    contributions: total,
    streak: computeStreak(weeks, end),
    languages: [
      { name: 'TypeScript', count: 8, pct: 38.1 },
      { name: 'Python', count: 5, pct: 23.8 },
      { name: 'JavaScript', count: 3, pct: 14.3 },
      { name: 'C#', count: 3, pct: 14.3 },
      { name: 'C++', count: 2, pct: 9.5 },
    ],
    otherPct: 0,
    weeks,
    updatedAt: now,
  };
}

function heatLevel(count) {
  if (!count) return 0;
  if (count < 4) return 1;
  if (count < 7) return 2;
  if (count < 10) return 3;
  return 4;
}

function renderHeatmap(palette, data) {
  if (!data.weeks) {
    return `
      <rect x="514" y="96" width="322" height="82" rx="4" fill="none" stroke="${palette.border}" stroke-dasharray="4 5"/>
      <text x="675" y="141" text-anchor="middle" font-size="10" letter-spacing="2" fill="${palette.dim}">SYNC PENDING</text>
    `;
  }

  const weeks = data.weeks.slice(-52);
  const cellWidth = 5;
  const cellHeight = 10;
  const gapX = 1.2;
  const gapY = 2;
  const startX = 514 + (52 - weeks.length) * (cellWidth + gapX);
  const startY = 96;
  const cells = [];

  weeks.forEach((week, weekIndex) => {
    (week.contributionDays || []).forEach((day, dayIndex) => {
      const x = startX + weekIndex * (cellWidth + gapX);
      const y = startY + dayIndex * (cellHeight + gapY);
      const fill = palette.heat[heatLevel(day.contributionCount)];
      cells.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellWidth}" height="${cellHeight}" rx="1.2" fill="${fill}"/>`,
      );
    });
  });

  const marks = [0, 13, 26, 39]
    .filter((index) => weeks[index]?.contributionDays?.[0]?.date)
    .map((index) => {
      const date = weeks[index].contributionDays[0].date;
      const month = MONTHS[Number(date.slice(5, 7)) - 1];
      const x = startX + index * (cellWidth + gapX) + cellWidth / 2;
      return `<text x="${x.toFixed(2)}" y="196" text-anchor="middle" font-size="8" letter-spacing="1" fill="${palette.dim}">${month}</text>`;
    });

  return `
    <text x="514" y="78" font-size="10" font-weight="600" letter-spacing="2" fill="${palette.accent}">ACTIVITY · 52W</text>
    ${cells.join('')}
    ${marks.join('')}
  `;
}

function renderMetricsGrid(palette, data) {
  const cells = [
    { x: 32, valueY: 108, labelY: 128, label: 'PUBLIC REPOS', value: formatNumber(data.repos) },
    { x: 272, valueY: 108, labelY: 128, label: 'STARS RECEIVED', value: formatNumber(data.stars) },
    { x: 32, valueY: 182, labelY: 202, label: 'CONTRIBUTIONS · 365D', value: formatNumber(data.contributions) },
    { x: 272, valueY: 182, labelY: 202, label: 'CURRENT STREAK', value: formatNumber(data.streak) },
  ];

  return cells
    .map((cell) => {
      const valueColor = cell.value === '—' ? palette.dim : palette.text;
      return `
        <text x="${cell.x}" y="${cell.valueY}" font-size="38" font-weight="700" fill="${valueColor}">${escapeXml(cell.value)}</text>
        <text x="${cell.x}" y="${cell.labelY}" font-size="9" letter-spacing="1.6" fill="${palette.muted}">${cell.label}</text>
      `;
    })
    .join('');
}

function renderLanguages(palette, data) {
  const items = data.languages.map((language, index) => ({
    ...language,
    color: palette.lang[index] || palette.accent2,
  }));

  if (data.otherPct > 0.5) {
    items.push({ name: 'Other', pct: data.otherPct, color: palette.dim });
  }

  const segments = [];
  let x = 32;
  for (const item of items) {
    const width = (816 * item.pct) / 100;
    if (width <= 0) continue;
    segments.push(
      `<rect x="${x.toFixed(2)}" y="252" width="${Math.max(width - 1.5, 0).toFixed(2)}" height="8" fill="${item.color}"/>`,
    );
    x += width;
  }

  const legend = items
    .map((item, index) => {
      const step = items.length > 0 ? 816 / items.length : 816;
      const itemX = 32 + index * step;
      return `
        <circle cx="${(itemX + 4).toFixed(2)}" cy="280" r="3" fill="${item.color}"/>
        <text x="${(itemX + 14).toFixed(2)}" y="283" font-size="9.5" fill="${palette.muted}">${escapeXml(item.name)} ${formatPercent(item.pct)}</text>
      `;
    })
    .join('');

  return `
    <line x1="32" y1="224" x2="848" y2="224" stroke="${palette.border}" stroke-width="1"/>
    <text x="32" y="242" font-size="9" letter-spacing="1.6" fill="${palette.muted}">PRIMARY LANGUAGES</text>
    <text x="848" y="242" text-anchor="end" font-size="8" letter-spacing="1" fill="${palette.dim}">TOP 5 · BY PRIMARY LANGUAGE</text>
    <rect x="32" y="252" width="816" height="8" rx="3" fill="${palette.border}"/>
    <g clip-path="url(#barClip)">${segments.join('')}</g>
    ${legend}
  `;
}

function renderMetrics(palette, data) {
  const headerRight =
    data.mode === 'full'
      ? 'AUTO-SYNC · 03:17 UTC'
      : data.mode === 'fixture'
        ? 'PREVIEW · FIXTURE'
        : 'SEED · PUBLIC DATA';

  const source =
    data.mode === 'full'
      ? 'source: GitHub GraphQL API · public contributions'
      : data.mode === 'fixture'
        ? 'source: fixture data'
        : 'source: GitHub REST API · seed';

  const updated = `${data.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="880" height="320" viewBox="0 0 880 320" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="metricsTitle metricsDesc">
  <title id="metricsTitle">SOLO-Thinker GitHub metrics</title>
  <desc id="metricsDesc">Repositories, stars, public contributions, current streak, activity heatmap and primary languages for ZCX-Priv.</desc>
  <defs>
    <clipPath id="cardClip">
      <rect x="0.5" y="0.5" width="879" height="319" rx="14" ry="14"/>
    </clipPath>
    <clipPath id="barClip">
      <rect x="32" y="252" width="816" height="8" rx="3"/>
    </clipPath>
    <pattern id="metricsGrid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" stroke="${palette.accent}" stroke-opacity="${palette.gridOpacity}" stroke-width="1"/>
    </pattern>
  </defs>

  <g clip-path="url(#cardClip)">
    <rect x="0.5" y="0.5" width="879" height="319" rx="14" fill="${palette.bg}"/>
    <rect x="0.5" y="0.5" width="879" height="319" rx="14" fill="url(#metricsGrid)"/>
  </g>
  <rect x="0.5" y="0.5" width="879" height="319" rx="14" stroke="${palette.border}" stroke-width="1"/>

  <g font-family="${FONT_STACK}">
    <rect x="32" y="21" width="5" height="5" rx="1" fill="${palette.accent}"/>
    <text x="44" y="30" font-size="12" letter-spacing="0.3" fill="${palette.muted}">
      <tspan>zcx@priv:~$ </tspan><tspan fill="${palette.accent}">./metrics --window 365d</tspan>
    </text>
    <text x="848" y="30" text-anchor="end" font-size="9" letter-spacing="1.5" fill="${palette.dim}">${headerRight}</text>
    <line x1="32" y1="48" x2="848" y2="48" stroke="${palette.border}" stroke-width="1"/>

    ${renderMetricsGrid(palette, data)}

    <line x1="490" y1="64" x2="490" y2="214" stroke="${palette.border}" stroke-width="1"/>

    ${renderHeatmap(palette, data)}
    ${renderLanguages(palette, data)}

    <text x="32" y="306" font-size="9" letter-spacing="0.4" fill="${palette.dim}">${source}</text>
    <text x="848" y="306" text-anchor="end" font-size="9" letter-spacing="0.4" fill="${palette.dim}">updated ${updated}</text>
  </g>
</svg>
`;
}

async function loadData() {
  if (FIXTURE) {
    console.log('模式: fixture（仅预览，非真实数据）');
    return createFixture();
  }

  if (FORCE_PUBLIC) {
    console.log('模式: public（REST 公开数据）');
    return fetchPublic();
  }

  if (!TOKEN) {
    console.warn('::warning::未设置 GITHUB_TOKEN，降级为 REST 公开数据。');
    return fetchPublic();
  }

  try {
    const data = await fetchFull();
    console.log('模式: full（GraphQL 完整数据）');
    return data;
  } catch (error) {
    console.warn(`::warning::GraphQL 数据获取失败，降级为 REST 公开数据。原因: ${error.message}`);
    return fetchPublic();
  }
}

async function main() {
  const data = await loadData();
  await mkdir(OUT_DIR, { recursive: true });

  for (const [theme, palette] of Object.entries(PALETTES)) {
    const target = path.join(OUT_DIR, `metrics-${theme}.svg`);
    await writeFile(target, renderMetrics(palette, data), 'utf8');
    console.log(`已写入 ${target}`);
  }

  console.log(
    `数据: repos=${formatNumber(data.repos)}, stars=${formatNumber(data.stars)}, contributions=${formatNumber(data.contributions)}, streak=${formatNumber(data.streak)}, languages=${data.languages.length}`,
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
