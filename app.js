import { createApi, configured, isDemo } from './data.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE = { owner: '원장·최고관리자', manager: '사무장·행정', staff: '간호사·직원' };
const ROLE_SHORT = { owner: '원장', manager: '사무장', staff: '직원' };
const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');

let api, user, hid, hospital, member;
const st = { items: [], logs: [], members: [], invites: [], invoices: [], suppliers: [], requests: [], orders: [], payments: [], month: '', tab: 'stock', q: '', flash: new Set() };

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2400);
}
function show(id) {
  ['loading', 'landing', 'screen', 'tabs'].forEach((x) => ($('#' + x).hidden = !id.includes(x)));
}
function ago(d) {
  const s = (Date.now() - d) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const isLow = (it) => it.qty <= it.minQty;
const isManager = () => member && (member.role === 'owner' || member.role === 'manager');
const canInvoice = () => isManager() || !!member?.perms?.invoice;
const canPrice = () => isManager() || !!member?.perms?.price;
const errMsg = (e) => (String(e?.code || e?.message || e).includes('permission') ? '권한이 없습니다' : '저장하지 못했어요. 잠시 후 다시 시도해 주세요');

/* ── 초대 링크 파라미터 ?join=병원ID_코드 ── */
const joinParam = new URLSearchParams(location.search).get('join');
const [joinHid, joinCode] = joinParam ? joinParam.split('_') : [];

/* ── 첫 화면 영상 자막: 앞부분(종이) → 뒷부분(폰) ── */
(function heroCaption() {
  const v = document.getElementById('heroV'), c = document.getElementById('heroCap');
  if (!v || !c) return;
  let cur = 0;
  v.addEventListener('timeupdate', () => {
    const n = v.currentTime < 4.9 ? 0 : 1;
    if (n === cur) return;
    cur = n; c.style.opacity = 0;
    setTimeout(() => { c.textContent = n ? '이제는, 다 같이 한눈에' : '예전엔, 종이로 하나하나'; c.classList.toggle('now', !!n); c.style.opacity = 1; }, 300);
  });
})();

/* ── 시작 ── */
(async function boot() {
  if (!configured) { show('landing'); $('#cfgInfo').hidden = false; $('#startBtn').disabled = true; return; }
  try { api = await createApi(); }
  catch (e) { console.error(e); show('landing'); $('#cfgInfo').hidden = false; $('#cfgInfo').textContent = '연결이 원활하지 않아요. 잠시 후 새로고침해 주세요.'; $('#startBtn').disabled = true; return; }
  $('#startBtn').onclick = async () => { try { await api.signIn(); } catch (e) { toast('로그인에 실패했어요'); } };
  if (joinCode) { $('#joinInfo').hidden = false; $('#joinInfo').textContent = '병원 초대 링크로 들어오셨어요. 구글 계정으로 시작하면 바로 합류합니다.'; $('#startBtn').innerHTML = '🎁 초대받은 병원 합류하기 <span>›</span>'; }
  api.onAuth(async (u) => {
    user = u;
    if (!u) { show('landing'); return; }
    show('loading');
    try { await route(); } catch (e) { console.error(e); toast('불러오지 못했어요'); show('landing'); }
  });
})();

async function route() {
  if (joinCode) return joinScreen();
  hid = await api.getUserHospital(user.uid);
  if (!hid) return setupScreen();
  member = await api.getMember(hid, user.uid);
  if (!member || member.status !== 'active') return blockedScreen();
  hospital = await api.getHospital(hid);
  startApp();
}

/* ── 병원 만들기 ── */
function setupScreen() {
  show('screen');
  $('#screen').innerHTML = `
  <div class="page" style="padding-top:36px">
    <div class="brand" style="text-align:center;margin-bottom:22px"><div class="b-eng">SOBUMO</div><h1 style="font-size:2.2rem">재고<span>한눈에</span></h1></div>
    <div class="card">
      <h2>우리 병원 공간 만들기</h2>
      <p class="d">만드는 분이 <b>원장·최고관리자</b>가 됩니다. 직원은 다음 화면에서 초대 링크로 부를 수 있어요.</p>
      <label class="f">병원 이름</label><input class="in" id="hName" maxlength="60" placeholder="예) 감귤의원">
      <label class="f">내 이름</label><input class="in" id="myName" maxlength="30" value="${esc(user.name)}">
      <label class="f">직책</label><input class="in" id="myTitle" maxlength="20" value="원장" placeholder="원장 / 대표원장 / 행정부원장">
      <button class="btn blue wide" id="mk">병원 만들기</button>
    </div>
    <div class="card">
      <h2 style="font-size:1rem">직원으로 들어오시나요?</h2>
      <p class="d" style="margin:0">원장님께 받은 <b>초대 링크</b>를 눌러 다시 들어와 주세요.</p>
    </div>
    <button class="s-link" id="out">다른 계정으로 로그인</button>
  </div>`;
  $('#out').onclick = () => api.signOut();
  $('#mk').onclick = async (e) => {
    const name = $('#hName').value.trim(), myName = $('#myName').value.trim(), title = $('#myTitle').value.trim();
    if (!name || !myName) return toast('병원 이름과 내 이름을 입력해 주세요');
    e.target.disabled = true;
    try { hid = await api.createHospital({ name, myName, title }); await route(); toast('병원 공간이 만들어졌어요'); }
    catch (err) { console.error(err); toast(errMsg(err)); e.target.disabled = false; }
  };
}

/* ── 초대 링크로 합류 ── */
async function joinScreen() {
  show('screen');
  let inv = null;
  try { inv = await api.getInvite(joinHid, joinCode); } catch {}
  const existing = await api.getUserHospital(user.uid);
  const done = () => { history.replaceState(null, '', location.pathname); };
  if (existing === joinHid) {
    done(); location.reload(); return;
  }
  if (!inv || (inv.expiresAt && inv.expiresAt < new Date())) {
    $('#screen').innerHTML = `<div class="page" style="padding-top:60px"><div class="card"><h2>초대 링크가 만료되었어요</h2><p class="d">원장님께 새 초대 링크를 요청해 주세요. (초대 링크는 7일간 유효합니다)</p><button class="btn wide" id="bk">처음으로</button></div></div>`;
    $('#bk').onclick = () => { done(); location.reload(); };
    return;
  }
  $('#screen').innerHTML = `
  <div class="page" style="padding-top:36px">
    <div class="brand" style="text-align:center;margin-bottom:22px"><div class="b-eng">SOBUMO</div><h1 style="font-size:2.2rem">재고<span>한눈에</span></h1></div>
    <div class="card">
      <h2>${esc(inv.hospitalName || '병원')}에 합류</h2>
      <p class="d">권한: <span class="role ${inv.role}" style="margin:0">${ROLE[inv.role]}</span></p>
      ${existing ? `<p class="notice" style="margin-bottom:8px">이미 다른 병원에 소속되어 있어요. 합류하면 이 병원으로 바뀝니다.</p>` : ''}
      <label class="f">내 이름 (재고 수정 기록에 표시돼요)</label><input class="in" id="myName" maxlength="30" value="${esc(user.name)}">
      <label class="f">직책</label><input class="in" id="myTitle" maxlength="20" value="${esc(inv.title || '')}">
      <button class="btn blue wide" id="jn">합류하기</button>
    </div>
    <button class="s-link" id="out">다른 계정으로 로그인</button>
  </div>`;
  $('#out').onclick = () => api.signOut();
  $('#jn').onclick = async (e) => {
    const name = $('#myName').value.trim(); if (!name) return toast('이름을 입력해 주세요');
    e.target.disabled = true;
    try { await api.joinByInvite(joinHid, joinCode, { name, title: $('#myTitle').value.trim(), role: inv.role, perms: inv.perms }); done(); location.reload(); }
    catch (err) { console.error(err); toast('합류하지 못했어요. 이미 퇴사 처리된 계정이면 원장님께 문의해 주세요'); e.target.disabled = false; }
  };
}

function blockedScreen() {
  show('screen');
  $('#screen').innerHTML = `<div class="page" style="padding-top:60px"><div class="card"><h2>접근 권한이 없어요</h2><p class="d">퇴사 처리되었거나 병원에서 권한이 해제되었습니다. 기존에 남긴 재고 기록은 병원에 그대로 보존됩니다.</p><button class="btn wide" id="out">로그아웃</button></div></div>`;
  $('#out').onclick = () => api.signOut();
}

/* ── 메인 앱 ── */
function startApp() {
  show('screen tabs');
  let firstItems = true;
  api.watchItems(hid, (items) => {
    if (!firstItems) {
      const prev = new Map(st.items.map((x) => [x.id, x.qty]));
      items.forEach((x) => { if (prev.has(x.id) && prev.get(x.id) !== x.qty) st.flash.add(x.id); });
      setTimeout(() => { st.flash.clear(); document.querySelectorAll('.item.flash').forEach((e) => e.classList.remove('flash')); }, 1600);
    }
    firstItems = false;
    st.items = items.sort((a, b) => a.name.localeCompare(b.name, 'ko') || (a.spec || '').localeCompare(b.spec || '', 'ko'));
    render();
  });
  api.watchLogs(hid, (logs) => { st.logs = logs; if (st.tab === 'log') render(); });
  api.watchMembers(hid, (m) => {
    st.members = m;
    const mine = m.find((x) => x.uid === user.uid);
    if (mine) { member = { ...member, ...mine }; if (mine.status !== 'active') return blockedScreen(); }
    render();
  });
  if (canPrice()) api.watchInvoices(hid, (v) => { st.invoices = v; if (st.tab === 'in') render(); });
  const reRender = (k) => (v) => { st[k] = v; render(); };
  api.watchCol(hid, 'suppliers', reRender('suppliers'));
  api.watchCol(hid, 'requests', reRender('requests'));
  if (isManager()) { api.watchCol(hid, 'orders', reRender('orders')); api.watchCol(hid, 'payments', reRender('payments')); }
  if (member.role === 'owner') api.watchInvites(hid, (v) => { st.invites = v; if (st.tab === 'staff') render(); });
  render();
}

function render() {
  if ($('#screen').hidden) return;
  const low = st.items.filter(isLow).length + (isManager() ? openReqs().length : 0);
  const tabs = [['stock', '📦', '재고'], ['low', '🚨', isManager() ? '발주' : '부족'], ...(canInvoice() ? [['cam', '📷', '명세서']] : []), ...(canPrice() ? [['in', '🧾', '매입']] : []), ['log', '🕘', '이력'], ...(!canPrice() ? [['staff', '👤', '내 정보']] : [])];
  $('#tabsIn').style.gridTemplateColumns = `repeat(${tabs.length},1fr)`;
  $('#tabsIn').innerHTML = tabs.map(([k, i, t]) => `<button class="tab ${k === 'cam' ? 'cam' : ''} ${st.tab === k ? 'on' : ''}" data-t="${k}"><i>${i}</i>${t}${k === 'low' && low ? `<span class="cnt">${low}</span>` : ''}</button>`).join('');
  $('#tabsIn').onclick = (e) => { const b = e.target.closest('.tab'); if (!b) return; if (b.dataset.t === 'cam') return $('#camFile').click(); st.tab = b.dataset.t; render(); scrollTo(0, 0); };

  const keepFocus = document.activeElement?.id === 'q';
  const top = `<header class="top"><div class="top-in">
    <div class="t-logo"><small>SOBUMO</small>재고<span>한눈에</span></div>
    <div class="t-me" id="meBtn" role="button" title="${member.role === 'owner' ? '직원 관리' : '내 정보'}"><b>${esc(hospital?.name)} <span style="font-size:.8rem">${member.role === 'owner' ? '👥' : '⚙️'}</span></b><span class="live"></span>${esc(member.name)} · ${ROLE_SHORT[member.role]}</div>
  </div></header>`;
  const body = { stock: stockView, low: lowView, in: inView, log: logView, staff: member.role === 'owner' ? staffView : meView }[st.tab]();
  $('#screen').innerHTML = top + `<div class="page">${body}</div>` + (st.tab === 'stock' && isManager() ? `<button class="fab" id="add">＋ 품목 추가</button>` : '') + (isDemo ? demoBar() : '');
  bind();
  if (keepFocus) { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function itemRow(it) {
  const tag = it.qty === 0 ? '<span class="tag zero">품절</span>' : isLow(it) ? '<span class="tag low">부족</span>' : '';
  return `<button class="item ${isLow(it) ? 'low' : ''} ${st.flash.has(it.id) ? 'flash' : ''}" data-id="${it.id}">
    <div class="nm"><b>${esc(it.name)}${tag}</b><small>${esc(it.spec || '')}${it.spec ? ' · ' : ''}최소 ${fmt(it.minQty)}${esc(it.unit || '')}</small></div>
    <div class="q"><b>${fmt(it.qty)}</b><small>${esc(it.unit || '')}</small></div></button>`;
}

function stockView() {
  const q = st.q.trim().toLowerCase();
  const list = st.items.filter((x) => !q || (x.name + ' ' + (x.spec || '')).toLowerCase().includes(q));
  const low = st.items.filter(isLow).length;
  return `
  <div class="sum"><div><small>전체 품목</small><b>${st.items.length}</b></div><div class="warn"><small>부족 · 품절</small><b>${low}</b></div><div><small>오늘 변경</small><b>${st.logs.filter((l) => l.at > new Date(new Date().setHours(0, 0, 0, 0))).length}</b></div></div>
  <div class="search"><input class="in" id="q" placeholder="품목 검색 (예: 주사기, 거즈)" value="${esc(st.q)}"></div>
  <div class="list">${list.map(itemRow).join('') || `<div class="empty">${st.items.length ? '검색 결과가 없어요' : isManager() ? '아직 등록된 품목이 없어요.<br>아래 <b>＋ 품목 추가</b>로 시작하세요.' : '아직 등록된 품목이 없어요.<br>사무장님이나 원장님이 품목을 등록하면 여기에 보여요.'}`}</div>`;
}

function openReqs() { return st.requests.filter((r) => r.status === 'open'); }
const supName = (id) => st.suppliers.find((x) => x.id === id)?.name || '';
function suggestQty(it) { return Math.max(it.minQty * 2 - it.qty, it.minQty || 1, 1); }

function lowView() {
  const list = st.items.filter(isLow).sort((a, b) => a.qty / (a.minQty || 1) - b.qty / (b.minQty || 1));
  const reqs = openReqs();
  if (!isManager()) {
    const mine = reqs.filter((r) => r.byUid === user.uid);
    return `<p class="sec-t" style="margin-top:4px">최소 수량 이하인 품목 · 눌러서 수량 수정이나 발주 요청</p>
    <div class="list">${list.map(itemRow).join('') || '<div class="empty">👍 부족한 품목이 없어요</div>'}</div>
    ${mine.length ? `<p class="sec-t">내가 보낸 발주 요청 ${mine.length}건 · 사무장님 확인 대기</p>${mine.map(reqRow).join('')}` : ''}`;
  }
  // 사무장·원장: 요청 + 도매상별 발주 묶음
  const reqIds = new Set(reqs.map((r) => r.itemId));
  const need = new Map();
  list.forEach((it) => need.set(it.id, it));
  reqs.forEach((r) => { const it = st.items.find((x) => x.id === r.itemId); if (it) need.set(it.id, it); });
  const groups = {};
  need.forEach((it) => { const k = it.supplierId && supName(it.supplierId) ? it.supplierId : ''; (groups[k] ||= []).push(it); });
  const keys = Object.keys(groups).sort((a, b) => (a === '') - (b === '') || supName(a).localeCompare(supName(b), 'ko'));
  return `
  ${reqs.length ? `<p class="sec-t" style="margin-top:4px">직원 발주 요청 ${reqs.length}건</p>${reqs.map(reqRow).join('')}` : ''}
  <div class="row" style="margin:${reqs.length ? '20px' : '4px'} 2px 8px;align-items:center"><p class="sec-t" style="margin:0">도매상별 발주 목록</p><button class="btn" style="flex:none;min-height:36px;padding:0 14px;font-size:.82rem" id="supMgr">🏪 도매상 관리</button></div>
  ${keys.length ? keys.map((k) => orderGroup(k, groups[k], reqIds)).join('') : '<div class="empty">👍 발주할 품목이 없어요</div>'}
  ${st.orders.length ? `<p class="sec-t">최근 발주</p>${st.orders.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 10).map((o) => `<div class="log" style="margin-top:6px"><div class="ic">📦</div><div class="tx"><b>${esc(o.supplierName || '도매상 미지정')}</b> · ${o.lines.length}품목<small>${esc(o.byName || '')} · ${o.at ? ago(o.at) : ''}</small></div></div>`).join('')}` : ''}`;
}
function reqRow(r) {
  return `<div class="log" style="margin-top:6px"><div class="ic">📮</div><div class="tx"><b>${esc(r.itemName)}</b>${r.qty ? ` · ${fmt(r.qty)}${esc(r.unit || '')}` : ''}${r.memo ? ` <span style="color:var(--mid)">· ${esc(r.memo)}</span>` : ''}<small>${esc(r.byName)} 요청 · ${r.at ? ago(r.at) : ''}</small></div>${isManager() ? `<button class="btn" style="flex:none;min-height:34px;padding:0 12px;font-size:.78rem" data-reqdone="${r.id}">처리</button>` : ''}</div>`;
}
function orderGroup(k, items, reqIds) {
  const sup = st.suppliers.find((x) => x.id === k);
  return `<div class="card order-g" data-g="${k}" style="margin-top:10px;padding:14px">
    <div class="row" style="align-items:center"><div><b style="font-size:1.02rem">${sup ? esc(sup.name) : '도매상 미지정'}</b>${sup?.contact || sup?.phone ? `<div style="font-size:.78rem;color:var(--mute)">${esc(sup.contact || '')} ${esc(sup.phone || '')}</div>` : ''}${sup?.memo ? `<div style="font-size:.76rem;color:var(--mid)">${esc(sup.memo)}</div>` : ''}</div></div>
    ${!sup ? '<p class="s-sub" style="font-size:.78rem;margin-top:4px">품목을 눌러 [품목 정보 수정]에서 거래 도매상을 정해 두면 여기서 묶여요</p>' : ''}
    <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">${items.map((it) => `
      <label class="inv-line" style="cursor:pointer"><input type="checkbox" checked data-oi="${it.id}" style="width:20px;height:20px;flex:none">
        <div style="flex:1;min-width:0"><b>${esc(it.name)}</b>${reqIds.has(it.id) ? '<span class="tag" style="background:#E8EEF8;color:var(--blue-d)">요청</span>' : ''}<small>${esc(it.spec || '')} · 지금 ${fmt(it.qty)} / 최소 ${fmt(it.minQty)}</small></div>
        <input type="number" inputmode="numeric" min="1" class="in" data-oq="${it.id}" value="${suggestQty(it)}" style="width:76px;min-height:38px;text-align:right;padding:0 8px;flex:none"><span style="flex:none;font-size:.8rem;color:var(--mid)">${esc(it.unit || '')}</span>
      </label>`).join('')}</div>
    <div class="s-actions" style="margin-top:12px">
      <button class="btn" data-ocopy="${k}">📋 발주 문자 복사</button>
      ${sup?.phone ? `<button class="btn blue" data-osms="${k}">💬 문자 보내기</button>` : ''}
    </div>
  </div>`;
}
function orderText(k) {
  const g = document.querySelector(`.order-g[data-g="${k}"]`);
  const lines = [...g.querySelectorAll('[data-oi]')].filter((c) => c.checked).map((c) => {
    const it = st.items.find((x) => x.id === c.dataset.oi);
    const q = Math.max(1, parseInt(g.querySelector(`[data-oq="${it.id}"]`).value || '1', 10));
    return { itemId: it.id, name: it.name + (it.spec ? ' ' + it.spec : ''), qty: q, unit: it.unit || '' };
  });
  const text = `[${hospital.name}] 발주 요청드립니다.\n${lines.map((l) => `- ${l.name} ${fmt(l.qty)}${l.unit}`).join('\n')}\n감사합니다.`;
  return { lines, text };
}
async function recordOrder(k, lines) {
  const sup = st.suppliers.find((x) => x.id === k);
  await api.addTo(hid, 'orders', { supplierId: k, supplierName: sup?.name || '', lines, byName: member.name, status: 'ordered' });
  const ids = new Set(lines.map((l) => l.itemId));
  for (const r of openReqs().filter((r) => ids.has(r.itemId))) await api.updateIn(hid, 'requests', r.id, { status: 'done', doneBy: user.uid });
}
function bindOrder() {
  const sm = $('#supMgr'); if (sm) sm.onclick = () => supplierSheet();
  document.querySelectorAll('[data-reqdone]').forEach((b) => (b.onclick = async () => { try { await api.updateIn(hid, 'requests', b.dataset.reqdone, { status: 'done', doneBy: user.uid }); toast('처리했어요'); } catch (e) { toast(errMsg(e)); } }));
  document.querySelectorAll('[data-ocopy]').forEach((b) => (b.onclick = async () => {
    const { lines, text } = orderText(b.dataset.ocopy); if (!lines.length) return toast('발주할 품목을 골라 주세요');
    try { await navigator.clipboard.writeText(text); } catch { return sheet(`<h3>발주 문자</h3><div class="link-box" style="white-space:pre-wrap">${esc(text)}</div><p class="s-sub" style="margin-top:8px">길게 눌러 복사해 주세요</p>`); }
    try { await recordOrder(b.dataset.ocopy, lines); toast('발주 문자를 복사했어요 · 발주 기록 저장'); } catch (e) { toast(errMsg(e)); }
  }));
  document.querySelectorAll('[data-osms]').forEach((b) => (b.onclick = async () => {
    const k = b.dataset.osms, sup = st.suppliers.find((x) => x.id === k);
    const { lines, text } = orderText(k); if (!lines.length) return toast('발주할 품목을 골라 주세요');
    try { await recordOrder(k, lines); } catch (e) { return toast(errMsg(e)); }
    location.href = `sms:${(sup.phone || '').replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(text)}`;
  }));
}
function requestSheet(it) {
  const d = sheet(`<h3>발주 요청</h3><p class="s-sub">${esc(it.name)} ${esc(it.spec || '')} · 지금 ${fmt(it.qty)}${esc(it.unit || '')}</p>
    <label class="f">필요한 수량 (선택)</label><input class="in" id="rq" type="number" inputmode="numeric" min="0" value="${suggestQty(it)}">
    <label class="f">메모 (선택)</label><input class="in" id="rm" maxlength="60" placeholder="예: 다음 주 시술 많아요">
    <div class="s-actions"><button class="btn" id="rc">닫기</button><button class="btn blue" id="rs">요청 보내기</button></div>`);
  $('#rc', d).onclick = () => d.remove();
  $('#rs', d).onclick = async (e) => {
    e.target.disabled = true;
    try { await api.addTo(hid, 'requests', { itemId: it.id, itemName: it.name + (it.spec ? ' ' + it.spec : ''), unit: it.unit || '', qty: parseInt($('#rq', d).value || '0', 10) || 0, memo: $('#rm', d).value.trim(), byName: member.name, status: 'open' }); d.remove(); toast('사무장님께 발주 요청을 보냈어요'); }
    catch (err) { toast(errMsg(err)); e.target.disabled = false; }
  };
}
function supplierSheet(edit) {
  const d = sheet(`<h3>🏪 도매상 관리</h3>
    <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">${st.suppliers.map((x) => `<div class="inv-line"><div style="flex:1"><b>${esc(x.name)}</b><small>${esc(x.contact || '')} ${esc(x.phone || '')}${x.memo ? ' · ' + esc(x.memo) : ''}</small></div><button class="btn" style="flex:none;min-height:34px;padding:0 12px;font-size:.78rem" data-sedit="${x.id}">수정</button></div>`).join('') || '<p class="s-sub">아직 등록된 도매상이 없어요</p>'}</div>
    <p class="sec-t">${edit ? '도매상 수정' : '도매상 추가'}</p>
    <input class="in" id="sn" maxlength="60" placeholder="상호 (예: 대구메디칼)" value="${esc(edit?.name || '')}">
    <div class="row" style="margin-top:8px"><input class="in" id="sc" maxlength="20" placeholder="담당자" value="${esc(edit?.contact || '')}"><input class="in" id="sp" maxlength="20" inputmode="tel" placeholder="전화번호" value="${esc(edit?.phone || '')}"></div>
    <input class="in" id="sm" style="margin-top:8px" maxlength="80" placeholder="메모 (예: 오후 3시 전 주문 시 당일 배송)" value="${esc(edit?.memo || '')}">
    <div class="s-actions"><button class="btn" id="sx">닫기</button><button class="btn blue" id="ss">${edit ? '저장' : '추가'}</button></div>`);
  $('#sx', d).onclick = () => d.remove();
  d.querySelectorAll('[data-sedit]').forEach((b) => (b.onclick = () => { d.remove(); supplierSheet(st.suppliers.find((x) => x.id === b.dataset.sedit)); }));
  $('#ss', d).onclick = async () => {
    const f = { name: $('#sn', d).value.trim(), contact: $('#sc', d).value.trim(), phone: $('#sp', d).value.trim(), memo: $('#sm', d).value.trim() };
    if (!f.name) return toast('상호를 입력해 주세요');
    try { if (edit) await api.setIn(hid, 'suppliers', edit.id, f); else await api.addTo(hid, 'suppliers', f); d.remove(); toast('저장했어요'); supplierSheet(); }
    catch (e) { toast(errMsg(e)); }
  };
}

function logView() {
  if (!st.logs.length) return '<div class="empty">아직 변경 기록이 없어요</div>';
  return `<div class="log-wrap">${logList()}</div>`;
}
function logList() {
  let lastDay = '', out = '';
  for (const l of st.logs) {
    const d = l.at, day = `${d.getMonth() + 1}월 ${d.getDate()}일`;
    if (day !== lastDay) { out += `<div class="day">${day}</div>`; lastDay = day; }
    const icon = { create: '🆕', meta: '✏️', archive: '🗑️', delta: '🔢', set: '✍️', in: '🧾', undo: '↩️' }[l.type] || '🔢';
    const dl = l.delta ? `<span class="dl ${l.delta < 0 ? 'minus' : 'plus'}">${l.delta > 0 ? '+' : ''}${fmt(l.delta)}</span>` : '';
    const what = l.type === 'in' && l.isNewItem ? `명세서 입고 · 새 품목 (${fmt(l.after)})` : l.type === 'create' ? `품목 등록 (${fmt(l.after)})` : l.type === 'meta' ? '품목 정보 수정' : l.type === 'archive' ? '품목 삭제(보관)' : `${fmt(l.before)} → <b>${fmt(l.after)}</b>`;
    out += `<div class="log" style="margin-top:6px"><div class="ic">${icon}</div><div class="tx"><b>${esc(l.itemName)}</b><div style="font-size:.86rem">${what}${l.memo ? ` <span style="color:var(--mid)">· ${esc(l.memo)}</span>` : ''}</div><small>${esc(l.byName)} · ${ago(l.at)}</small></div>${dl}</div>`;
  }
  return out;
}

function memberRow(m, canEdit) {
  return `<div class="mem ${m.status === 'left' ? 'left' : ''}" style="margin-top:6px">
    <div class="av">${esc((m.name || '?').slice(0, 1))}</div>
    <div class="nm"><b>${esc(m.name)}</b><span class="role ${m.role}">${ROLE_SHORT[m.role]}</span>
      <small>${m.role === 'staff' && m.status === 'active' ? `${m.perms?.invoice ? '📷' : ''}${m.perms?.price ? '💰' : '🔒금액 숨김'} · ` : ''}${esc(m.title || '')}${m.title ? ' · ' : ''}${m.status === 'left' ? '퇴사' : m.joinedAt ? `${m.joinedAt.getFullYear()}.${m.joinedAt.getMonth() + 1}.${m.joinedAt.getDate()} 등록` : ''}</small></div>
    ${canEdit && m.role !== 'owner' ? `<button class="btn" style="min-height:38px;padding:0 14px;font-size:.84rem" data-mem="${m.uid}">관리</button>` : ''}</div>`;
}

function staffView() {
  const act = st.members.filter((m) => m.status === 'active'), left = st.members.filter((m) => m.status !== 'active');
  const order = { owner: 0, manager: 1, staff: 2 };
  act.sort((a, b) => order[a.role] - order[b.role]);
  const inv = st.invites.filter((i) => !i.expiresAt || i.expiresAt > new Date());
  return `
  <div class="card">
    <h2>직원 초대하기</h2>
    <p class="d">권한을 고르고 링크를 만들어 단톡방이나 문자로 보내세요. 링크는 <b>7일간</b> 유효하고, 받은 직원은 각자 구글 계정으로 들어옵니다.</p>
    <div class="row"><select class="in" id="invRole"><option value="staff">간호사·직원 권한</option><option value="manager">사무장·행정 권한</option></select></div>
    <input class="in" id="invTitle" style="margin-top:8px" placeholder="직책 (예: 간호사, 사무장)" maxlength="20">
    <div id="invPerms" style="margin-top:10px">${permBoxes('ip', { invoice: true, price: false })}</div>
    <button class="btn blue wide" id="mkInv">초대 링크 만들기</button>
    ${inv.length ? `<p class="sec-t" style="margin-top:16px">사용 가능한 초대 링크</p>${inv.map((i) => `<div class="step"><div class="num">${i.role === 'manager' ? '사' : '직'}</div><div style="flex:1;font-size:.86rem"><b>${ROLE[i.role]}</b>${i.title ? ` · ${esc(i.title)}` : ''}<br><small style="color:var(--mute)">${i.expiresAt ? `${i.expiresAt.getMonth() + 1}/${i.expiresAt.getDate()}까지` : ''}</small></div><button class="btn" style="min-height:36px;padding:0 12px;font-size:.8rem" data-share="${i.id}">보내기</button><button class="btn red" style="min-height:36px;padding:0 12px;font-size:.8rem" data-del="${i.id}">취소</button></div>`).join('')}` : ''}
  </div>
  <p class="sec-t">재직 중 ${act.length}명</p><div class="staff-grid">${act.map((m) => memberRow(m, true)).join('')}</div>
  ${left.length ? `<p class="sec-t">퇴사 ${left.length}명 · 접근 차단됨, 기록은 보존</p><div class="staff-grid">${left.map((m) => memberRow(m, true)).join('')}</div>` : ''}
  <p class="sec-t">권한 안내</p>
  <div class="card" style="font-size:.84rem;line-height:1.8;color:var(--mid)">
    <b style="color:var(--ink)">원장·최고관리자</b> 전체 조회, 직원 초대·권한·퇴사 처리<br>
    <b style="color:var(--ink)">사무장·행정</b> 품목 등록·수정·삭제, 최소 수량 설정, 재고 수정<br>
    <b style="color:var(--ink)">간호사·직원</b> 재고 검색, 수량 수정, 부족 확인, 발주 요청, 이력 조회<br>
    <span style="font-size:.8rem">└ 직원마다 📷 명세서 입고, 💰 금액 보기를 따로 켜고 끌 수 있어요. 금액 보기가 꺼진 직원에게는 매입 금액이 전혀 보이지 않아요.</span>
  </div>
  ${meBlock()}`;
}

function meBlock() {
  return `<p class="sec-t">내 정보</p><div class="card">
    <label class="f" style="margin-top:0">이름</label><input class="in" id="meName" maxlength="30" value="${esc(member.name)}">
    <label class="f">직책</label><input class="in" id="meTitle" maxlength="20" value="${esc(member.title || '')}">
    <div class="row" style="margin-top:14px"><button class="btn green" id="meSave">저장</button><button class="btn" id="out">로그아웃</button></div>
    <p class="lead" style="font-size:.76rem;margin-top:10px">${esc(user.email)} · ${ROLE[member.role]}</p>
  </div>
  <p class="foot-note" style="text-align:center;margin-top:24px">SOBUMO 재고한눈에 · by ALLAI GROUP</p>
  <p style="text-align:center;margin-top:6px;font-size:.76rem"><a href="/privacy.html" style="color:var(--mute)">개인정보처리방침 · 계정 삭제 요청</a></p>`;
}
function meView() { return `<p class="sec-t" style="margin-top:4px">${esc(hospital?.name)}</p>${st.members.filter((m) => m.status === 'active').map((m) => memberRow(m, false)).join('')}` + meBlock(); }

function demoBar() {
  return `<div style="position:fixed;bottom:calc(70px + env(safe-area-inset-bottom));left:12px;z-index:40;background:#1F2328;color:#fff;border-radius:999px;padding:6px 8px 6px 14px;font-size:.76rem;font-weight:800;display:flex;gap:6px;align-items:center;white-space:nowrap">데모 · 저장 안 됨
    ${['owner', 'manager', 'staff'].map((r) => `<a href="?demo=${r}" style="color:${member.role === r ? '#1F2328' : '#fff'};background:${member.role === r ? '#FFD54A' : 'rgba(255,255,255,.15)'};border-radius:999px;padding:3px 9px;text-decoration:none">${ROLE_SHORT[r]}</a>`).join('')}</div>`;
}

function bind() {
  const q = $('#q'); if (q) q.oninput = () => { st.q = q.value; render(); };
  document.querySelectorAll('.item').forEach((b) => (b.onclick = () => qtySheet(st.items.find((x) => x.id === b.dataset.id))));
  const add = $('#add'); if (add) add.onclick = () => itemSheet();
  bindIn();
  bindOrder();
  const mb = $('#meBtn'); if (mb) mb.onclick = () => { st.tab = 'staff'; render(); scrollTo(0, 0); };
  const out = $('#out'); if (out) out.onclick = () => api.signOut();
  const ms = $('#meSave'); if (ms) ms.onclick = async () => {
    const name = $('#meName').value.trim(); if (!name) return toast('이름을 입력해 주세요');
    try { await api.updateMember(hid, user.uid, { name, title: $('#meTitle').value.trim() }); member.name = name; toast('저장했어요'); render(); } catch (e) { toast(errMsg(e)); }
  };
  const mk = $('#mkInv'); if (mk) mk.onclick = async () => {
    mk.disabled = true;
    try { const role = $('#invRole').value; const code = await api.createInvite(hid, { role, title: $('#invTitle').value.trim(), hospitalName: hospital.name, perms: role === 'manager' ? { invoice: true, price: true } : readPerms('ip') }); shareInvite(code); }
    catch (e) { toast(errMsg(e)); } finally { mk.disabled = false; }
  };
  document.querySelectorAll('[data-share]').forEach((b) => (b.onclick = () => shareInvite(b.dataset.share)));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('이 초대 링크를 취소할까요?')) { try { await api.deleteInvite(hid, b.dataset.del); toast('취소했어요'); } catch (e) { toast(errMsg(e)); } } }));
  document.querySelectorAll('[data-mem]').forEach((b) => (b.onclick = () => memberSheet(st.members.find((m) => m.uid === b.dataset.mem))));
}

