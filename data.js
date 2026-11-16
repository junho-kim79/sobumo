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
    ].map(([name, spec, unit, qty, minQty], i) => ({ id: 'i' + i, name, spec, unit, qty, minQty, archived: false })),
    logs: [],
    invites: [],
  };
  const L = (i, b, a, by, ago, type = 'set') => S.logs.push({ id: 'l' + S.logs.length, itemId: 'i' + i, itemName: S.items[i].name + ' ' + S.items[i].spec, before: b, after: a, delta: a - b, type, byName: by, at: new Date(now - ago * min) });
  L(0, 100, 70, '이간호', 3); L(5, 5, 3, '최간호', 25, 'delta'); L(6, 2, 0, '이간호', 70, 'delta'); L(3, 140, 240, '박사무장', 180, 'delta'); L(2, 20, 18, '최간호', 60 * 26);
  S.logs.sort((a, b) => b.at - a.at);
  const subs = { items: [], logs: [], members: [], invites: [] };
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
    async updateMember(hid, uid, f) { Object.assign(S.members.find((m) => m.uid === uid), f); emit('members'); },
  };
}

export async function createApi() {
  if (isDemo) return demoApi();
  if (!firebaseConfig) return null;
  return firebaseApi();
}
