// git-to-paint-engine v1.0.0
// Installed by GitToPaint. Do not edit: saving your drawing replaces this file.

// engine/draw.mjs
import fs from "node:fs/promises";

// src/sync/reconcile.js
var MAX_LEVEL = 4;
var GRAPHQL_LEVELS = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4
};
function levelFromGraphql(value) {
  return GRAPHQL_LEVELS[value] ?? 0;
}
function estimateLevelThresholds(days) {
  const minCountAtLevel = Array(MAX_LEVEL + 1).fill(Infinity);
  const maxCountAtLevel = Array(MAX_LEVEL + 1).fill(0);
  for (const day of days) {
    if (day.level > 0 && day.level <= MAX_LEVEL) {
      minCountAtLevel[day.level] = Math.min(minCountAtLevel[day.level], day.count);
      maxCountAtLevel[day.level] = Math.max(maxCountAtLevel[day.level], day.count);
    }
  }
  const nonZeroCounts = days.map((day) => day.count).filter((count) => count > 0).sort((a, b) => a - b);
  const thresholds = [0];
  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    const observed = minCountAtLevel[level];
    const fallback = Math.max(
      level === 1 ? 1 : quantile(nonZeroCounts, (level - 1) / MAX_LEVEL) + 1,
      maxCountAtLevel[level - 1] + 1
    );
    const estimate = Number.isFinite(observed) ? observed : fallback;
    thresholds.push(Math.max(estimate, thresholds[level - 1] + 1));
  }
  return thresholds;
}
function quantile(sortedValues, ratio) {
  if (!sortedValues.length) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.floor(ratio * sortedValues.length));
  return sortedValues[index];
}
function reconcilePlan({ plan, days, today }) {
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const thresholds = estimateLevelThresholds(days);
  return Object.entries(plan).sort(([left], [right]) => left.localeCompare(right)).map(([date, target]) => {
    if (date > today) {
      return { date, target, status: "scheduled", actualLevel: null, count: null, commitsToAdd: 0 };
    }
    const actual = dayByDate.get(date) ?? { count: 0, level: 0 };
    const base = { date, target, actualLevel: actual.level, count: actual.count };
    if (actual.level === target) {
      return { ...base, status: "ok", commitsToAdd: 0 };
    }
    if (actual.level > target) {
      return { ...base, status: "above", commitsToAdd: 0 };
    }
    return { ...base, status: "pending", commitsToAdd: safeCommitCount(thresholds, target, actual.count) };
  });
}
function safeCommitCount(thresholds, target, count) {
  const needed = thresholds[target] - count;
  const ceiling = target < MAX_LEVEL ? thresholds[target + 1] - 1 - count : Infinity;
  return Math.max(1, Math.min(needed, ceiling));
}
function cautiousStep(results) {
  return results.map(
    (result) => result.status === "pending" ? { ...result, commitsToAdd: Math.max(1, Math.ceil(result.commitsToAdd / 2)) } : result
  );
}
function summarizeResults(results) {
  return results.reduce(
    (summary, result) => ({ ...summary, [result.status]: summary[result.status] + 1 }),
    { scheduled: 0, ok: 0, pending: 0, above: 0 }
  );
}
function allocateCommits(results, budget) {
  const commits = [];
  for (const result of results) {
    if (result.status !== "pending") continue;
    const take = Math.min(result.commitsToAdd, budget - commits.length);
    for (let sequence = 1; sequence <= take; sequence += 1) {
      commits.push({ date: result.date, sequence });
    }
    if (commits.length >= budget) break;
  }
  return commits;
}

