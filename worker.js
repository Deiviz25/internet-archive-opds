// worker.js
const IA = {
  search: "https://archive.org/advancedsearch.php",
  meta: "https://archive.org/metadata/",
  details: "https://archive.org/details/",
  download: "https://archive.org/download/",
  img: "https://archive.org/services/img/",
};

const NS =
  'xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" ' +
  'xmlns:dc="http://purl.org/dc/terms/" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"';

const MIME = {
  nav: "application/atom+xml;profile=opds-catalog;kind=navigation",
  acq: "application/atom+xml;profile=opds-catalog;kind=acquisition",
  osd: "application/opensearchdescription+xml",
};

const CFG = {
  pageSize: 15,
  maxPage: 600, // 600 x 15 = 9.000, por debajo del límite de 10.000 de Advanced Search
  maxQuery: 100,
  searchTtl: 900,
  itemTtl: 86400,
  concurrency: 8,
  timeoutMs: 5000,
  budgetMs: 8000, // tiempo máximo para cargar los ítems de una lista
};

const DEFAULT_QUERY =
  'mediatype:texts AND (format:EPUB OR format:PDF OR format:"Comic Book ZIP")';

// Un solo archivo por publicación, en este orden de preferencia.
const FORMATS = [
  { ext: ".epub", mime: "application/epub+zip", label: "EPUB" },
  { ext: ".pdf", mime: "application/pdf", label: "PDF" },
  { ext: ".cbz", mime: "application/vnd.comicbook+zip", label: "CBZ" },
];

// Versiones derivadas (OCR, baja resolución...). Solo se usan si no hay otra opción.
const DERIVED = /_(text|bw|hocr|djvu|abbyy|chocr|meta)\b/i;

// Identificadores de Internet Archive: letras, números, punto, guion y guion bajo.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/;

// ---------- Utilidades XML y texto ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]
  );

const el = (name, value, attrs = {}) => {
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  return `<${name}${a}>${value == null ? "" : esc(value)}</${name}>`;
};

const link = (rel, href, type, title = "") =>
  `<link rel="${esc(rel)}" href="${esc(href)}" type="${esc(type)}"${title ? ` title="${esc(title)}"` : ""}/>`;

