// Image references for Kubernetes pods, and what a registry offers under a prefix, for
// the New pane form's image breadcrumbs. A prefix is where the next part of a name
// goes, ending in "/": "lscr.io/linuxserver/", "docker.io/bitnami/", "ghcr.io/org/".
//
// What lies under a prefix comes from linuxserver's catalog for lscr.io/linuxserver/,
// from Docker Hub's API for a Docker Hub namespace, and from the registry's own
// /v2/_catalog otherwise, which most registries only answer when signed in. Whatever
// cannot be listed comes back empty: the form then takes any name typed.

const CATALOG_URL = 'https://api.linuxserver.io/api/v1/images';
const TTL = 60 * 60 * 1000;
const HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

// One path component of a repository, as the distribution spec has it.
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const HOST = /^(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|[A-Za-z0-9-]+:\d+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:\d+)$/;
const validComponent = (s) => typeof s === 'string' && s.length <= 128 && COMPONENT.test(s);
const validTag = (tag) => typeof tag === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag);
// Signatures and attestations that registries list as tags, not images to run.
const imageTag = (tag) => validTag(tag) && !/^sha256-/.test(tag);

// "lscr.io/linuxserver/webtop" -> { host: 'lscr.io', path: ['linuxserver', 'webtop'] }; a
// first part that is no host name means Docker Hub. null when it is not a repository.
function splitRepo(repo) {
  if (typeof repo !== 'string' || repo.length > 255) return null;
  const parts = repo.split('/');
  const host = parts.length > 1 && HOST.test(parts[0]) ? parts.shift() : 'docker.io';
  return parts.length && parts.every(validComponent) ? { host: host.toLowerCase(), path: parts } : null;
}
const validRepo = (repo) => splitRepo(repo) !== null;

// A prefix is a host, a repository path, or both, ending in "/".
function validPrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.endsWith('/') || prefix.length > 255) return false;
  const parts = prefix.slice(0, -1).split('/');
  if (HOST.test(parts[0])) parts.shift();
  return parts.every(validComponent);
}

// "lscr.io/linuxserver/webtop:arch-kde" -> { repo: 'lscr.io/linuxserver/webtop', tag:
// 'arch-kde', app: 'webtop' }; the tag is latest when there is none.
function parseImage(ref) {
  if (typeof ref !== 'string') return null;
  const colon = ref.lastIndexOf(':');
  const [repo, tag] = colon > ref.lastIndexOf('/') ? [ref.slice(0, colon), ref.slice(colon + 1)] : [ref, 'latest'];
  const split = splitRepo(repo);
  return split && validTag(tag) ? { repo, tag, app: split.path.at(-1) } : null;
}

const cache = new Map(); // url -> { at, value }
async function cached(url, get) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await get();
  cache.set(url, { value, at: Date.now() });
  return value;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${res.status}`), { res });
  return res.json();
}

// A registry's API, with the anonymous token its 401 says where to get.
async function registryJson(host, apiPath) {
  const url = `https://${host === 'docker.io' ? 'registry-1.docker.io' : host}/v2/${apiPath}`;
  try {
    return await getJson(url);
  } catch (err) {
    const challenge = err.res?.status === 401 && err.res.headers.get('www-authenticate');
    if (!challenge?.startsWith('Bearer ')) throw err;
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const tokenUrl = new URL(params.realm);
    for (const key of ['service', 'scope']) if (params[key]) tokenUrl.searchParams.set(key, params[key]);
    const { token, access_token: accessToken } = await getJson(tokenUrl.href);
    return getJson(url, { Authorization: `Bearer ${token ?? accessToken}` });
  }
}

// linuxserver's image catalog: [{ name, category, description, tags }], without the
// deprecated images.
const linuxserver = () => cached(CATALOG_URL, async () => (await getJson(CATALOG_URL)).data.repositories.linuxserver
  .filter((i) => !i.deprecated && validComponent(i.name))
  .map((i) => ({ name: i.name, category: i.category ?? '', description: i.description ?? '', tags: (i.tags ?? []).map((t) => t.tag).filter(validTag) })));

// What goes after prefix: [{ name, category, description, tags }], sorted by name. A
// name ending in "/" goes further, a prefix of its own; tags is null when they are
// listed separately (see tags).
async function list(prefix) {
  if (!validPrefix(prefix)) throw new Error(`bad image prefix: ${prefix}`);
  const parts = prefix.slice(0, -1).split('/');
  const host = HOST.test(parts[0]) ? parts.shift().toLowerCase() : 'docker.io';
  const entry = (name, more = {}) => ({ name, category: '', description: '', tags: null, ...more });
  let found;
  if (host === 'lscr.io' && parts.length === 1 && parts[0] === 'linuxserver') {
    found = await linuxserver();
  } else if (HUB_HOSTS.has(host) && parts.length === 1) {
    const url = `https://hub.docker.com/v2/repositories/${parts[0]}/?page_size=100&ordering=last_updated`;
    found = await cached(url, async () => (await getJson(url)).results
      .filter((r) => validComponent(r.name))
      .map((r) => entry(r.name, { description: r.description ?? '' })));
  } else if (HUB_HOSTS.has(host)) {
    found = []; // Docker Hub lists no namespaces, nor anything deeper than one
  } else {
    // The registry's whole catalog, cut to the next component under the prefix.
    const all = await cached(`${host}/_catalog`, async () => (await registryJson(host, '_catalog?n=1000')).repositories ?? []);
    const under = parts.length ? `${parts.join('/')}/` : '';
    const next = new Map();
    for (const repo of all) {
      if (!repo.startsWith(under)) continue;
      const [first, ...rest] = repo.slice(under.length).split('/');
      const name = rest.length ? `${first}/` : first;
      if (validComponent(first)) next.set(name, entry(name));
    }
    found = [...next.values()];
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// A repository's tags, newest first where the registry says, else as it lists them.
async function tags(repo) {
  const split = splitRepo(repo);
  if (!split) throw new Error(`bad image: ${repo}`);
  const { host, path } = split;
  if (host === 'lscr.io' && path.length === 2 && path[0] === 'linuxserver') {
    return (await linuxserver()).find((i) => i.name === path[1])?.tags ?? [];
  }
  if (HUB_HOSTS.has(host)) {
    const name = path.length === 1 ? `library/${path[0]}` : path.join('/');
    const url = `https://hub.docker.com/v2/repositories/${name}/tags?page_size=100&ordering=last_updated`;
    return cached(url, async () => (await getJson(url)).results.map((t) => t.name).filter(imageTag));
  }
  return cached(`${host}/${path.join('/')}/tags`, async () => ((await registryJson(host, `${path.join('/')}/tags/list`)).tags ?? []).filter(imageTag));
}

module.exports = { validComponent, validTag, validRepo, validPrefix, parseImage, list, tags };