// src/github/client.js
var API_ROOT = "https://api.github.com";
var REPO_PAGE_SIZE = 100;
var MAX_REPO_PAGES = 10;
var IS_BROWSER = typeof window !== "undefined";
var GitHubError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
};
var CONTRIBUTIONS_QUERY = `
  query ContributionDays($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks {
            contributionDays { date contributionCount contributionLevel }
          }
        }
      }
    }
  }
`;
var CONFIG_SEARCH_QUERY = `
  query ArtConfigRepos($expression: String!) {
    viewer {
      repositories(first: 100, ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, direction: DESC }) {
        nodes {
          name
          isFork
          isArchived
          owner { login }
          config: object(expression: $expression) { ... on Blob { text } }
        }
      }
    }
  }
`;
function toRepoSummary(repo) {
  return {
    owner: repo.owner.login,
    repo: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    fork: repo.fork,
    archived: repo.archived,
    defaultBranch: repo.default_branch,
    canPush: Boolean(repo.permissions?.push),
    htmlUrl: repo.html_url
  };
}
function base64ToUtf8(value) {
  const binary = atob(value.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
function createGitHubClient({ fetchImpl = (...args) => fetch(...args) } = {}) {
  async function request(token, pathname, { method = "GET", body, operation, allow404 = false }) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...token ? { Authorization: `Bearer ${token}` } : {},
      ...body ? { "Content-Type": "application/json" } : {},
      // Browsers set their own User-Agent; the API requires one from Node.
      ...IS_BROWSER ? {} : { "User-Agent": "GitToPaint" }
    };
    const response = await fetchImpl(`${API_ROOT}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : void 0
    });
    if (allow404 && response.status === 404) return { data: null, headers: response.headers };
    if (!response.ok) {
      throw new GitHubError(await describeFailure(response, operation), response.status);
    }
    return { data: response.status === 204 ? null : await response.json(), headers: response.headers };
  }
  async function graphql(token, query, variables, operation) {
    const { data } = await request(token, "/graphql", { method: "POST", operation, body: { query, variables } });
    if (data?.errors?.length) {
      throw new GitHubError(`GitHub could not ${operation}: ${String(data.errors[0]?.message).slice(0, 160)}`, 502);
    }
    return data.data;
  }
  return {
    async getViewer(token) {
      const { data, headers } = await request(token, "/user", { operation: "load your profile" });
      return {
        id: data.id,
        login: data.login,
        name: data.name || data.login,
        avatarUrl: data.avatar_url,
        scopes: headers.get("x-oauth-scopes")
      };
    },
    async getContributionDays(token, login, { from, to }) {
      const result = await graphql(
        token,
        CONTRIBUTIONS_QUERY,
        { login, from: from.toISOString(), to: to.toISOString() },
        "load the contribution calendar"
      );
      const weeks = result?.user?.contributionsCollection?.contributionCalendar?.weeks;
      if (!weeks) {
        throw new GitHubError(`GitHub returned no contribution calendar for ${login}.`, 502);
      }
      return weeks.flatMap(
        (week) => week.contributionDays.map((day) => ({
          date: day.date,
          count: day.contributionCount,
          level: levelFromGraphql(day.contributionLevel)
        }))
      );
    },
    /** Owned, non-fork repositories that contain `path` on their default branch, most recently pushed first. */
    async findReposWithFile(token, path) {
      const result = await graphql(token, CONFIG_SEARCH_QUERY, { expression: `HEAD:${path}` }, "search your repositories");
      return (result?.viewer?.repositories?.nodes ?? []).filter((node) => node.config?.text && !node.isFork && !node.isArchived).map((node) => ({ owner: node.owner.login, repo: node.name, text: node.config.text }));
    },
    async getRepo(token, owner, repo) {
      const { data } = await request(token, `/repos/${owner}/${repo}`, { operation: "read the repository", allow404: true });
      return data ? toRepoSummary(data) : null;
    },
    async listOwnedRepos(token) {
      const repos = [];
      for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
        const { data } = await request(
          token,
          `/user/repos?affiliation=owner&sort=pushed&per_page=${REPO_PAGE_SIZE}&page=${page}`,
          { operation: "list your repositories" }
        );
        repos.push(...data);
        if (data.length < REPO_PAGE_SIZE) break;
      }
      return repos.map(toRepoSummary).filter((repo) => repo.canPush && !repo.fork && !repo.archived);
    },
    async createRepo(token, { name, description }) {
      const { data } = await request(token, "/user/repos", {
        method: "POST",
        operation: `create the ${name} repository`,
        body: { name, description, private: false, auto_init: true, has_issues: false, has_wiki: false, has_projects: false }
      });
      return toRepoSummary(data);
    },
    async getFileText(token, owner, repo, path) {
      const { data } = await request(token, `/repos/${owner}/${repo}/contents/${path}`, {
        operation: `read ${path}`,
        allow404: true
      });
      if (!data) return null;
      if (Array.isArray(data) || data.type !== "file") {
        throw new GitHubError(`${path} in ${owner}/${repo} is not a file.`, 409);
      }
      return { text: base64ToUtf8(data.content), sha: data.sha };
    },
    async getBranchSha(token, owner, repo, branch) {
      try {
        const { data } = await request(token, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {
          operation: "read the default branch"
        });
        return data.object.sha;
      } catch (error) {
        if (error.status === 404 || error.status === 409) {
          throw new GitHubError(`${owner}/${repo} has no "${branch}" branch yet. Push an initial commit first.`, error.status);
        }
        throw error;
      }
    },
    async getCommitTree(token, owner, repo, sha) {
      const { data } = await request(token, `/repos/${owner}/${repo}/git/commits/${sha}`, { operation: "read the latest commit" });
      return data.tree.sha;
    },
    async listTreePaths(token, owner, repo, treeSha) {
      const { data } = await request(token, `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, {
        operation: "list the repository files"
      });
      return data.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
    },
    /** entries: [{ path, content }] to add or replace a file, [{ path, remove: true }] to delete one. */
    async createTree(token, owner, repo, { baseTree, entries }) {
      const tree = entries.map(
        (entry) => entry.remove ? { path: entry.path, mode: "100644", type: "blob", sha: null } : { path: entry.path, mode: "100644", type: "blob", content: entry.content }
      );
      const { data } = await request(token, `/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        operation: "write files to the repository",
        body: { base_tree: baseTree, tree }
      });
      return data.sha;
    },
    async createCommit(token, owner, repo, commit) {
      const { data } = await request(token, `/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        operation: "create a commit",
        body: commit
      });
      return data.sha;
    },
    async updateBranch(token, owner, repo, branch, sha) {
      await request(token, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        operation: "move the branch to the new commit",
        body: { sha, force: false }
      });
    },
    async getRepoPublicKey(token, owner, repo) {
      const { data } = await request(token, `/repos/${owner}/${repo}/actions/secrets/public-key`, {
        operation: "read the repository encryption key"
      });
      return { keyId: data.key_id, key: data.key };
    },
    async putRepoSecret(token, owner, repo, name, { encryptedValue, keyId }) {
      await request(token, `/repos/${owner}/${repo}/actions/secrets/${name}`, {
        method: "PUT",
        operation: `save the ${name} secret`,
        body: { encrypted_value: encryptedValue, key_id: keyId }
      });
    },
    async hasRepoSecret(token, owner, repo, name) {
      const { data } = await request(token, `/repos/${owner}/${repo}/actions/secrets/${name}`, {
        operation: `read the ${name} secret`,
        allow404: true
      });
      return Boolean(data);
    },
    async deleteRepoSecret(token, owner, repo, name) {
      await request(token, `/repos/${owner}/${repo}/actions/secrets/${name}`, {
        method: "DELETE",
        operation: `delete the ${name} secret`,
        allow404: true
      });
    },
    async getWorkflow(token, owner, repo, file) {
      const { data } = await request(token, `/repos/${owner}/${repo}/actions/workflows/${file}`, {
        operation: "read the workflow",
        allow404: true
      });
      return data ? { id: data.id, state: data.state, htmlUrl: data.html_url } : null;
    },
    async listWorkflowRuns(token, owner, repo, file, perPage = 5) {
      const { data } = await request(token, `/repos/${owner}/${repo}/actions/workflows/${file}/runs?per_page=${perPage}`, {
        operation: "list the workflow runs",
        allow404: true
      });
      return (data?.workflow_runs ?? []).map((run) => ({
        id: run.id,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        createdAt: run.created_at,
        htmlUrl: run.html_url
      }));
    },
    async dispatchWorkflow(token, owner, repo, file, ref) {
      await request(token, `/repos/${owner}/${repo}/actions/workflows/${file}/dispatches`, {
        method: "POST",
        operation: "start the workflow",
        body: { ref }
      });
    },
    async enableWorkflow(token, owner, repo, file) {
      await request(token, `/repos/${owner}/${repo}/actions/workflows/${file}/enable`, {
        method: "PUT",
        operation: "enable the workflow"
      });
    }
  };
}
async function describeFailure(response, operation) {
  let detail = "";
  try {
    const payload = await response.json();
    if (typeof payload?.message === "string") detail = `: ${payload.message.slice(0, 160)}`;
  } catch {
  }
  return `GitHub could not ${operation} (${response.status}${detail}).`;
}

