// 데이터 계층: Firebase(실제) / 데모(브라우저 메모리, ?demo=1)
import { firebaseConfig } from './firebase-config.js';

const V = '10.14.1';
const INVITE_DAYS = 7;

export const isDemo = new URLSearchParams(location.search).has('demo');
export const configured = !!firebaseConfig || isDemo;

function randCode(n = 20) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(r, (x) => a[x % a.length]).join('');
}


// 명세서 줄을 '기존 품목 입고'와 '새 품목'으로 나눔 (같은 품목 여러 줄은 합침)
export function planInvoice(inv) {
  const matched = {}, created = [];
  for (const l of inv.lines || []) {
    if (l.matchId) { (matched[l.matchId] ||= { qty: 0, lines: [] }); matched[l.matchId].qty += l.baseQty; matched[l.matchId].lines.push(l); }
    else created.push(l);
  }
  return { matched, created };
}
function groupNew(lines) {
  const m = new Map();
  for (const l of lines) {
    const k = (l.name + '|' + (l.spec || '')).replace(/\s+/g, '');
    if (!m.has(k)) m.set(k, { name: l.name, spec: l.spec || '', unit: l.unit, qty: 0, lines: [] });
    const g = m.get(k); g.qty += l.baseQty; g.lines.push(l);
  }
  return [...m.values()];
}

