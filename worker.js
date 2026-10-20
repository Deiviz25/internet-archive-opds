const IA_SEARCH = "https://archive.org/advancedsearch.php";
const IA_META = "https://archive.org/metadata/";
const IA_IMG = "https://archive.org/services/img/";
const ATOM = "http://www.w3.org/2005/Atom";
const OPDS = "http://opds-spec.org/2010/catalog";
const PAGE_SIZE = 15;
const NAV = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ACQ = "application/atom+xml;profile=opds-catalog;kind=acquisition";
const DEFAULT_QUERY =
  'mediatype:texts AND (format:EPUB OR format:PDF OR format:"Comic Book ZIP")';

const FORMATS = [
  { ext: ".epub", mime: "application/epub+zip", label: "EPUB" },
  { ext: ".pdf", mime: "application/pdf", label: "PDF" },
  { ext: ".cbz", mime: "application/vnd.comicbook+zip", label: "CBZ" },
];

function xml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function text(v, max = 0) {
  const s = Array.isArray(v) ? v.join(" ") : String(v ?? "");
  const clean = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return max ? clean.slice(0, max) : clean;
}

function el(name, value, attrs = {}) {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${xml(v)}"`)
    .join("");
  return `<${name}${a}>${value == null ? "" : xml(value)}</${name}>`;
}

function link(rel, href, type, title = "") {
  return `<link rel="${xml(rel)}" href="${xml(href)}" type="${xml(type)}"${
    title ? ` title="${xml(title)}"` : ""
  }/>`;
}

function response(body, type = "application/atom+xml; charset=utf-8", status = 200, maxAge = 300) {
  return new Response(body, {
    status,
    headers: {
      "content-type": type,
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });
}

function escQuery(q) {
  const clean = q.replace(/["\\]/g, " ").slice(0, 100).trim();
  return `mediatype:texts AND (title:"${clean}" OR creator:"${clean}" OR subject:"${clean}") AND (format:EPUB OR format:PDF OR format:"Comic Book ZIP")`;
}

async function jsonFetch(url, ttl = 900) {
  const r = await fetch(url, {
    headers: { "user-agent": "IA-OPDS-Worker/1.1 (catálogo personal)" },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`Internet Archive respondió ${r.status}`);
  return r.json();
}

async function searchIA(q, page) {
  const params = new URLSearchParams();
  params.set("q", q ? escQuery(q) : DEFAULT_QUERY);
  for (const f of ["identifier", "title", "creator", "date", "description"]) {
    params.append("fl[]", f);
  }
  params.set("rows", String(PAGE_SIZE));
  params.set("start", String(page * PAGE_SIZE));
  params.set("output", "json");
  params.append("sort[]", "downloads desc");

  const data = await jsonFetch(`${IA_SEARCH}?${params}`);
  return {
    docs: data.response?.docs || [],
    total: data.response?.numFound || 0,
  };
}

async function itemLinks(identifier) {
  try {
    const data = await jsonFetch(
      IA_META + encodeURIComponent(identifier),
      86400
    );
    const files = Array.isArray(data.files) ? data.files : [];
    const out = [];

    for (const fmt of FORMATS) {
      const f = files.find(
        x =>
          typeof x.name === "string" &&
          x.name.toLowerCase().endsWith(fmt.ext) &&
          !x.name.includes("/") &&
          x.source !== "metadata" &&
          !x.private
      );
      if (f) {
        out.push({
          href: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name)}`,
          mime: fmt.mime,
          label: fmt.label,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function entryXml(d, links) {
  const id = text(d.identifier);
  const title = text(d.title) || id;
  const author = text(d.creator) || "Autor desconocido";
  const summary = text(d.description, 500);
  const img = `${IA_IMG}${encodeURIComponent(id)}`;

  let x = "<entry>";
  x += el("title", title);
  x += el("id", `urn:internet-archive:item:${id}`);
  x += el("updated", new Date().toISOString());
  x += `<author>${el("name", author)}</author>`;
  if (summary) x += el("summary", summary);
  x += link("http://opds-spec.org/image", img, "image/jpeg");
  x += link("http://opds-spec.org/image/thumbnail", img, "image/jpeg");
  x += link(
    "alternate",
    `https://archive.org/details/${encodeURIComponent(id)}`,
    "text/html",
    "Ficha en Internet Archive"
  );
  for (const l of links) {
    x += link("http://opds-spec.org/acquisition", l.href, l.mime, `Descargar ${l.label}`);
  }
  return x + "</entry>";
}

function parsePage(url) {
  const n = parseInt(url.searchParams.get("page") || "0", 10);
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : 0;
}

async function makeFeed(request, q, page) {
  const origin = new URL(request.url).origin;
  const { docs, total } = await searchIA(q, page);

  const entries = (
    await Promise.all(
      docs.map(async d => {
        const id = text(d.identifier);
        if (!id) return "";
        const links = await itemLinks(id);
        return links.length ? entryXml(d, links) : "";
      })
    )
  ).filter(Boolean);

  const selfPath = q
    ? `/search?q=${encodeURIComponent(q)}&page=${page}`
    : `/opds/?page=${page}`;
  const pageHref = p =>
    q
      ? `${origin}/search?q=${encodeURIComponent(q)}&page=${p}`
      : `${origin}/opds/?page=${p}`;
  const title = q
    ? `Internet Archive — ${q}`
    : "Internet Archive — libros descargables";

  let body = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="${ATOM}" xmlns:opds="${OPDS}">`;
  body += el("id", `${origin}${selfPath}`);
  body += el("title", title);
  body += el("updated", new Date().toISOString());
  if (!entries.length) {
    body += el("subtitle", "No se encontraron resultados con descarga directa en PDF, EPUB o CBZ en esta página.");
  }
  body += link("self", `${origin}${selfPath}`, ACQ);
  body += link("start", `${origin}/opds/`, NAV, "Inicio");
  body += link("search", `${origin}/opensearch.xml`, "application/opensearchdescription+xml", "Buscar libros");
  if (page > 0) body += link("previous", pageHref(page - 1), ACQ, "Página anterior");
  if ((page + 1) * PAGE_SIZE < total) body += link("next", pageHref(page + 1), ACQ, "Página siguiente");
  body += entries.join("");
  body += "</feed>";

  return response(body);
}

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return response("Método no permitido", "text/plain; charset=utf-8", 405);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/opds" || url.pathname === "/opds/") {
        return makeFeed(request, "", parsePage(url));
      }

      if (url.pathname === "/search" || url.pathname === "/search/") {
        const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
        if (!q) {
          return response(
            "Falta el término de búsqueda. Ejemplo: /search?q=don%20quijote",
            "text/plain; charset=utf-8",
            400
          );
        }
        return makeFeed(request, q, parsePage(url));
      }

      if (url.pathname === "/opensearch.xml") {
        const doc = `<?xml version="1.0" encoding="UTF-8"?><OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Internet Archive</ShortName><Description>Buscar libros descargables de Internet Archive</Description><InputEncoding>UTF-8</InputEncoding><OutputEncoding>UTF-8</OutputEncoding><Url type="${ACQ}" template="${xml(url.origin)}/search?q={searchTerms}"/></OpenSearchDescription>`;
        return response(doc, "application/opensearchdescription+xml; charset=utf-8", 200, 86400);
      }

      return response(
        "Rutas: /opds/ , /search?q=termino , /opensearch.xml",
        "text/plain; charset=utf-8",
        404
      );
    } catch (e) {
      return response(
        `Error consultando Internet Archive: ${String(e.message || e)}`,
        "text/plain; charset=utf-8",
        502
      );
    }
  },
};