// src/github/public-contributions.js
async function fetchPublicContributions(username, fetchImpl = fetch) {
  const upstream = await fetchImpl(`https://github.com/users/${encodeURIComponent(username)}/contributions`, {
    headers: { "User-Agent": "GitToPaint" }
  });
  if (!upstream.ok) {
    throw new GitHubError(`GitHub responded with ${upstream.status}.`, upstream.status);
  }
  const entries = parseContributionHtml(await upstream.text());
  if (!entries.length) {
    throw new GitHubError("Unable to parse contribution data from GitHub.", 502);
  }
  return entries;
}
function parseContributionHtml(html) {
  const tooltipById = new Map(
    [...html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]+)<\/tool-tip>/g)].map((match) => [
      match[1],
      match[2]
    ])
  );
  const titleById = new Map(
    [...html.matchAll(/<(?:rect|td)[^>]*id="([^"]+)"[^>]*>[\s\S]*?<title>([^<]+)<\/title>[\s\S]*?<\/(?:rect|td)>/g)].map(
      (match) => [match[1], match[2]]
    )
  );
  const pattern = /<(?:rect|td)[^>]*data-date="([^"]+)"[^>]*id="([^"]+)"[^>]*data-level="(\d)"[^>]*>/g;
  const entries = [];
  for (const match of html.matchAll(pattern)) {
    const [, date, id, levelText] = match;
    const tooltip = tooltipById.get(id) || titleById.get(id) || "";
    const countMatch = tooltip.match(/([\d,]+)\s+contribution/i);
    const count = countMatch ? Number(countMatch[1].replaceAll(",", "")) : 0;
    entries.push({
      date,
      count,
      level: Number(levelText)
    });
  }
  return entries;
}

// src/core.js
function toIsoDate(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString().slice(0, 10);
}
function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

// src/shared/validation.js
var PLAN_PAST_DAYS = 364;
var PLAN_FUTURE_DAYS = 53 * 7;
var MAX_PLAN_ENTRIES = 800;
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var FOLDER_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
var MAX_FOLDER_LENGTH = 200;
var MAX_FOLDER_DEPTH = 5;
var RESERVED_ROOT_FOLDERS = /* @__PURE__ */ new Set([".git", ".github"]);
var ValidationError = class extends Error {
};
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validatePlanPayload(body, now = /* @__PURE__ */ new Date()) {
  if (!isPlainObject(body) || !isPlainObject(body.plan)) {
    throw new ValidationError('Expected a JSON body with a "plan" object.');
  }
  const entries = Object.entries(body.plan);
  if (entries.length > MAX_PLAN_ENTRIES) {
    throw new ValidationError(`A plan can contain at most ${MAX_PLAN_ENTRIES} days.`);
  }
  const earliest = toIsoDate(addDays(now, -PLAN_PAST_DAYS));
  const latest = toIsoDate(addDays(now, PLAN_FUTURE_DAYS));
  const plan = {};
  for (const [date, level] of entries) {
    if (!DATE_PATTERN.test(date) || toIsoDate(/* @__PURE__ */ new Date(`${date}T00:00:00Z`)) !== date) {
      throw new ValidationError(`Invalid date "${String(date).slice(0, 20)}".`);
    }
    if (date < earliest || date > latest) {
      throw new ValidationError(`Date ${date} is outside the plannable range.`);
    }
    if (!Number.isInteger(level) || level < 1 || level > 4) {
      throw new ValidationError(`Level for ${date} must be an integer from 1 to 4.`);
    }
    plan[date] = level;
  }
  const futureWeeks = body.futureWeeks ?? 20;
  if (!Number.isInteger(futureWeeks) || futureWeeks < 4 || futureWeeks > 52) {
    throw new ValidationError("futureWeeks must be an integer from 4 to 52.");
  }
  return { plan, futureWeeks };
}
function validateFolder(value) {
  const folder = typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") : "";
  if (!folder) {
    throw new ValidationError("Choose a folder for the generated files.");
  }
  if (folder.length > MAX_FOLDER_LENGTH) {
    throw new ValidationError(`The folder path must be at most ${MAX_FOLDER_LENGTH} characters.`);
  }
  const segments = folder.split("/");
  if (segments.length > MAX_FOLDER_DEPTH) {
    throw new ValidationError(`The folder can be at most ${MAX_FOLDER_DEPTH} levels deep.`);
  }
  for (const segment of segments) {
    if (!FOLDER_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..") {
      throw new ValidationError('Folder names may only use letters, digits, ".", "_" and "-".');
    }
  }
  if (RESERVED_ROOT_FOLDERS.has(segments[0].toLowerCase())) {
    throw new ValidationError(`"${segments[0]}" is reserved, pick another folder.`);
  }
  return segments.join("/");
}

// src/shared/zone.js
var MINUTES_PER_DAY = 24 * 60;
function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
function dateInZone(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant).map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function offsetMinutes(instant, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(instant).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}
function zonedTimeToUtc(date, minutesOfDay, timeZone) {
  const wallClock = Date.parse(`${date}T00:00:00Z`) + minutesOfDay * 6e4;
  const firstGuess = wallClock - offsetMinutes(new Date(wallClock), timeZone) * 6e4;
  return new Date(wallClock - offsetMinutes(new Date(firstGuess), timeZone) * 6e4);
}
function shiftDate(date, days) {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * MINUTES_PER_DAY * 6e4);
  return shifted.toISOString().slice(0, 10);
}