/* ── 시트(팝업) ── */
function sheet(html) {
  const d = document.createElement('div'); d.className = 'dim';
  d.innerHTML = `<div class="sheet">${html}</div>`;
  d.onclick = (e) => { if (e.target === d) d.remove(); };
  document.body.appendChild(d);
  return d;
}

function qtySheet(it) {
  if (!it) return;
  let typed = false, delta = 0;
  const d = sheet(`
    <h3>${esc(it.name)}</h3><p class="s-sub">${esc(it.spec || '')}${it.spec ? ' · ' : ''}지금 ${fmt(it.qty)}${esc(it.unit || '')} · 최소 ${fmt(it.minQty)}</p>
    <div class="qbig"><input id="qv" type="number" inputmode="numeric" min="0" value="${it.qty}"><span>${esc(it.unit || '')}</span></div>
    <div class="qdiff" id="qd">숫자를 눌러 남은 수량을 바로 입력할 수 있어요</div>
    <div class="qbtns"><button class="m" data-d="-10">−10</button><button class="m" data-d="-1">−1</button><button class="p" data-d="1">+1</button><button class="p" data-d="10">+10</button></div>
    <input class="in" id="qm" style="margin-top:12px" maxlength="60" placeholder="메모 (선택) 예: 시술 사용, 파손">
    <div class="s-actions"><button class="btn" id="qc">닫기</button><button class="btn blue" id="qs">저장</button></div>
    <button class="s-link" id="qr">📮 이 품목 발주 요청하기</button>
    ${isManager() ? '<button class="s-link" id="qe" style="margin-top:6px">품목 정보 수정 · 삭제</button>' : ''}`);
  $('#qr', d).onclick = () => { d.remove(); requestSheet(it); };
  const v = $('#qv', d), qd = $('#qd', d);
  const upd = () => {
    const n = Math.max(0, parseInt(v.value || '0', 10)); const diff = n - it.qty;
    qd.innerHTML = diff ? `${fmt(it.qty)} → <b style="color:var(--ink)">${fmt(n)}</b> <span class="dl ${diff < 0 ? 'minus' : 'plus'}">(${diff > 0 ? '+' : ''}${fmt(diff)})</span>` : '변경 없음';
  };
  v.oninput = () => { typed = true; upd(); };
  $('.qbtns', d).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const k = +b.dataset.d; v.value = Math.max(0, (parseInt(v.value || '0', 10)) + k); if (!typed) delta = parseInt(v.value, 10) - it.qty; upd(); };
  $('#qc', d).onclick = () => d.remove();
  const qe = $('#qe', d); if (qe) qe.onclick = () => { d.remove(); itemSheet(it); };
  $('#qs', d).onclick = async (e) => {
    const n = Math.max(0, parseInt(v.value || '0', 10));
    if (n === it.qty && !delta) return d.remove();
    e.target.disabled = true;
    // +/-만 눌렀으면 '변화량'으로 저장(동시 수정에도 안전), 숫자를 직접 쳤으면 '최종 수량'으로 저장
    let op = typed ? { mode: 'set', value: n } : { mode: 'delta', value: delta };
    try {
      if (!typed) op.value = n - it.qty;
      const r = await api.changeQty(hid, it.id, { ...op, memo: $('#qm', d).value.trim() }, member.name);
      d.remove(); toast(`${it.name} ${fmt(r.before)} → ${fmt(r.after)}`);
    } catch (err) { console.error(err); toast(errMsg(err)); e.target.disabled = false; }
  };
}

