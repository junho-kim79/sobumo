import { createApi, configured, isDemo } from './data.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE = { owner: '원장·최고관리자', manager: '사무장·행정', staff: '간호사·직원' };
const ROLE_SHORT = { owner: '원장', manager: '사무장', staff: '직원' };
const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');

let api, user, hid, hospital, member;
const st = { items: [], logs: [], members: [], invites: [], tab: 'stock', q: '', flash: new Set() };

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
const errMsg = (e) => (String(e?.code || e?.message || e).includes('permission') ? '권한이 없습니다' : '저장하지 못했어요. 잠시 후 다시 시도해 주세요');

/* ── 초대 링크 파라미터 ?join=병원ID_코드 ── */
const joinParam = new URLSearchParams(location.search).get('join');
const [joinHid, joinCode] = joinParam ? joinParam.split('_') : [];

/* ── 시작 ── */
(async function boot() {
  if (!configured) { show('landing'); $('#cfgInfo').hidden = false; $('#startBtn').disabled = true; return; }
  api = await createApi();
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
    try { await api.joinByInvite(joinHid, joinCode, { name, title: $('#myTitle').value.trim(), role: inv.role }); done(); location.reload(); }
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
  if (member.role === 'owner') api.watchInvites(hid, (v) => { st.invites = v; if (st.tab === 'staff') render(); });
  render();
}

function render() {
  if ($('#screen').hidden) return;
  const low = st.items.filter(isLow).length;
  const tabs = [['stock', '📦', '재고'], ['low', '🚨', '부족'], ['log', '🕘', '이력'], ['staff', member.role === 'owner' ? '👥' : '👤', member.role === 'owner' ? '직원' : '내 정보']];
  $('#tabsIn').innerHTML = tabs.map(([k, i, t]) => `<button class="tab ${st.tab === k ? 'on' : ''}" data-t="${k}"><i>${i}</i>${t}${k === 'low' && low ? `<span class="cnt">${low}</span>` : ''}</button>`).join('');
  $('#tabsIn').onclick = (e) => { const b = e.target.closest('.tab'); if (b) { st.tab = b.dataset.t; render(); scrollTo(0, 0); } };

  const keepFocus = document.activeElement?.id === 'q';
  const top = `<header class="top"><div class="top-in">
    <div class="t-logo"><small>SOBUMO</small>재고<span>한눈에</span></div>
    <div class="t-me"><b>${esc(hospital?.name)}</b><span class="live"></span>${esc(member.name)} · ${ROLE_SHORT[member.role]}</div>
  </div></header>`;
  const body = { stock: stockView, low: lowView, log: logView, staff: member.role === 'owner' ? staffView : meView }[st.tab]();
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

function lowView() {
  const list = st.items.filter(isLow).sort((a, b) => a.qty / (a.minQty || 1) - b.qty / (b.minQty || 1));
  return `<p class="sec-t" style="margin-top:4px">최소 수량 이하인 품목 · 많이 모자란 순</p>
  <div class="list">${list.map(itemRow).join('') || '<div class="empty">👍 부족한 품목이 없어요</div>'}</div>
  ${list.length ? '<p class="lead" style="text-align:center;margin-top:16px;font-size:.8rem">통합 발주 기능은 다음 단계에서 추가됩니다</p>' : ''}`;
}

function logView() {
  if (!st.logs.length) return '<div class="empty">아직 변경 기록이 없어요</div>';
  let lastDay = '', out = '';
  for (const l of st.logs) {
    const d = l.at, day = `${d.getMonth() + 1}월 ${d.getDate()}일`;
    if (day !== lastDay) { out += `<div class="day">${day}</div>`; lastDay = day; }
    const icon = { create: '🆕', meta: '✏️', archive: '🗑️', delta: '🔢', set: '✍️' }[l.type] || '🔢';
    const dl = l.delta ? `<span class="dl ${l.delta < 0 ? 'minus' : 'plus'}">${l.delta > 0 ? '+' : ''}${fmt(l.delta)}</span>` : '';
    const what = l.type === 'create' ? `품목 등록 (${fmt(l.after)})` : l.type === 'meta' ? '품목 정보 수정' : l.type === 'archive' ? '품목 삭제(보관)' : `${fmt(l.before)} → <b>${fmt(l.after)}</b>`;
    out += `<div class="log" style="margin-top:6px"><div class="ic">${icon}</div><div class="tx"><b>${esc(l.itemName)}</b><div style="font-size:.86rem">${what}${l.memo ? ` <span style="color:var(--mid)">· ${esc(l.memo)}</span>` : ''}</div><small>${esc(l.byName)} · ${ago(l.at)}</small></div>${dl}</div>`;
  }
  return out;
}

function memberRow(m, canEdit) {
  return `<div class="mem ${m.status === 'left' ? 'left' : ''}" style="margin-top:6px">
    <div class="av">${esc((m.name || '?').slice(0, 1))}</div>
    <div class="nm"><b>${esc(m.name)}</b><span class="role ${m.role}">${ROLE_SHORT[m.role]}</span>
      <small>${esc(m.title || '')}${m.title ? ' · ' : ''}${m.status === 'left' ? '퇴사' : m.joinedAt ? `${m.joinedAt.getFullYear()}.${m.joinedAt.getMonth() + 1}.${m.joinedAt.getDate()} 등록` : ''}</small></div>
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
    <button class="btn blue wide" id="mkInv">초대 링크 만들기</button>
    ${inv.length ? `<p class="sec-t" style="margin-top:16px">사용 가능한 초대 링크</p>${inv.map((i) => `<div class="step"><div class="num">${i.role === 'manager' ? '사' : '직'}</div><div style="flex:1;font-size:.86rem"><b>${ROLE[i.role]}</b>${i.title ? ` · ${esc(i.title)}` : ''}<br><small style="color:var(--mute)">${i.expiresAt ? `${i.expiresAt.getMonth() + 1}/${i.expiresAt.getDate()}까지` : ''}</small></div><button class="btn" style="min-height:36px;padding:0 12px;font-size:.8rem" data-share="${i.id}">보내기</button><button class="btn red" style="min-height:36px;padding:0 12px;font-size:.8rem" data-del="${i.id}">취소</button></div>`).join('')}` : ''}
  </div>
  <p class="sec-t">재직 중 ${act.length}명</p>${act.map((m) => memberRow(m, true)).join('')}
  ${left.length ? `<p class="sec-t">퇴사 ${left.length}명 · 접근 차단됨, 기록은 보존</p>${left.map((m) => memberRow(m, true)).join('')}` : ''}
  <p class="sec-t">권한 안내</p>
  <div class="card" style="font-size:.84rem;line-height:1.8;color:var(--mid)">
    <b style="color:var(--ink)">원장·최고관리자</b> 전체 조회, 직원 초대·권한·퇴사 처리<br>
    <b style="color:var(--ink)">사무장·행정</b> 품목 등록·수정·삭제, 최소 수량 설정, 재고 수정<br>
    <b style="color:var(--ink)">간호사·직원</b> 재고 검색, 수량 수정, 부족 확인, 이력 조회
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
  <p class="foot-note" style="text-align:center;margin-top:24px">SOBUMO 재고한눈에 · by ALLAI GROUP</p>`;
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
  const out = $('#out'); if (out) out.onclick = () => api.signOut();
  const ms = $('#meSave'); if (ms) ms.onclick = async () => {
    const name = $('#meName').value.trim(); if (!name) return toast('이름을 입력해 주세요');
    try { await api.updateMember(hid, user.uid, { name, title: $('#meTitle').value.trim() }); member.name = name; toast('저장했어요'); render(); } catch (e) { toast(errMsg(e)); }
  };
  const mk = $('#mkInv'); if (mk) mk.onclick = async () => {
    mk.disabled = true;
    try { const code = await api.createInvite(hid, { role: $('#invRole').value, title: $('#invTitle').value.trim(), hospitalName: hospital.name }); shareInvite(code); }
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
    ${isManager() ? '<button class="s-link" id="qe">품목 정보 수정 · 삭제</button>' : ''}`);
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
    ${isNew ? '<label class="f">현재 수량</label><input class="in" id="iQ" type="number" inputmode="numeric" min="0" value="0">' : ''}
    <div class="s-actions"><button class="btn" id="ic">닫기</button><button class="btn blue" id="is">${isNew ? '추가' : '저장'}</button></div>
    ${isNew ? '' : '<button class="s-link" id="ix" style="color:var(--red)">이 품목 삭제 (기록은 보존)</button>'}`);
  $('#ic', d).onclick = () => d.remove();
  $('#is', d).onclick = async (e) => {
    const f = { name: $('#iN', d).value.trim(), spec: $('#iS', d).value.trim(), unit: $('#iU', d).value.trim(), minQty: Math.max(0, parseInt($('#iM', d).value || '0', 10)) };
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
    <div class="s-actions"><button class="btn" id="mc">닫기</button>${left ? '<button class="btn green" id="mBack">다시 재직 처리</button>' : '<button class="btn blue" id="ms">저장</button>'}</div>
    ${left ? '' : '<button class="s-link" id="mL" style="color:var(--red)">퇴사 처리 (즉시 접근 차단 · 기록은 보존)</button>'}`);
  const run = async (f, msg) => { try { await api.updateMember(hid, m.uid, f); d.remove(); toast(msg); } catch (e) { toast(errMsg(e)); } };
  $('#mc', d).onclick = () => d.remove();
  const ms = $('#ms', d); if (ms) ms.onclick = () => run({ role: $('#mR', d).value, title: $('#mT', d).value.trim() }, '저장했어요');
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
