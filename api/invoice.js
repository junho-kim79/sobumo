// 거래명세서 사진 → AI(DeepSeek) 인식 → 품목·수량·금액 JSON
// 사진은 저장하지 않고 인식에만 사용합니다.
// 필요한 환경변수: DEEPSEEK_API_KEY, FIREBASE_PROJECT_ID  (선택: AI_MODEL, 기본 deepseek-flash)
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

const PROMPT = `너는 한국 병의원의 거래명세서(거래명세표, 납품서, 세금계산서 포함)를 읽는 도우미다.
사진에서 공급자(도매상), 거래일자, 품목 줄들, 합계를 읽어 아래 JSON 하나만 출력한다. 설명 문장은 쓰지 않는다.

{
  "supplier": "공급자 상호 (없으면 빈 문자열)",
  "date": "YYYY-MM-DD (없으면 빈 문자열)",
  "total": 합계금액 숫자(부가세 포함 최종 금액, 없으면 0),
  "lines": [
    {
      "name": "명세서에 적힌 품명 그대로",
      "spec": "규격 (없으면 빈 문자열)",
      "qty": 명세서 수량 숫자,
      "unit": "명세서 단위 (개, 박스, BOX, EA, 팩 등. 없으면 빈 문자열)",
      "unitPrice": 단가 숫자(없으면 0),
      "amount": 공급가액 또는 금액 숫자(없으면 0),
      "matchId": "아래 '우리 병원 재고 목록'에서 같은 물건의 id, 없으면 null",
      "baseQty": 짝지은 품목의 단위로 환산한 입고 수량 숫자,
      "confidence": "high" 또는 "low",
      "note": "확신이 낮은 이유 (high면 빈 문자열)"
    }
  ]
}

규칙
- 숫자에는 쉼표·원·₩를 넣지 말고 숫자만 쓴다.
- 합계, 소계, 부가세, 공급가액 합계, 전잔액, 입금액 같은 줄은 lines에 넣지 않는다.
- 같은 물건인지 판단할 때 브랜드·용량(cc, ml)·굵기(G)·사이즈(S/M/L)·매수가 모두 맞아야 같은 물건이다. 하나라도 다르면 다른 물건이다.
- 재고 목록의 aliases는 예전 명세서에 적혀 있던 이름이다. 품명이 aliases와 같으면 그 품목이다.
- baseQty: 짝지은 품목에 packQty가 있고 명세서 단위가 그 품목의 packUnit(박스 등)이면 qty × packQty. 단위가 같으면 qty 그대로. 짝이 없으면 qty 그대로.
- 박스·팩 단위인데 몇 개 들이인지 모르겠으면 qty 그대로 두고 confidence를 "low", note에 "박스 입수 확인 필요"라고 쓴다.
- 글씨가 흐려 숫자가 확실하지 않으면 confidence "low".
- 거래명세서가 아닌 사진이면 {"error":"거래명세서가 아닙니다"}만 출력한다.`;

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.DEEPSEEK_API_KEY, pid = process.env.FIREBASE_PROJECT_ID;
  if (!key || !pid) return res.status(500).json({ error: '서버 설정이 아직 안 되어 있어요 (DEEPSEEK_API_KEY / FIREBASE_PROJECT_ID)' });

  // 로그인한 사용자만 (AI 비용 보호)
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${pid}`, audience: pid });
  } catch {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }

  const { image, items } = req.body || {};
  if (typeof image !== 'string' || !image.startsWith('data:image/') || image.length > 6_000_000) {
    return res.status(400).json({ error: '사진이 올바르지 않아요' });
  }
  const catalog = (Array.isArray(items) ? items : []).slice(0, 600).map((x) => ({
    id: String(x.id), name: String(x.name || ''), spec: String(x.spec || ''), unit: String(x.unit || ''),
    packQty: Number(x.packQty) || undefined, packUnit: x.packUnit ? String(x.packUnit) : undefined,
    aliases: Array.isArray(x.aliases) ? x.aliases.slice(0, 10).map(String) : undefined,
  }));

  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'deepseek-flash',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: [
            { type: 'text', text: `우리 병원 재고 목록(JSON):\n${JSON.stringify(catalog)}` },
            { type: 'image_url', image_url: { url: image } },
          ] },
        ],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('AI error', r.status, t.slice(0, 500));
      return res.status(502).json({ error: 'AI가 응답하지 않아요. 잠시 후 다시 시도해 주세요' });
    }
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || '';
    const out = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
    if (out.error) return res.status(422).json({ error: out.error });
    const ids = new Set(catalog.map((x) => x.id));
    const num = (v) => { const n = Number(String(v ?? 0).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
    out.lines = (out.lines || []).map((l) => ({
      name: String(l.name || '').slice(0, 100), spec: String(l.spec || '').slice(0, 60),
      qty: num(l.qty), unit: String(l.unit || '').slice(0, 10),
      unitPrice: num(l.unitPrice), amount: num(l.amount),
      matchId: l.matchId && ids.has(String(l.matchId)) ? String(l.matchId) : null,
      baseQty: Math.max(0, Math.round(num(l.baseQty ?? l.qty))),
      confidence: l.confidence === 'low' ? 'low' : 'high', note: String(l.note || '').slice(0, 80),
    })).filter((l) => l.name && l.baseQty > 0);
    out.total = num(out.total);
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: '인식하지 못했어요. 더 밝고 반듯하게 다시 찍어 주세요' });
  }
}