// src/shared/art-config.js
var CONFIG_VERSION = 1;
var CONFIG_PATH = ".github-art-config.json";
var WORKFLOW_FILE = "draw-contributions.yml";
var WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
var APP_URL = "https://unoursmarin.github.io/GitHubPageAsPaint/";
var RUN_MINUTES_LOCAL = 12 * 60 + 20;
var SETUP_AUTHOR = Object.freeze({ name: "unoursmarin", email: "20300991+unoursmarin@users.noreply.github.com" });
var LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
function parseArtConfig(text, now = /* @__PURE__ */ new Date()) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError(`${CONFIG_PATH} is not valid JSON.`);
  }
  if (raw?.version !== CONFIG_VERSION) {
    throw new ValidationError(`${CONFIG_PATH} has an unsupported version (${String(raw?.version).slice(0, 10)}).`);
  }
  const user = raw.user ?? {};
  if (!Number.isInteger(user.id) || user.id <= 0 || typeof user.login !== "string" || !LOGIN_PATTERN.test(user.login)) {
    throw new ValidationError(`${CONFIG_PATH} does not name a valid GitHub user.`);
  }
  if (!isValidTimeZone(raw.timeZone)) {
    throw new ValidationError(`${CONFIG_PATH} has an unknown time zone.`);
  }
  const earliest = toIsoDate(addDays(now, -PLAN_PAST_DAYS));
  const recentPlan = Object.fromEntries(Object.entries(raw.plan ?? {}).filter(([date]) => date >= earliest));
  const { plan, futureWeeks } = validatePlanPayload({ plan: recentPlan, futureWeeks: raw.futureWeeks }, now);
  return {
    version: CONFIG_VERSION,
    user: { id: user.id, login: user.login, name: typeof user.name === "string" ? user.name.slice(0, 100) : user.login },
    timeZone: raw.timeZone,
    folder: validateFolder(raw.folder),
    futureWeeks,
    plan,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null
  };
}
function assertConfigOwner(config, repositoryOwner) {
  if (config.user.login.toLowerCase() !== String(repositoryOwner).toLowerCase()) {
    throw new ValidationError(
      `This drawing belongs to @${config.user.login} but the repository is owned by @${repositoryOwner}. Open ${APP_URL} to set it up again.`
    );
  }
}

