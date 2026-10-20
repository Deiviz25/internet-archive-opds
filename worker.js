const IA_SEARCH = "https://archive.org/advancedsearch.php";
const IA_META = "https://archive.org/metadata/";
const ATOM = "http://www.w3.org/2005/Atom";
const OPDS = "http://opds-spec.org/2010/catalog";
const PAGE_SIZE = 15;

function xml(s = "") {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function el(name, text, attrs = {}) {
  const a = Object.entries(attrs).map(([k,v]) => ` ${k}="${xml(v)}"`).join("");
  return `<${name}${a}>${text == null ? "" : xml(text)}</${name}>`;
}
function link(rel, href, type, title = "") {
  return `<link rel="${xml(rel)}" href="${xml(href)}" type="${xml(type)}"${title ? ` title="${xml(title)}"` : ""}/>`;
}
function response(body, type = "application/atom+xml; charset=utf-8", status = 200) {
  return new Response(body, { status, headers: { "content-type": type, "access-control-allow-origin": "*", "cache-control": "public, max-age=120" } });
}
function base(request) { return new URL(request.url).origin; }
function escQuery(q) {
  // Lucene phrase query; user text is treated as a phrase, not raw query syntax.
  return `mediatype:texts AND (title:"${q.replace(/["\\]/g, " ").slice(0,100)}" OR creator:"${q.replace(/["\\]/g, " ").slice(0,100)}" OR subject:"${q.replace(/["\\]/g, " ").slice(0,100)}")`;
}
async function jsonFetch(url) {
  const r = await fetch(url, { headers: { "user-agent": "IA-OPDS-Worker/1.0 (personal catalog)" } });
  if (!r.ok) throw new Error(`Internet Archive respondió ${r.status}`);
  return r.json();
}
async function searchIA(q, page) {
  const params = new URLSearchParams();
  params.set("q", q ? escQuery(q) : "mediatype:texts AND (format:EPUB OR format:PDF OR format:\"Comic Book ZIP\" OR format:CBZ)");
  for (const f of ["identifier", "title", "creator", "date", "description", "downloads"]) params.append("fl[]", f);
  params.set("rows", String(PAGE_SIZE)); params.set("start", String(page * PAGE_SIZE)); params.set("output", "json"); params.append("sort[]", "downloads desc");
  const data = await jsonFetch(`${IA_SEARCH}?${params}`);
  return { docs: data.response?.docs || [], total: data.response?.numFound || 0 };
}
async function itemLinks(identifier) {
  try {
    const data = await jsonFetch(IA_META + encodeURIComponent(identifier));
    const files = data.files || [];
    const results = [];
    const wanted = [
      { ext: ".epub", mime: "application/epub+zip", label: "EPUB" },
      { ext: ".pdf", mime: "application/pdf", label: "PDF" },
      { ext: ".cbz", mime: "application/vnd.comicbook+zip", label: "CBZ" },
    ];
    for (const w of wanted) {
      const f = files.find(x => typeof x.name === "string" && x.name.toLowerCase().endsWith(w.ext) && !x.name.includes("/"));
      if (f && f.name && f.source !== "metadata" && !f.private) {
        results.push({ href: `https://archive.org/download/${encodeURIComponent(identifier)}/${f.name.split("/").map(encodeURIComponent).join("/")}`, mime: w.mime, label: w.label });
      }
    }
    return results;
  } catch { return []; }
}
async function makeFeed(request, q, page) {
  const origin = base(request);
  const { docs, total } = await searchIA(q, page);
  // Check only a small page of records to stay within Workers' subrequest/time limits.
  const entries = await Promise.all(docs.map(async d => {
    const id = d.identifier;
    if (!id) return "";
    const links = await itemLinks(id);
    // Filter out records without at least one usable direct file in PDF/EPUB/CBZ.
    if (!links.length) return "";
    const title = d.title || id;
    let entry = "<entry>" + el("title", title) + el("id", `urn:internet-archive:item:${id}`) + el("updated", new Date().toISOString()) + `<author>${el("name", d.creator || "Autor desconocido")}</author>`;
    if (d.description) entry += el("summary", String(d.description).slice(0, 500));
    entry += link("alternate", `https://archive.org/details/${encodeURIComponent(id)}`, "text/html", "Ficha en Internet Archive");
    for (const l of links) entry += link("http://opds-spec.org/acquisition", l.href, l.mime, `Descargar ${l.label}`);
    entry += "</entry>";
    return entry;
  }));
  const searchUrl = `${origin}/search?q=${encodeURIComponent(q)}`;
  let body = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="${ATOM}" xmlns:opds="${OPDS}">`;
  body += el("title", q ? `Internet Archive — ${q}` : "Internet Archive — libros descargables");
  body += el("id", "urn:internet-archive:opds:filtered"); body += el("updated", new Date().toISOString());
  body += link("self", `${origin}${new URL(request.url).pathname}${new URL(request.url).search}`, "application/atom+xml;profile=opds-catalog;kind=acquisition");
  body += link("start", `${origin}/opds/`, "application/atom+xml;profile=opds-catalog;kind=navigation", "Inicio");
  body += link("search", `${origin}/opensearch.xml`, "application/opensearchdescription+xml", "Buscar libros");
  if (page > 0) body += link("previous", `${origin}/search?q=${encodeURIComponent(q)}&page=${page-1}`, "application/atom+xml;profile=opds-catalog;kind=acquisition", "Página anterior");
  if ((page + 1) * PAGE_SIZE < total) body += link("next", `${origin}/search?q=${encodeURIComponent(q)}&page=${page+1}`, "application/atom+xml;profile=opds-catalog;kind=acquisition", "Página siguiente");
  body += entries.join("");
  if (!entries.some(Boolean)) body += `<subtitle>No se encontraron resultados con descarga directa en PDF, EPUB o CBZ. Prueba otra búsqueda.</subtitle>`;
  body += "</feed>";
  return response(body);
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" || url.pathname === "/opds" || url.pathname === "/opds/") {
        return makeFeed(request, "", 0);
      }
      if (url.pathname === "/search" || url.pathname === "/search/") {
        const q = (url.searchParams.get("q") || "").trim();
        const page = Math.min(1000, Math.max(0, parseInt(url.searchParams.get("page") || "0", 10) || 0));
        if (!q) return response("Falta el término de búsqueda. Ejemplo: /search?q=don%20quijote", "text/plain; charset=utf-8", 400);
        return makeFeed(request, q, page);
      }
      if (url.pathname === "/opensearch.xml") {
        const xmlDoc = `<?xml version="1.0" encoding="UTF-8"?><OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Internet Archive</ShortName><Description>Buscar libros descargables de Internet Archive</Description><InputEncoding>UTF-8</InputEncoding><OutputEncoding>UTF-8</OutputEncoding><Url type="application/atom+xml;profile=opds-catalog" template="${xml(base(request))}/search?q={searchTerms}"/></OpenSearchDescription>`;
        return response(xmlDoc, "application/opensearchdescription+xml; charset=utf-8");
      }
      return response("Rutas: /opds/ , /search?q=termino , /opensearch.xml", "text/plain; charset=utf-8", 404);
    } catch (e) {
      return response(`Error consultando Internet Archive: ${String(e.message || e)}`, "text/plain; charset=utf-8", 502);
    }
  }
};