function itemSheet(it) {
  const isNew = !it;
  const d = sheet(`
    <h3>${isNew ? '품목 추가' : '품목 정보 수정'}</h3>
    <label class="f">품목명</label><input class="in" id="iN" maxlength="100" value="${esc(it?.name || '')}" placeholder="예) 주사기 3cc">
    <label class="f">규격 · 메모 (선택)</label><input class="in" id="iS" maxlength="60" value="${esc(it?.spec || '')}" placeholder="예) 23G · BD">
    <div class="row">
      <div><label class="f">단위</label><input class="in" id="iU" maxlength="10" value="${esc(it?.unit || '개')}"></div>
      <div><label class="f">최소 수량 (이하면 부족)</label><input class="in" id="iM" type="number" inputmode="numeric" min="0" value="${it?.minQty ?? 10}"></div>
    </div>
    <label class="f">박스 환산 (거래명세서 자동 입고에 사용 · 선택)</label>
    <div class="row" style="align-items:center;gap:6px"><span style="flex:none;font-weight:800">1</span><input class="in" id="iPU" maxlength="10" value="${esc(it?.packUnit || '')}" placeholder="박스"><span style="flex:none;font-weight:800">=</span><input class="in" id="iPQ" type="number" inputmode="numeric" min="0" value="${it?.packQty || ''}" placeholder="100"><span style="flex:none;color:var(--mid)" id="iPUu">${esc(it?.unit || '개')}</span></div>
    <label class="f">거래 도매상 (발주 묶음에 사용)</label>
    <select class="in" id="iSup"><option value="">미지정</option>${st.suppliers.map((x) => `<option value="${x.id}" ${it?.supplierId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    ${isNew ? '<label class="f">현재 수량</label><input class="in" id="iQ" type="number" inputmode="numeric" min="0" value="0">' : ''}
    <div class="s-actions"><button class="btn" id="ic">닫기</button><button class="btn blue" id="is">${isNew ? '추가' : '저장'}</button></div>
    ${isNew ? '' : '<button class="s-link" id="ix" style="color:var(--red)">이 품목 삭제 (기록은 보존)</button>'}`);
  $('#ic', d).onclick = () => d.remove();
  $('#is', d).onclick = async (e) => {
    const f = { name: $('#iN', d).value.trim(), spec: $('#iS', d).value.trim(), unit: $('#iU', d).value.trim(), minQty: Math.max(0, parseInt($('#iM', d).value || '0', 10)) };
    const pq = parseInt($('#iPQ', d).value || '0', 10), pu = $('#iPU', d).value.trim();
    if (pq > 0 && pu) { f.packQty = pq; f.packUnit = pu; } else if (!isNew) { f.packQty = 0; f.packUnit = ''; }
    f.supplierId = $('#iSup', d).value;
    if (!f.name) return toast('품목명을 입력해 주세요');
    e.target.disabled = true;
    try {
      if (isNew) { await api.addItem(hid, { ...f, qty: Math.max(0, parseInt($('#iQ', d).value || '0', 10)) }, member.name); toast('추가했어요'); }
      else { await api.editItem(hid, it.id, f, member.name); toast('저장했어요'); }
      d.remove();
    } catch (err) { console.error(err); toast(errMsg(err)); e.target.disabled = false; }
  };
  const ix = $('#ix', d); if (ix) ix.onclick = async () => {
    if (!confirm(`'${it.name}' 품목을 목록에서 삭제할까요?\n지금까지의 변경 기록은 그대로 남습니다.`)) return;
    try { await api.editItem(hid, it.id, { archived: true }, member.name, 'archive'); d.remove(); toast('삭제했어요'); } catch (err) { toast(errMsg(err)); }
  };
}

function memberSheet(m) {
  if (!m) return;
  const left = m.status !== 'active';
  const d = sheet(`
    <h3>${esc(m.name)}</h3><p class="s-sub">${esc(m.email || '')}</p>
    <label class="f">권한</label><select class="in" id="mR" ${left ? 'disabled' : ''}><option value="staff" ${m.role === 'staff' ? 'selected' : ''}>간호사·직원</option><option value="manager" ${m.role === 'manager' ? 'selected' : ''}>사무장·행정</option></select>
    <label class="f">직책</label><input class="in" id="mT" maxlength="20" value="${esc(m.title || '')}" ${left ? 'disabled' : ''}>
    ${left ? '' : `<div id="mPerms" style="margin-top:12px">${permBoxes('mp', m.perms || {})}</div>`}
    <div class="s-actions"><button class="btn" id="mc">닫기</button>${left ? '<button class="btn green" id="mBack">다시 재직 처리</button>' : '<button class="btn blue" id="ms">저장</button>'}</div>
    ${left ? '' : '<button class="s-link" id="mL" style="color:var(--red)">퇴사 처리 (즉시 접근 차단 · 기록은 보존)</button>'}`);
  const run = async (f, msg) => { try { await api.updateMember(hid, m.uid, f); d.remove(); toast(msg); } catch (e) { toast(errMsg(e)); } };
  $('#mc', d).onclick = () => d.remove();
  const ms = $('#ms', d); if (ms) ms.onclick = () => { const role = $('#mR', d).value; run({ role, title: $('#mT', d).value.trim(), perms: role === 'manager' ? { invoice: true, price: true } : readPerms('mp', d) }, '저장했어요'); };
  const ml = $('#mL', d); if (ml) ml.onclick = () => { if (confirm(`${m.name}님을 퇴사 처리할까요?\n이 직원은 바로 접근할 수 없게 됩니다.`)) run({ status: 'left' }, '퇴사 처리했어요'); };
  const mb = $('#mBack', d); if (mb) mb.onclick = () => run({ status: 'active' }, '다시 재직 처리했어요');
}

async function shareInvite(code) {
  const url = `${location.origin}${location.pathname}?join=${hid}_${code}`;
  const text = `[재고한눈에] ${hospital.name} 재고관리에 초대합니다.\n아래 링크를 눌러 구글 계정으로 시작해 주세요. (7일간 유효)\n${url}`;
  if (navigator.share) { try { await navigator.share({ title: '재고한눈에 초대', text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('초대 링크를 복사했어요. 단톡방에 붙여넣어 주세요'); }
  catch { sheet(`<h3>초대 링크</h3><div class="link-box">${esc(url)}</div><p class="s-sub" style="margin-top:8px">길게 눌러 복사해 주세요</p>`); }
}

/* ── 거래명세서 입고 ── */
const won = (n) => '₩' + fmt(Math.round(n || 0));
function monthTotal(off = 0) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth() + off;
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 1);
  return st.invoices.filter((v) => v.status === 'in' && v.at >= from && v.at < to).reduce((a, v) => a + (v.total || v.lines.reduce((s, l) => s + (l.amount || 0), 0)), 0);
}
function inView() {
  const list = st.invoices;
  return `
  ${canInvoice() ? `<button class="cta" style="width:100%" id="inCam">📷 명세서 찍기 / 사진 고르기</button><p class="s-sub" style="text-align:center;margin:6px 0 0;font-size:.78rem">아래 가운데 📷 버튼으로 어느 화면에서든 바로 찍을 수 있어요</p>` : ''}
  <div class="sum" style="margin-top:12px"><div><small>이번 달 매입</small><b>${won(monthTotal())}</b></div><div><small>지난달 매입</small><b>${won(monthTotal(-1))}</b></div><div><small>이번 달 명세서</small><b>${st.invoices.filter((v) => v.status === 'in' && v.at.getMonth() === new Date().getMonth() && v.at.getFullYear() === new Date().getFullYear()).length}건</b></div></div>
  ${monthBlock()}
  <p class="sec-t">최근 입고</p>
  <div class="list inv-list">${list.map((v) => `<button class="item inv ${v.status === 'undone' ? 'undone' : ''}" data-inv="${v.id}">
    <div class="nm"><b>${esc(canonSup(v.supplier))}${v.status === 'undone' ? '<span class="tag" style="background:#EEF0F2;color:var(--mid)">취소됨</span>' : v.lowCount ? `<span class="tag low">확인 ${v.lowCount}</span>` : ''}</b><small>${esc(v.date || '')} · ${v.lines.length}품목 · ${esc(v.byName || '')}</small></div>
    <div class="q"><b style="font-size:1.1rem">${won(v.total)}</b></div></button>`).join('') || '<div class="empty">아직 입고한 명세서가 없어요</div>'}</div>`;
}
function bindIn() {
  const ic = $('#inCam'); if (ic) ic.onclick = () => $('#camFile').click();
  document.querySelectorAll('[data-inv]').forEach((b) => (b.onclick = () => invoiceSheet(st.invoices.find((v) => v.id === b.dataset.inv))));
}
// 사진을 1600px 이하 JPEG로 줄여서 전송 (빠르고 저렴하게)
function shrink(file, max = 1600) {
  return new Promise((ok, bad) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => bad(new Error('사진을 열 수 없어요'));
    img.src = url;
  });
}
async function runInvoice(file) {
  const d = sheet(`<div style="text-align:center;padding:30px 0"><div class="spin"></div><h3 style="margin-top:16px">AI가 명세서를 읽고 있어요</h3><p class="s-sub" id="invStep">사진 준비 중…</p></div>`);
  d.onclick = null;
  try {
    const img = await shrink(file);
    $('#invStep', d).textContent = '품목·수량·금액 읽는 중… (10~20초)';
    const parsed = await api.readInvoice(img, st.items, st.suppliers.map((x) => ({ name: x.name, aliases: x.aliases || [] })));
    parsed.supplier = canonSup(parsed.supplier);
    if (!parsed.lines?.length) throw new Error('읽을 수 있는 품목이 없어요. 더 밝고 반듯하게 다시 찍어 주세요');
    $('#invStep', d).textContent = '재고에 반영하는 중…';
    const rec = await api.applyInvoice(hid, parsed, member.name);
    d.remove();
    invoiceSheet(rec, true);
  } catch (e) {
    console.error(e);
    d.querySelector('.sheet').innerHTML = `<h3>인식하지 못했어요</h3><p class="s-sub" style="margin-top:6px">${esc(e.message || '잠시 후 다시 시도해 주세요')}</p><div class="s-actions"><button class="btn" id="x">닫기</button></div>`;
    $('#x', d).onclick = () => d.remove();
  }
}
function invoiceSheet(v, fresh) {
  if (!v) return;
  const undone = v.status === 'undone';
  const d = sheet(`
    ${fresh ? '<p style="font-weight:900;color:var(--green);margin-bottom:6px">✓ 입고 완료</p>' : ''}
    <h3>${esc(canonSup(v.supplier))}${isManager() && v.status !== 'undone' ? ' <button class="s-link" id="vfix" style="display:inline;margin:0 0 0 6px;font-size:.78rem">✏️ 이름 고치기</button>' : ''}</h3>
    <p class="s-sub">${esc(v.date || '')} · ${v.lines.length}품목${canPrice() ? ' · 합계 ' + won(v.total) : ''}${undone ? ' · <b style="color:var(--red)">취소됨</b>' : ''}${v.editedBy ? ` · ✏️ ${esc(v.editedBy)} 수정` : ''}</p>
    ${!canPrice() ? '<p class="perm-note" style="margin-top:10px">🔒 금액은 병원 설정에 따라 표시되지 않아요. 품목과 수량만 확인해 주세요.</p>' : ''}
    ${v.lowCount && !undone ? `<p class="notice" style="margin-top:12px">노란 줄 ${v.lowCount}개는 AI가 확신하지 못한 부분이에요. 맞는지 한 번 봐 주세요. ${isManager() ? '틀렸으면 아래 [✏️ 수정]으로 고치면 재고까지 같이 맞춰져요.' : '틀렸으면 사무장님께 알려 주세요. 수량은 재고 탭에서 바로 고칠 수도 있어요.'}</p>` : ''}
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">${v.lines.map((l) => `
      <div class="inv-line ${l.confidence === 'low' ? 'low' : ''}">
        <div style="flex:1;min-width:0"><b>${esc(l.itemName || l.name)}</b>${l.isNew ? '<span class="tag" style="background:#E8EEF8;color:var(--blue-d)">새 품목</span>' : ''}
          <small>명세서: ${esc(l.name)}${l.spec ? ' ' + esc(l.spec) : ''} · ${fmt(l.qty)}${esc(l.unit || '')}${canPrice() && l.unitPrice ? ' × ' + fmt(l.unitPrice) : ''}${l.note ? ' · ⚠ ' + esc(l.note) : ''}</small></div>
        <div style="text-align:right;flex:none"><b class="dl plus">+${fmt(l.applied)}</b><small>${canPrice() && l.amount ? won(l.amount) : ''}</small></div>
      </div>`).join('')}</div>
    <div class="s-actions"><button class="btn" id="vc">닫기</button>${undone || !isManager() ? '' : '<button class="btn blue" id="ve">✏️ 수정</button>'}</div>
    ${undone || !isManager() ? '' : '<button class="s-link" id="vu" style="color:var(--red)">↩ 이 명세서 입고 통째로 되돌리기</button>'}
    <p class="s-sub" style="text-align:center;margin-top:10px;font-size:.74rem">AI 인식 결과의 확인 책임은 사용자에게 있습니다</p>`);
  $('#vc', d).onclick = () => d.remove();
  const vf = $('#vfix', d); if (vf) vf.onclick = () => { d.remove(); fixSupplierSheet(v.supplier); };
  const ve = $('#ve', d); if (ve) ve.onclick = () => { d.remove(); editInvoiceSheet(v); };
  const vu = $('#vu', d); if (vu) vu.onclick = async () => {
    if (!confirm('이 명세서로 들어간 수량을 모두 빼고 입고를 취소할까요?\n(취소 기록도 이력에 남습니다)')) return;
    vu.disabled = true;
    try { await api.undoInvoice(hid, v, member.name); d.remove(); toast('입고를 되돌렸어요'); } catch (e) { toast(e.message || errMsg(e)); vu.disabled = false; }
  };
}

/* ── 월별 매입·결제 ── */
const payId = (ym, k) => `${ym}_${k.replace(/[\/.#$\[\]]/g, '_')}`.slice(0, 200);
const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function monthBlock() {
  const months = [...new Set([ymOf(new Date()), ...st.invoices.map((v) => ymOf(v.at))])].sort().reverse();
  const ym = st.month && months.includes(st.month) ? st.month : months[0];
  const rows = {};
  st.invoices.filter((v) => v.status === 'in' && ymOf(v.at) === ym).forEach((v) => {
    const k = canonSup(v.supplier);
    (rows[k] ||= { total: 0, n: 0 }); rows[k].total += v.total || 0; rows[k].n++;
  });
  const names = Object.keys(rows).sort((a, b) => rows[b].total - rows[a].total);
  const paid = (k) => st.payments.find((p) => p.id === payId(ym, k))?.paid;
  const sum = names.reduce((a, k) => a + rows[k].total, 0), unpaid = names.filter((k) => !paid(k)).reduce((a, k) => a + rows[k].total, 0);
  return `<div class="row" style="margin:20px 2px 8px;align-items:center"><p class="sec-t" style="margin:0">월별 매입 · 결제</p>
    <select class="in" id="ymSel" style="flex:none;width:auto;min-height:36px;padding:0 10px;font-size:.86rem">${months.map((m) => `<option ${m === ym ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
  <div class="card" style="padding:12px 14px">
    ${names.length ? names.map((k) => `<label class="pay-row"><div style="flex:1;min-width:0"><b>${esc(k)}</b><small>${rows[k].n}건</small></div><b style="flex:none">${won(rows[k].total)}</b>
      <span class="pay-chk ${paid(k) ? 'on' : ''}"><input type="checkbox" data-pay="${esc(k)}" data-ym="${ym}" ${paid(k) ? 'checked' : ''}> ${paid(k) ? '결제 완료' : '미결제'}</span></label>`).join('') : '<p class="s-sub" style="padding:8px 0">이 달 매입 기록이 없어요</p>'}
    ${names.length ? `<div class="row" style="border-top:1px solid var(--line);margin-top:8px;padding-top:10px;font-size:.88rem"><span>합계 <b>${won(sum)}</b></span><span style="text-align:right;color:${unpaid ? 'var(--red)' : 'var(--green)'}">미결제 <b>${won(unpaid)}</b></span></div>` : ''}
  </div>`;
}
document.addEventListener('change', async (e) => {
  if (e.target.id === 'ymSel') { st.month = e.target.value; render(); return; }
  const c = e.target.closest?.('[data-pay]'); if (!c) return;
  try { await api.setIn(hid, 'payments', payId(c.dataset.ym, c.dataset.pay), { month: c.dataset.ym, supplier: c.dataset.pay, paid: c.checked }); toast(c.checked ? '결제 완료로 표시했어요' : '미결제로 바꿨어요'); }
  catch (err) { toast(errMsg(err)); c.checked = !c.checked; }
});

/* ── 도매상 이름 보정: AI가 잘못 읽은 이름(aliases)을 등록된 도매상 이름으로 ── */
function canonSup(name) {
  const n = (name || '').trim();
  if (!n) return '거래처 미확인';
  const norm = (x) => (x || '').replace(/\s|\(주\)|㈜|주식회사/g, '');
  const hit = st.suppliers.find((x) => norm(x.name) === norm(n) || (x.aliases || []).some((a) => norm(a) === norm(n)));
  return hit ? hit.name : n;
}
function fixSupplierSheet(wrong) {
  const cur = canonSup(wrong);
  const d = sheet(`<h3>거래처 이름 고치기</h3><p class="s-sub">AI가 읽은 이름: <b>${esc(wrong || '(없음)')}</b></p>
    <label class="f">올바른 거래처 이름</label><input class="in" id="fx" maxlength="60" value="${esc(cur === '거래처 미확인' ? '' : cur)}" placeholder="예: (주)무화약품" list="supList">
    <datalist id="supList">${st.suppliers.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
    <p class="s-sub" style="margin-top:8px;font-size:.78rem">한 번 고쳐 두면 앞으로 AI가 같은 이름으로 잘못 읽어도 자동으로 바로잡아요. 지난 명세서와 월별 매입에도 바로 반영됩니다.</p>
    <div class="s-actions"><button class="btn" id="fc">닫기</button><button class="btn blue" id="fs">저장</button></div>`);
  $('#fc', d).onclick = () => d.remove();
  $('#fs', d).onclick = async (e) => {
    const name = $('#fx', d).value.trim(); if (!name) return toast('거래처 이름을 입력해 주세요');
    e.target.disabled = true;
    try {
      const ex = st.suppliers.find((x) => x.name === name);
      const add = wrong && wrong.trim() !== name ? [wrong.trim()] : [];
      if (ex) await api.setIn(hid, 'suppliers', ex.id, { name: ex.name, aliases: [...new Set([...(ex.aliases || []), ...add])].slice(-20) });
      else await api.addTo(hid, 'suppliers', { name, contact: '', phone: '', memo: '', aliases: add });
      d.remove(); toast(`'${name}'(으)로 고쳤어요`);
    } catch (err) { toast(errMsg(err)); e.target.disabled = false; }
  };
}

/* ── 직원별 권한 (초대할 때 / 직원 관리에서) ── */
function permBoxes(pre, p) {
  return `<p class="s-sub" style="font-size:.8rem;margin-bottom:4px">간호사·직원 권한일 때만 적용 (사무장은 항상 전부 가능)</p>
  <label class="perm"><input type="checkbox" id="${pre}Inv" ${p.invoice ? 'checked' : ''}> 📷 거래명세서 찍어서 입고하기</label>
  <label class="perm"><input type="checkbox" id="${pre}Price" ${p.price ? 'checked' : ''}> 💰 단가·금액·매입 합계 보기</label>
  <p class="perm-note">🔒 금액 보기를 끄면 이 직원 화면에는 <b>단가·금액·매입 합계·매입 탭이 아예 나오지 않아요.</b> 명세서를 찍어도 품목과 수량만 보입니다. 데이터 자체를 읽을 수 없게 막혀 있어서 안심하셔도 됩니다.</p>`;
}
function readPerms(pre, root = document) { return { invoice: !!$(`#${pre}Inv`, root)?.checked, price: !!$(`#${pre}Price`, root)?.checked }; }

/* ── 어느 화면에서든 가운데 📷 버튼으로 명세서 입고 ── */
(function camInput() {
  const f = document.createElement('input');
  f.type = 'file'; f.accept = 'image/*'; f.id = 'camFile'; f.hidden = true;
  f.onchange = () => { const file = f.files[0]; f.value = ''; if (file) runInvoice(file); };
  document.body.appendChild(f);
})();

/* ── 명세서 수정 (사무장·원장) ── */
function editInvoiceSheet(v) {
  const d = sheet(`<h3>✏️ 명세서 수정</h3><p class="s-sub">입고 수량을 고치면 차이만큼 재고도 같이 맞춰지고, 이력에 남아요.</p>
    <div class="row" style="margin-top:10px"><div><label class="f" style="margin-top:0">거래처</label><input class="in" id="eS" maxlength="60" value="${esc(canonSup(v.supplier) === '거래처 미확인' ? '' : canonSup(v.supplier))}"></div>
      <div style="flex:none;width:150px"><label class="f" style="margin-top:0">거래일자</label><input class="in" id="eD" type="date" value="${esc(v.date || '')}"></div></div>
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">${v.lines.map((l, i) => `
      <div class="inv-line" style="flex-wrap:wrap">
        <div style="flex:1 1 100%"><b>${esc(l.itemName || l.name)}</b><small>명세서: ${esc(l.name)} ${esc(l.spec || '')} · ${fmt(l.qty)}${esc(l.unit || '')}</small></div>
        <label class="ef">입고 수량<input class="in" type="number" inputmode="numeric" min="0" data-ea="${i}" value="${l.applied || 0}"></label>
        <label class="ef">단가<input class="in" type="number" inputmode="numeric" min="0" data-eu="${i}" value="${l.unitPrice || 0}"></label>
        <label class="ef">금액<input class="in" type="number" inputmode="numeric" min="0" data-em="${i}" value="${l.amount || 0}"></label>
      </div>`).join('')}</div>
    <label class="f">합계 (부가세 포함)</label><input class="in" id="eT" type="number" inputmode="numeric" min="0" value="${v.total || 0}">
    <div class="s-actions"><button class="btn" id="ec">닫기</button><button class="btn blue" id="es">저장</button></div>`);
  $('#ec', d).onclick = () => d.remove();
  $('#es', d).onclick = async (e) => {
    const num = (sel) => Math.max(0, parseInt($(sel, d).value || '0', 10) || 0);
    const lines = v.lines.map((l, i) => ({ ...l, applied: num(`[data-ea="${i}"]`), unitPrice: num(`[data-eu="${i}"]`), amount: num(`[data-em="${i}"]`), confidence: 'high', note: '' }));
    const upd = { supplier: $('#eS', d).value.trim(), date: $('#eD', d).value, total: num('#eT'), lines };
    e.target.disabled = true;
    try { await api.editInvoice(hid, v, upd, member.name); d.remove(); toast('명세서를 고쳤어요'); }
    catch (err) { console.error(err); toast(err.message?.includes('permission') ? '권한이 없어요 (보안 규칙 게시 필요)' : (err.message || errMsg(err))); e.target.disabled = false; }
  };
}
