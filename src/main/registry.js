// Image references for Kubernetes pods, and the repositories and tags a registry
// offers, for the New pane form's Registry, Repository and Tag dropdowns.
//
// Repositories come from linuxserver's catalog for lscr.io, from Docker Hub's API for
// Docker Hub, and from the registry's own /v2/_catalog otherwise, which most
// registries only answer when signed in. Whatever cannot be listed comes back empty: the form then takes any name typed.

const tls = require('tls');

// Trust the system's CAs too, as curl and docker do: yes.ph's certificate comes from a
// private CA installed there, which Node's bundled list does not have.
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

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
    const challenge = err.res?.status === 401 ? err.res.headers.get('www-authenticate') : null;
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

// The repositories a registry lists, by their names on it (no host): [{ name,
// description }], sorted by name. lscr.io has no catalog of its own, so its come from
// linuxserver's (linuxserver/webtop). Docker Hub has no catalog, only a namespace's
// repositories (ns, e.g. "bitnami"), so without ns it lists the official images
// (library's), by their bare names (nginx). Signed out, Hub only gives the first page
// of 100, so this takes the first by name both ways: up to 200, all of library's 181.
async function repositories(host, ns = '') {
  if (typeof host !== 'string' || !HOST.test(host) || (ns && !validComponent(ns))) throw new Error(`bad registry: ${host}`);
  host = host.toLowerCase();
  let found;
  if (host === 'lscr.io') {
    found = (await linuxserver()).map((i) => ({ name: `linuxserver/${i.name}`, description: `${i.category ? `${i.category}. ` : ''}${i.description.replace(/\[([^\]]*)\]/g, '$1')}` }));
  } else if (HUB_HOSTS.has(host)) {
    const base = `https://hub.docker.com/v2/repositories/${ns || 'library'}/?page_size=100&ordering=`;
    found = await cached(base, async () => {
      const pages = await Promise.all(['name', '-name'].map(async (o) => (await getJson(base + o)).results));
      const byName = new Map(pages.flat().filter((r) => validComponent(r.name)).map((r) => [r.name, r]));
      return [...byName.values()].map((r) => ({ name: ns ? `${ns}/${r.name}` : r.name, description: r.description ?? '' }));
    });
  } else {
    const all = await cached(`${host}/_catalog`, async () => (await registryJson(host, '_catalog?n=1000')).repositories ?? []);
    found = all.filter((name) => splitRepo(`${host}/${name}`)).map((name) => ({ name, description: '' }));
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

module.exports = { validComponent, validTag, validRepo, parseImage, repositories, tags };