/* ───────────────────────── Firebase ───────────────────────── */
async function firebaseApi() {
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  const F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  const { doc, collection, getDoc, onSnapshot, writeBatch, runTransaction, serverTimestamp, query, orderBy, limit, Timestamp, deleteDoc } = F;
  const H = (hid, ...p) => doc(db, 'hospitals', hid, ...p);
  const C = (hid, name) => collection(db, 'hospitals', hid, name);
  const ts = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
  const withId = (s) => ({ id: s.id, ...s.data() });
  let me = null;

  return {
    onAuth(cb) {
      A.getRedirectResult(auth).catch(() => {});
      A.onAuthStateChanged(auth, (u) => {
        me = u ? { uid: u.uid, name: u.displayName || '', email: u.email || '' } : null;
        cb(me);
      });
    },
    async signIn() {
      const p = new A.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      try { await A.signInWithPopup(auth, p); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) return A.signInWithRedirect(auth, p);
        if (e.code !== 'auth/popup-closed-by-user') throw e;
      }
    },
    signOut: () => A.signOut(auth),
    async getUserHospital(uid) { const s = await getDoc(doc(db, 'users', uid)); return s.exists() ? s.data().hospitalId || null : null; },
    async getHospital(hid) { const s = await getDoc(H(hid)); return s.exists() ? withId(s) : null; },
    async getMember(hid, uid) {
      try { const s = await getDoc(H(hid, 'members', uid)); return s.exists() ? withId(s) : null; }
      catch { return { status: 'left' }; } // 읽기 권한이 없으면 = 퇴사 처리됨
    },
    async createHospital({ name, myName, title }) {
      const ref = doc(collection(db, 'hospitals'));
      const b = writeBatch(db);
      b.set(ref, { name, ownerUid: me.uid, createdAt: serverTimestamp() });
      b.set(doc(ref, 'members', me.uid), { uid: me.uid, name: myName, title, email: me.email, role: 'owner', status: 'active', joinedAt: serverTimestamp() });
      b.set(doc(db, 'users', me.uid), { hospitalId: ref.id });
      await b.commit();
      return ref.id;
    },
    async getInvite(hid, code) {
      const s = await getDoc(H(hid, 'invites', code));
      if (!s.exists()) return null;
      const d = s.data();
      return { ...d, expiresAt: ts(d.expiresAt) };
    },
    async joinByInvite(hid, code, { name, title, role }) {
      const b = writeBatch(db);
      b.set(H(hid, 'members', me.uid), { uid: me.uid, name, title, email: me.email, role, status: 'active', joinedAt: serverTimestamp(), inviteCode: code });
      b.set(doc(db, 'users', me.uid), { hospitalId: hid });
      await b.commit();
    },
    watchItems(hid, cb) {
      return onSnapshot(C(hid, 'items'), (s) => cb(s.docs.map(withId).filter((x) => !x.archived)));
    },
    watchLogs(hid, cb) {
      return onSnapshot(query(C(hid, 'logs'), orderBy('at', 'desc'), limit(300)), (s) =>
        cb(s.docs.map((d) => ({ ...withId(d), at: ts(d.data().at) || new Date() }))));
    },
    watchMembers(hid, cb) {
      return onSnapshot(C(hid, 'members'), (s) => cb(s.docs.map((d) => ({ ...withId(d), joinedAt: ts(d.data().joinedAt) }))));
    },
    watchInvites(hid, cb) {
      return onSnapshot(C(hid, 'invites'), (s) => cb(s.docs.map((d) => ({ ...withId(d), expiresAt: ts(d.data().expiresAt) }))), () => cb([]));
    },
    // 품목 추가 (이력 함께)
    async addItem(hid, it, myName) {
      const ref = doc(C(hid, 'items'));
      const log = doc(C(hid, 'logs'));
      const b = writeBatch(db);
      b.set(log, { itemId: ref.id, itemName: it.name, before: 0, after: it.qty, delta: it.qty, type: 'create', byUid: me.uid, byName: myName, at: serverTimestamp() });
      b.set(ref, { name: it.name, spec: it.spec, unit: it.unit, minQty: it.minQty, qty: it.qty, archived: false, updatedAt: serverTimestamp(), updatedBy: me.uid, lastLogId: log.id });
      await b.commit();
    },
    // 수량 변경: mode 'set'(직접 입력) / 'delta'(+/-) — 트랜잭션으로 최신값 기준 처리
    async changeQty(hid, id, { mode, value, memo }, myName) {
      return runTransaction(db, async (tx) => {
        const ref = H(hid, 'items', id);
        const s = await tx.get(ref);
        if (!s.exists()) throw new Error('품목이 없습니다');
        const before = s.data().qty;
        const after = Math.max(0, mode === 'set' ? value : before + value);
        if (after === before) return { before, after };
        const log = doc(C(hid, 'logs'));
        tx.set(log, { itemId: id, itemName: s.data().name, before, after, delta: after - before, type: mode, memo: memo || '', byUid: me.uid, byName: myName, at: serverTimestamp() });
        tx.update(ref, { qty: after, updatedAt: serverTimestamp(), updatedBy: me.uid, lastLogId: log.id });
        return { before, after };
      });
    },
    // 품목 정보 수정 / 보관(삭제 대신)
    async editItem(hid, id, fields, myName, type = 'meta') {
      return runTransaction(db, async (tx) => {
        const ref = H(hid, 'items', id);
        const s = await tx.get(ref);
        const cur = s.data();
        const log = doc(C(hid, 'logs'));
        tx.set(log, { itemId: id, itemName: fields.name || cur.name, before: cur.qty, after: cur.qty, delta: 0, type, memo: fields._memo || '', byUid: me.uid, byName: myName, at: serverTimestamp() });
        const { _memo, ...rest } = fields;
        tx.update(ref, { ...rest, updatedAt: serverTimestamp(), updatedBy: me.uid, lastLogId: log.id });
      });
    },
    async createInvite(hid, { role, title, hospitalName }) {
      const code = randCode();
      const b = writeBatch(db);
      b.set(H(hid, 'invites', code), { role, title, hospitalName, createdBy: me.uid, createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + INVITE_DAYS * 864e5) });
      await b.commit();
      return code;
    },
    deleteInvite: (hid, code) => deleteDoc(H(hid, 'invites', code)),
    // ── 거래명세서 ──
    async readInvoice(image, items, suppliers = []) {
      const token = await auth.currentUser.getIdToken();
      const r = await fetch('/api/invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ image, suppliers, items: items.map(({ id, name, spec, unit, packQty, packUnit, aliases }) => ({ id, name, spec, unit, packQty, packUnit, aliases })) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || '인식하지 못했어요');
      return j;
    },
    async applyInvoice(hid, inv, myName) {
      return runTransaction(db, async (tx) => {
        const plan = planInvoice(inv);
        const snaps = {};
        for (const id of Object.keys(plan.matched)) snaps[id] = await tx.get(H(hid, 'items', id));
        const invRef = doc(C(hid, 'invoices'));
        const lines = [];
        for (const [id, g] of Object.entries(plan.matched)) {
          const s = snaps[id];
          if (!s.exists()) { plan.created.push(...g.lines); continue; }
          const cur = s.data(), before = cur.qty, after = before + g.qty;
          const log = doc(C(hid, 'logs'));
          tx.set(log, { itemId: id, itemName: cur.name, before, after, delta: g.qty, type: 'in', memo: inv.supplier || '', invoiceId: invRef.id, byUid: me.uid, byName: myName, at: serverTimestamp() });
          const aliases = Array.from(new Set([...(cur.aliases || []), ...g.lines.map((l) => l.name)])).slice(-10);
          tx.update(H(hid, 'items', id), { qty: after, aliases, updatedAt: serverTimestamp(), updatedBy: me.uid, lastLogId: log.id });
          g.lines.forEach((l) => lines.push({ ...l, itemId: id, itemName: cur.name, applied: l.baseQty, isNew: false }));
        }
        for (const g of groupNew(plan.created)) {
          const ref = doc(C(hid, 'items')), log = doc(C(hid, 'logs'));
          tx.set(log, { itemId: ref.id, itemName: g.name, before: 0, after: g.qty, delta: g.qty, type: 'in', memo: inv.supplier || '', isNewItem: true, invoiceId: invRef.id, byUid: me.uid, byName: myName, at: serverTimestamp() });
          tx.set(ref, { name: g.name, spec: g.spec, unit: g.unit || '개', minQty: 0, qty: g.qty, archived: false, aliases: [g.name], updatedAt: serverTimestamp(), updatedBy: me.uid, lastLogId: log.id });
          g.lines.forEach((l) => lines.push({ ...l, itemId: ref.id, itemName: g.name, applied: l.baseQty, isNew: true }));
        }
        const rec = { supplier: inv.supplier || '', date: inv.date || '', total: inv.total || 0, lines, lowCount: lines.filter((l) => l.confidence === 'low').length, byUid: me.uid, byName: myName, at: serverTimestamp(), status: 'in' };
        tx.set(invRef, rec);
        return { id: invRef.id, ...rec, at: new Date() };
      });
    },
    async undoInvoice(hid, inv, myName) {
      return runTransaction(db, async (tx) => {
        const back = {};
        const isNew = {};
        inv.lines.forEach((l) => { back[l.itemId] = (back[l.itemId] || 0) + (l.applied || 0); if (l.isNew) isNew[l.itemId] = true; });
        const snaps = {};
        for (const id of Object.keys(back)) snaps[id] = await tx.get(H(hid, 'items', id));
        const invSnap = await tx.get(H(hid, 'invoices', inv.id));
        if (invSnap.data()?.status !== 'in') throw new Error('이미 되돌린 명세서예요');
        for (const [id, n] of Object.entries(back)) {
          const s = snaps[id]; if (!s.exists()) continue;
          const cur = s.data(), before = cur.qty, after = Math.max(0, before - n);
          const log = doc(C(hid, 'logs'));
          tx.set(log, { itemId: id, itemName: cur.name, before, after, delta: after - before, type: 'undo', memo: (inv.supplier || '') + ' 입고 취소', invoiceId: inv.id, byUid: me.uid, byName: myName, at: serverTimestamp() });
          tx.update(H(hid, 'items', id), { qty: after, ...(isNew[id] && after === 0 ? { archived: true } : {}), updatedAt: serverTimestamp(), updatedBy: me.uid, lastLogId: log.id });
        }
        tx.update(H(hid, 'invoices', inv.id), { status: 'undone', undoneAt: serverTimestamp(), undoneBy: me.uid });
      });
    },
    watchInvoices(hid, cb) {
      return onSnapshot(query(C(hid, 'invoices'), orderBy('at', 'desc'), limit(200)), (s) =>
        cb(s.docs.map((d) => ({ ...withId(d), at: ts(d.data().at) || new Date() }))), () => cb([]));
    },
    // ── 범용: 도매상(suppliers)·발주요청(requests)·발주(orders)·결제(payments) ──
    watchCol(hid, name, cb) {
      return onSnapshot(C(hid, name), (s) => cb(s.docs.map((d) => { const x = withId(d); if (x.at) x.at = ts(x.at); return x; })), () => cb([]));
    },
    async addTo(hid, name, data) {
      const ref = doc(C(hid, name));
      const b = writeBatch(db);
      b.set(ref, { ...data, byUid: me.uid, at: serverTimestamp() });
      await b.commit();
      return ref.id;
    },
    async setIn(hid, name, id, data) {
      const b = writeBatch(db);
      b.set(H(hid, name, id), { ...data, byUid: me.uid, at: serverTimestamp() }, { merge: true });
      await b.commit();
    },
    async updateIn(hid, name, id, fields) {
      const b = writeBatch(db);
      b.update(H(hid, name, id), fields);
      await b.commit();
    },
    async updateMember(hid, uid, fields) {
      const b = writeBatch(db);
      if (fields.status === 'left') fields.leftAt = serverTimestamp();
      b.update(H(hid, 'members', uid), fields);
      await b.commit();
    },
  };
}

