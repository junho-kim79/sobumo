/**
 * 법제처 국가법령정보 공동활용 API 프록시
 * GET /api/law?mode=search&target=prec&query=학교폭력&page=1&display=20[&search=2][&org=400201]
 * GET /api/law?mode=view&target=prec&id=622253
 * target: prec(판례) law(법령) detc(헌재) expc(법령해석례) decc(행정심판례)
 * OC: Vercel 환경변수 LAW_OC (없으면 sobumo2026)
 */
const OC = process.env.LAW_OC || "sobumo2026";
const TARGETS = ["prec", "law", "detc", "expc", "decc"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
  const target = TARGETS.includes(req.query.target) ? req.query.target : "prec";
  const view = req.query.mode === "view";
  const qs = new URLSearchParams({ OC, target, type: "JSON" });
  if (view) qs.set(target === "law" ? "MST" : "ID", String(req.query.id || "").replace(/\D/g, ""));
  else for (const k of ["query", "page", "display", "search", "org", "sort", "JO", "nb", "prncYd"]) if (req.query[k]) qs.set(k, String(req.query[k]));
  const url = `https://www.law.go.kr/DRF/${view ? "lawService" : "lawSearch"}.do?${qs}`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Referer: "https://sobumo.com/", "User-Agent": "Mozilla/5.0 SOBUMO" } });
    const txt = await r.text();
    if (req.query.debug === "1") return res.status(200).json({ status: r.status, head: txt.slice(0, 1500) });
    let d; try { d = JSON.parse(txt); } catch { return res.status(200).json({ error: "parse", head: txt.slice(0, 200) }); }
    if (d.result && d.msg) return res.status(200).json({ error: d.msg });
    return res.status(200).json(d);
  } catch (e) { return res.status(200).json({ error: String(e) }); } finally { clearTimeout(t); }
}