const clean = (v, max = 0) => {
  const s = String(v ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return max ? s.slice(0, max) : s;
};

const asList = (v) =>
  (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => clean(x)).filter(Boolean);

const first = (v) => asList(v)[0] || "";

// Títulos: texto plano, sin quitar caracteres como < >.
const plain = (v) =>
  String(Array.isArray(v) ? v[0] ?? "" : v ?? "").replace(/\s+/g, " ").trim();

function respond(body, { type = MIME.acq, status = 200, maxAge = 300 } = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": `${type}; charset=utf-8`,
      // Sin caché cuando la respuesta es parcial o de error, para no servir fallos durante 5 minutos.
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

const text = (msg, status = 200) =>
  new Response(msg, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

// ---------- Acceso a Internet Archive ----------
async function getJson(url, ttl) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, {
      headers: {
        "user-agent": "IA-OPDS/2.0 (catálogo personal de solo lectura)",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(CFG.timeoutMs),
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (r.ok) return r.json();

    // Un único reintento para 429 y errores de servidor, respetando Retry-After (máx. 2 s).
    if ((r.status === 429 || r.status >= 500) && attempt === 0) {
      const wait = Math.min(Number(r.headers.get("retry-after")) || 1, 2) * 1000;
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    throw new Error(`Internet Archive respondió ${r.status}`);
  }
}

function buildQuery(q) {
  if (!q) return DEFAULT_QUERY;
  const c = q.replace(/["\\]/g, " ").trim();
  return `mediatype:texts AND (title:"${c}" OR creator:"${c}" OR subject:"${c}") AND (format:EPUB OR format:PDF OR format:"Comic Book ZIP")`;
}

async function searchIds({ q, mode, page }) {
  const p = new URLSearchParams();
  p.set("q", buildQuery(q));
  p.append("fl[]", "identifier");
  p.set("rows", String(CFG.pageSize));
  p.set("start", String(page * CFG.pageSize));
  p.set("output", "json");
  p.append("sort[]", mode === "recent" ? "publicdate desc" : "downloads desc");

  const data = await getJson(`${IA.search}?${p}`, CFG.searchTtl);
  const r = data.response || {};
  const ids = (r.docs || [])
    .map((d) => d.identifier)
    .filter((id) => typeof id === "string" && ID_RE.test(id));
  return { ids, total: Number(r.numFound) || 0 };
}

function pickBestFile(files = []) {
  for (const fmt of FORMATS) {
    const candidates = files.filter(
      (f) =>
        typeof f?.name === "string" &&
        f.name.toLowerCase().endsWith(fmt.ext) &&
        !f.name.includes("/") &&
        f.source !== "metadata" &&
        !f.private
    );
    if (!candidates.length) continue;

    // Preferir siempre la versión original; las derivadas solo si no hay otra.
    const primary = candidates.filter((f) => !DERIVED.test(f.name));
    const pool = primary.length ? primary : candidates;
    pool.sort((a, b) => a.name.length - b.name.length);
    return { file: pool[0].name, mime: fmt.mime, label: fmt.label };
  }
  return null;
}

// Caché explícita (Cache API) para que los metadatos se reutilicen entre peticiones.
async function cachedJson(url, ttl) {
  const cache = caches.default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const data = await getJson(url, ttl);
  await cache.put(
    key,
    new Response(JSON.stringify(data), {
      headers: { "cache-control": `public, max-age=${ttl}` },
    })
  );
  return data;
}

// Devuelve null si el identificador no existe en Internet Archive.
// Lanza error si hay fallo de red o de servicio.
async function getItem(id) {
  const data = await cachedJson(IA.meta + encodeURIComponent(id), CFG.itemTtl);
  if (!data || (!data.metadata && !data.files)) return null;

  const m = data.metadata || {};
  return {
    id,
    title: plain(m.title) || id,
    authors: asList(m.creator),
    date: first(m.date) || first(m.year),
    language: first(m.language),
    publisher: first(m.publisher),
    subjects: asList(m.subject).slice(0, 10),
    isbn: first(m.isbn).replace(/[^0-9Xx]/g, ""),
    description: clean(asList(m.description).join(" "), 1000),
    dl: pickBestFile(data.files),
  };
}

// ---------- Generación OPDS ----------
function entryXml(b, origin, detail) {
  const img = IA.img + encodeURIComponent(b.id);
  let x =
    "<entry>" +
    el("title", b.title) +
    el("id", `urn:internet-archive:${b.id}`) +
    el("updated", new Date().toISOString());

  for (const a of b.authors) x += `<author>${el("name", a)}</author>`;
  if (b.date) x += el("dc:issued", b.date);
  if (b.language) x += el("dc:language", b.language);
  if (b.publisher) x += el("dc:publisher", b.publisher);
  if (b.isbn) x += el("dc:identifier", `urn:isbn:${b.isbn}`);
  for (const s of b.subjects) x += `<category term="${esc(s)}" label="${esc(s)}"/>`;
  if (b.description) x += el("summary", b.description, { type: "text" });

  x += link("http://opds-spec.org/image", img, "image/jpeg");
  x += link("http://opds-spec.org/image/thumbnail", img, "image/jpeg");
  x += link("alternate", IA.details + encodeURIComponent(b.id), "text/html", "Ficha en Internet Archive");

  if (b.dl) {
    const href = IA.download + encodeURIComponent(b.id) + "/" + encodeURIComponent(b.dl.file);
    x += link("http://opds-spec.org/acquisition/open-access", href, b.dl.mime, `Descargar ${b.dl.label}`);
  }
  if (!detail) {
    x += link("related", `${origin}/opds/item/${encodeURIComponent(b.id)}.xml`, MIME.acq, "Ver detalles");
  }
  return x + "</entry>";
}

function feed({ origin, id, title, self, type = MIME.acq, links = [], entries = "", subtitle = "", total, page }) {
  let x = `<?xml version="1.0" encoding="UTF-8"?><feed ${NS}>`;
  x += el("id", id) + el("title", title) + el("updated", new Date().toISOString());
  if (total != null) {
    x += el("opensearch:totalResults", total);
    x += el("opensearch:startIndex", page * CFG.pageSize + 1);
    x += el("opensearch:itemsPerPage", CFG.pageSize);
  }
  if (subtitle) x += el("subtitle", subtitle);
  x += link("self", self, type);
  x += link("start", `${origin}/opds/`, MIME.nav, "Inicio");
  x += link("search", `${origin}/opensearch.xml`, MIME.osd, "Buscar");
  x += links.join("") + entries + "</feed>";
  return x;
}

function pageUrl(origin, path, params, p) {
  const u = new URL(path, origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (p > 0) u.searchParams.set("page", String(p));
  return u.href;
}

function clampPage(v) {
  const n = parseInt(v ?? "0", 10);
  return Number.isFinite(n) ? Math.min(CFG.maxPage, Math.max(0, n)) : 0;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Devuelve { xml, failed }. failed = true si hubo algún fallo de IA (no se cachea).
async function listing({ origin, path, params = {}, mode, title, page }) {
  const p = clampPage(page);
  const selfUrl = pageUrl(origin, path, params, p);
  let total = 0;
  let entries = "";
  let subtitle = "";
  let failed = false;
  const deadline = Date.now() + CFG.budgetMs;

  try {
    const { ids, total: t } = await searchIds({ q: params.q, mode, page: p });
    total = t;

    const results = await mapLimit(ids, CFG.concurrency, async (id) => {
      // Si se agota el presupuesto, se omite el resto: la respuesta llega a tiempo
      // y no se cachea, así que al recargar se completa con los metadatos ya cacheados.
      if (Date.now() > deadline) return { error: true };
      try {
        return { book: await getItem(id) };
      } catch (e) {
        console.warn("item", id, e.message);
        return { error: true };
      }
    });

    if (results.some((r) => r.error)) failed = true;

    const books = results.map((r) => r.book).filter(Boolean);
    entries = books.map((b) => entryXml(b, origin, false)).join("");

    if (!ids.length) subtitle = "No hay resultados en esta página.";
    else if (failed && !books.length) {
      subtitle = "No se han podido cargar las publicaciones. Inténtalo de nuevo en unos minutos.";
    }
  } catch (e) {
    console.warn("search", e.message);
    failed = true;
    subtitle = "Internet Archive no responde ahora. Inténtalo de nuevo en unos minutos.";
  }

  const links = [];
  if (p > 0) links.push(link("previous", pageUrl(origin, path, params, p - 1), MIME.acq, "Página anterior"));
  if ((p + 1) * CFG.pageSize < total && p < CFG.maxPage) {
    links.push(link("next", pageUrl(origin, path, params, p + 1), MIME.acq, "Página siguiente"));
  }

  const xml = feed({ origin, id: selfUrl, title, self: selfUrl, links, entries, subtitle, total, page: p });
  return { xml, failed };
}

function rootFeed(origin) {
  const now = new Date().toISOString();
  const sections = [
    ["Recientes", "/opds/recent.xml", "Publicaciones añadidas recientemente"],
    ["Populares", "/opds/popular.xml", "Las más descargadas"],
  ];
  const entries = sections
    .map(
      ([t, path, desc]) =>
        `<entry>${el("title", t)}${el("id", origin + path)}${el("updated", now)}` +
        `${el("content", desc, { type: "text" })}${link("subsection", origin + path, MIME.acq)}</entry>`
    )
    .join("");
  return feed({
    origin,
    id: `${origin}/opds/`,
    title: "Internet Archive",
    self: `${origin}/opds/`,
    type: MIME.nav,
    entries,
  });
}

async function itemFeed(origin, id) {
  const b = await getItem(id);
  if (!b) return null;
  const self = `${origin}/opds/item/${encodeURIComponent(id)}.xml`;
  return feed({
    origin,
    id: self,
    title: b.title,
    self,
    entries: entryXml(b, origin, true),
    links: [link("up", `${origin}/opds/`, MIME.nav, "Volver")],
  });
}

function openSearch(origin) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">' +
    "<ShortName>Internet Archive</ShortName>" +
    "<Description>Buscar libros descargables en Internet Archive</Description>" +
    "<InputEncoding>UTF-8</InputEncoding><OutputEncoding>UTF-8</OutputEncoding>" +
    `<Url type="${MIME.acq}" template="${esc(origin)}/opds/search.xml?q={searchTerms}"/>` +
    "</OpenSearchDescription>"
  );
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// ---------- Rutas ----------
export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text("Método no permitido", 405);
    }

    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const q = clean(url.searchParams.get("q") || "").slice(0, CFG.maxQuery);
    const page = url.searchParams.get("page");

    try {
      if (path === "/health") {
        return new Response(JSON.stringify({ status: "ok", time: new Date().toISOString() }), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (path === "/" || path === "/opds") {
        return respond(rootFeed(origin), { type: MIME.nav, maxAge: 3600 });
      }

      if (path === "/opensearch.xml") {
        return respond(openSearch(origin), { type: MIME.osd, maxAge: 86400 });
      }

      if (path === "/search") {
        return Response.redirect(`${origin}/opds/search.xml${url.search}`, 301);
      }

      if (path === "/opds/recent.xml") {
        const r = await listing({ origin, path: "/opds/recent.xml", mode: "recent", title: "Recientes", page });
        return respond(r.xml, { maxAge: r.failed ? 0 : 300 });
      }

      if (path === "/opds/popular.xml") {
        const r = await listing({ origin, path: "/opds/popular.xml", mode: "popular", title: "Populares", page });
        return respond(r.xml, { maxAge: r.failed ? 0 : 300 });
      }

      if (path === "/opds/search.xml") {
        if (!q) return text("Falta el término de búsqueda. Ejemplo: /opds/search.xml?q=quijote", 400);
        const r = await listing({
          origin,
          path: "/opds/search.xml",
          params: { q },
          mode: "popular",
          title: `Resultados para "${q}"`,
          page,
        });
        return respond(r.xml, { maxAge: r.failed ? 0 : 300 });
      }

      const itemMatch = path.match(/^\/opds\/item\/([^/]+)\.xml$/);
      if (itemMatch) {
        const id = safeDecode(itemMatch[1]);
        if (!id || !ID_RE.test(id)) return text("Identificador no válido", 400);
        const body = await itemFeed(origin, id);
        if (!body) return text("Publicación no encontrada", 404);
        return respond(body);
      }

      return text("Rutas: /opds/ · /opds/recent.xml · /opds/popular.xml · /opds/search.xml?q=... · /health", 404);
    } catch (e) {
      console.error("error interno", e);
      return text("Error interno. Inténtalo de nuevo más tarde.", 500);
    }
  },
};