// src/shared/version.js
var ENGINE_VERSION = "1.0.0";

// src/sync/runner.js
var CATCH_UP_DAYS = 7;
var DEFAULT_LIMITS = Object.freeze({ maxCommits: 120, maxChecks: 6, recheckDelayMs: 6e4 });
var CALENDAR_DAYS = 364;
var NOON_MINUTES = 12 * 60;
var TODAY_BACKDATE_MS = 5 * 6e4;
function commitAuthor(user) {
  return { name: user.name || user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
}
function commitTimestamp(date, timeZone, index, now) {
  const noon = zonedTimeToUtc(date, NOON_MINUTES, timeZone);
  const dayStart = zonedTimeToUtc(date, 0, timeZone);
  const base = noon.getTime() + index * 1e3 <= now.getTime() ? noon.getTime() : Math.max(dayStart.getTime(), now.getTime() - TODAY_BACKDATE_MS);
  return new Date(base + index * 1e3).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function duePlan(plan, today) {
  const earliest = shiftDate(today, -CATCH_UP_DAYS);
  return Object.fromEntries(Object.entries(plan).filter(([date]) => date >= earliest && date <= today));
}
function randomText() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return `${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}
`;
}
async function runDrawing({
  client,
  token,
  owner,
  repo,
  branch,
  config,
  readCalendar,
  now = () => /* @__PURE__ */ new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {
  },
  limits = DEFAULT_LIMITS
}) {
  const today = dateInZone(now(), config.timeZone);
  const due = duePlan(config.plan, today);
  if (!Object.keys(due).length) {
    log(`Nothing painted between ${shiftDate(today, -CATCH_UP_DAYS)} and ${today}.`);
    return { today, commits: 0, results: [], summary: summarizeResults([]) };
  }
  const author = commitAuthor(config.user);
  let published = 0;
  let results = [];
  for (let check = 1; check <= limits.maxChecks; check += 1) {
    const current = now();
    const days = await readCalendar({ from: new Date(current.getTime() - CALENDAR_DAYS * 864e5), to: current });
    results = reconcilePlan({ plan: due, days, today });
    const budget = limits.maxCommits - published;
    const pending = results.some((result) => result.status === "pending");
    if (!pending || budget <= 0 || check === limits.maxChecks) break;
    const batch = allocateCommits(cautiousStep(results), budget);
    await publishBatch({ client, token, owner, repo, branch, folder: config.folder, timeZone: config.timeZone, author, batch, now: current });
    published += batch.length;
    log(`Check ${check}: committed ${batch.length} file(s), re-reading the calendar.`);
    if (limits.recheckDelayMs > 0) await sleep(limits.recheckDelayMs);
  }
  return { today, commits: published, results, summary: summarizeResults(results) };
}
async function publishBatch({ client, token, owner, repo, branch, folder, timeZone, author, batch, now }) {
  let headSha = await client.getBranchSha(token, owner, repo, branch);
  let treeSha = await client.getCommitTree(token, owner, repo, headSha);
  for (const [index, { date }] of batch.entries()) {
    const path = `${folder}/${date}-${globalThis.crypto.randomUUID().slice(0, 8)}.txt`;
    treeSha = await client.createTree(token, owner, repo, { baseTree: treeSha, entries: [{ path, content: randomText() }] });
    const signature = { ...author, date: commitTimestamp(date, timeZone, index, now) };
    headSha = await client.createCommit(token, owner, repo, {
      message: `Paint ${date}`,
      tree: treeSha,
      parents: [headSha],
      author: signature,
      committer: signature
    });
  }
  await client.updateBranch(token, owner, repo, branch, headSha);
}

// engine/draw.mjs
var STATUS_LABELS = { ok: "reached", pending: "still lighter than planned", above: "darker than planned (left alone)", scheduled: "upcoming" };
function createCalendarReader({ client, login, tokens, log, fetchPublic = fetchPublicContributions }) {
  let source = null;
  return async (range) => {
    if (source) return source(range);
    for (const [label, token] of tokens) {
      const candidate = (window2) => client.getContributionDays(token, login, window2);
      try {
        const days = await candidate(range);
        source = candidate;
        log(`Reading the calendar with ${label}.`);
        return days;
      } catch (error) {
        log(`Could not read the calendar with ${label}: ${error.message}`);
      }
    }
    source = () => fetchPublic(login);
    log("Reading the calendar from the public profile page.");
    return source(range);
  };
}
function formatSummary({ today, commits, results }, repository) {
  const rows = results.map(({ date, target, actualLevel, status }) => `| ${date} | ${target} | ${actualLevel ?? "-"} | ${STATUS_LABELS[status] ?? status} |`);
  return [
    `## GitToPaint on ${repository}`,
    "",
    `Engine v${ENGINE_VERSION}. Checked the ${CATCH_UP_DAYS} days before ${today} and ${today} itself: ${commits} commit(s) added.`,
    "",
    ...rows.length ? ["| Day | Planned level | Level on GitHub | State |", "|---|---|---|---|", ...rows] : ["No painted day in this window."],
    ""
  ].join("\n");
}
async function main(env = process.env) {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || !env.GITHUB_TOKEN) {
    throw new Error("Run this script from GitHub Actions: GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
  }
  const config = parseArtConfig(await fs.readFile(CONFIG_PATH, "utf8"));
  assertConfigOwner(config, owner);
  const client = createGitHubClient();
  const repoInfo = await client.getRepo(env.GITHUB_TOKEN, owner, repo);
  if (!repoInfo) throw new Error(`Cannot read ${repository} with the Actions token.`);
  const log = (message) => console.log(message);
  const tokens = [
    ["your GIT_TO_PAINT_TOKEN secret", env.GIT_TO_PAINT_TOKEN],
    ["the Actions token", env.GITHUB_TOKEN]
  ].filter(([, token]) => Boolean(token));
  const result = await runDrawing({
    client,
    token: env.GITHUB_TOKEN,
    owner,
    repo,
    branch: repoInfo.defaultBranch,
    config,
    readCalendar: createCalendarReader({ client, login: config.user.login, tokens, log }),
    log
  });
  const summary = formatSummary(result, repository);
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, summary);
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
export {
  createCalendarReader
};