/* ───────────────────────── 데모(메모리) ───────────────────────── */
function demoApi() {
  const role = new URLSearchParams(location.search).get('demo') || 'owner';
  const me = { uid: 'u-' + role, name: { owner: '김원장', manager: '박사무장', staff: '이간호' }[role] || '김원장', email: 'demo@sobumo' };
  const now = Date.now(), min = 60e3;
  const S = {
    hospital: { id: 'demo', name: '감귤의원(데모)' },
    members: [
      { id: 'u-owner', uid: 'u-owner', name: '김원장', title: '원장', role: 'owner', status: 'active', joinedAt: new Date(now - 40 * 864e5) },
      { id: 'u-manager', uid: 'u-manager', name: '박사무장', title: '사무장', role: 'manager', status: 'active', joinedAt: new Date(now - 30 * 864e5) },
      { id: 'u-staff', uid: 'u-staff', name: '이간호', title: '간호사', role: 'staff', status: 'active', joinedAt: new Date(now - 20 * 864e5) },
      { id: 'u-s2', uid: 'u-s2', name: '최간호', title: '간호조무사', role: 'staff', status: 'active', joinedAt: new Date(now - 10 * 864e5) },
      { id: 'u-s3', uid: 'u-s3', name: '정간호', title: '간호사', role: 'staff', status: 'left', joinedAt: new Date(now - 90 * 864e5) },
    ],
    items: [
      ['주사기 3cc', '23G · BD', '개', 70, 50], ['주사기 5cc', '23G', '개', 120, 50], ['수액세트', '일반', '개', 18, 20],
      ['멸균거즈', '4x4 · 10매', '팩', 240, 100], ['알코올솜', '100매', '통', 6, 5], ['라텍스 장갑', 'M', '박스', 3, 5],
      ['라텍스 장갑', 'S', '박스', 0, 3], ['IV 카테터', '22G', '개', 45, 30], ['반창고', '실크 1인치', '롤', 12, 10], ['생리식염수', '100ml', '병', 32, 20],
    ].map(([name, spec, unit, qty, minQty], i) => ({ id: 'i' + i, name, spec, unit, qty, minQty, archived: false, ...(i === 0 ? { packQty: 100, packUnit: '박스' } : {}), supplierId: i % 3 === 1 ? 's2' : 's1' })),
    logs: [],
    invites: [],
    invoices: [],
    suppliers: [
      { id: 's1', name: '대구메디칼', phone: '053-000-0000', contact: '김과장', memo: '오후 3시 전 주문 시 당일 배송' },
      { id: 's2', name: '영남의료기', phone: '010-0000-0000', contact: '박대리', memo: '' },
    ],
    requests: [],
    orders: [],
    payments: [],
  };
  const L = (i, b, a, by, ago, type = 'set') => S.logs.push({ id: 'l' + S.logs.length, itemId: 'i' + i, itemName: S.items[i].name + ' ' + S.items[i].spec, before: b, after: a, delta: a - b, type, byName: by, at: new Date(now - ago * min) });
  L(0, 100, 70, '이간호', 3); L(5, 5, 3, '최간호', 25, 'delta'); L(6, 2, 0, '이간호', 70, 'delta'); L(3, 140, 240, '박사무장', 180, 'delta'); L(2, 20, 18, '최간호', 60 * 26);
  S.logs.sort((a, b) => b.at - a.at);
  const subs = { items: [], logs: [], members: [], invites: [], invoices: [], suppliers: [], requests: [], orders: [], payments: [] };
  const emit = (k) => subs[k].forEach((cb) => cb(k === 'items' ? S.items.filter((x) => !x.archived).map((x) => ({ ...x })) : S[k].slice()));
  const watch = (k) => (hid, cb) => { subs[k].push(cb); setTimeout(() => emit(k)); return () => {}; };
  const addLog = (it, before, after, type, myName, memo = '') => { S.logs.unshift({ id: 'l' + Math.random(), itemId: it.id, itemName: it.name + (it.spec ? ' ' + it.spec : ''), before, after, delta: after - before, type, memo, byName: myName, at: new Date() }); emit('logs'); };
  return {
    demo: true,
    onAuth(cb) { setTimeout(() => cb(me)); },
    signIn() {}, signOut() { location.href = location.pathname; },
    async getUserHospital() { return 'demo'; },
    async getHospital() { return S.hospital; },
    async getMember() { return S.members.find((m) => m.uid === me.uid); },
    async createHospital() { return 'demo'; },
    async getInvite() { return null; },
    async joinByInvite() {},
    watchItems: watch('items'), watchLogs: watch('logs'), watchMembers: watch('members'), watchInvites: watch('invites'),
    async addItem(hid, it, myName) { const x = { id: 'n' + Math.random(), archived: false, ...it }; S.items.push(x); addLog(x, 0, it.qty, 'create', myName); emit('items'); },
    async changeQty(hid, id, { mode, value, memo }, myName) {
      const it = S.items.find((x) => x.id === id); const before = it.qty;
      const after = Math.max(0, mode === 'set' ? value : before + value);
      if (after !== before) { it.qty = after; addLog(it, before, after, mode, myName, memo); emit('items'); }
      return { before, after };
    },
    async editItem(hid, id, fields, myName, type = 'meta') { const it = S.items.find((x) => x.id === id); const { _memo, ...rest } = fields; Object.assign(it, rest); addLog(it, it.qty, it.qty, type, myName, _memo); emit('items'); },
    async createInvite(hid, { role, title }) { const code = randCode(); S.invites.push({ id: code, role, title, expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5) }); emit('invites'); return code; },
    async deleteInvite(hid, code) { S.invites = S.invites.filter((x) => x.id !== code); emit('invites'); },
    watchInvoices: watch('invoices'),
    async readInvoice() {
      await new Promise((r) => setTimeout(r, 1800));
      return { supplier: '대구매디칼', date: new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10), total: 286000, lines: [
        { name: 'BD 주사기 3cc 23G', spec: '100입', qty: 2, unit: '박스', unitPrice: 12000, amount: 24000, matchId: 'i0', baseQty: 200, confidence: 'high', note: '' },
        { name: '라텍스 글러브 M', spec: '100매', qty: 5, unit: 'BOX', unitPrice: 9000, amount: 45000, matchId: 'i5', baseQty: 5, confidence: 'high', note: '' },
        { name: '수액세트 일반형', spec: '', qty: 50, unit: 'EA', unitPrice: 800, amount: 40000, matchId: 'i2', baseQty: 50, confidence: 'high', note: '' },
        { name: '멸균거즈 3x3', spec: '10매', qty: 3, unit: '박스', unitPrice: 15000, amount: 45000, matchId: null, baseQty: 3, confidence: 'low', note: '박스 입수 확인 필요' },
        { name: '포비돈 요오드액', spec: '500ml', qty: 4, unit: '병', unitPrice: 5000, amount: 20000, matchId: null, baseQty: 4, confidence: 'high', note: '' },
      ] };
    },
    async applyInvoice(hid, inv, myName) {
      const plan = planInvoice(inv), lines = [], id = 'v' + Math.random();
      for (const [iid, g] of Object.entries(plan.matched)) { const it = S.items.find((x) => x.id === iid); const b = it.qty; it.qty += g.qty; addLog(it, b, it.qty, 'in', myName, inv.supplier); g.lines.forEach((l) => lines.push({ ...l, itemId: iid, itemName: it.name, applied: l.baseQty, isNew: false })); }
      for (const g of groupNew(plan.created)) { const it = { id: 'n' + Math.random(), name: g.name, spec: g.spec, unit: g.unit || '개', qty: g.qty, minQty: 0, archived: false }; S.items.push(it); addLog(it, 0, g.qty, 'in', myName, inv.supplier); S.logs[0].isNewItem = true; g.lines.forEach((l) => lines.push({ ...l, itemId: it.id, itemName: g.name, applied: l.baseQty, isNew: true })); }
      const rec = { id, supplier: inv.supplier, date: inv.date, total: inv.total, lines, lowCount: lines.filter((l) => l.confidence === 'low').length, byName: myName, at: new Date(), status: 'in' };
      S.invoices.unshift(rec); emit('items'); emit('invoices'); return rec;
    },
    async undoInvoice(hid, inv, myName) {
      const back = {}; inv.lines.forEach((l) => { back[l.itemId] = (back[l.itemId] || 0) + l.applied; });
      for (const [iid, n] of Object.entries(back)) { const it = S.items.find((x) => x.id === iid); if (!it) continue; const b = it.qty; it.qty = Math.max(0, b - n); addLog(it, b, it.qty, 'undo', myName, inv.supplier + ' 입고 취소'); if (it.qty === 0 && inv.lines.some((l) => l.itemId === iid && l.isNew)) it.archived = true; }
      const r = S.invoices.find((x) => x.id === inv.id); r.status = 'undone'; emit('items'); emit('invoices');
    },
    async updateMember(hid, uid, f) { Object.assign(S.members.find((m) => m.uid === uid), f); emit('members'); },
    watchCol(hid, name, cb) { (subs[name] ||= []).push(cb); setTimeout(() => cb((S[name] ||= []).slice())); return () => {}; },
    async addTo(hid, name, data) { const id = 'd' + Math.random(); (S[name] ||= []).unshift({ id, ...data, byUid: me.uid, at: new Date() }); (subs[name] || []).forEach((cb) => cb(S[name].slice())); return id; },
    async setIn(hid, name, id, data) { const arr = (S[name] ||= []); const i = arr.findIndex((x) => x.id === id); const v = { ...(i >= 0 ? arr[i] : {}), id, ...data, at: new Date() }; if (i >= 0) arr[i] = v; else arr.unshift(v); (subs[name] || []).forEach((cb) => cb(arr.slice())); },
    async updateIn(hid, name, id, f) { Object.assign((S[name] || []).find((x) => x.id === id) || {}, f); (subs[name] || []).forEach((cb) => cb(S[name].slice())); },
  };
}

export async function createApi() {
  if (isDemo) return demoApi();
  if (!firebaseConfig) return null;
  return firebaseApi();
}
