import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp, collection, getDocs } from 'firebase/firestore';
import { readFileSync } from 'fs';

const env = await initializeTestEnvironment({
  projectId: 'demo-sobumo',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
});
let pass = 0, fail = 0;
async function t(name, p) { try { await p; pass++; console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, e.message.split('\n')[0]); } }

const H = 'h1', H2 = 'h2';
const db = (uid) => env.authenticatedContext(uid).firestore();
const owner = db('owner'), nurse = db('nurse'), mgr = db('mgr'), out = db('outsider');

// 1. 병원 만들기
async function createHospital(fs, h, uid) {
  const b = writeBatch(fs);
  b.set(doc(fs, 'hospitals', h), { name: '테스트의원', ownerUid: uid, createdAt: serverTimestamp() });
  b.set(doc(fs, 'hospitals', h, 'members', uid), { uid, name: '원장', title: '원장', role: 'owner', status: 'active', joinedAt: serverTimestamp() });
  b.set(doc(fs, 'users', uid), { hospitalId: h });
  return b.commit();
}
await t('원장이 병원 생성', createHospital(owner, H, 'owner'));
await t('남의 병원에 owner로 끼어들기 차단', (async () => {
  const b = writeBatch(out);
  b.set(doc(out, 'hospitals', H, 'members', 'outsider'), { uid: 'outsider', name: 'x', role: 'owner', status: 'active', joinedAt: serverTimestamp() });
  return assertFails(b.commit());
})());
await t('외부인 병원 조회 차단', assertFails(getDoc(doc(out, 'hospitals', H))));

// 2. 초대
const exp = Timestamp.fromMillis(Date.now() + 7 * 864e5);
await t('원장 초대 생성', assertSucceeds(setDoc(doc(owner, 'hospitals', H, 'invites', 'codeSTAFF12345678'), { role: 'staff', title: '간호사', hospitalName: '테스트의원', createdBy: 'owner', createdAt: serverTimestamp(), expiresAt: exp })));
await t('원장 초대 생성(사무장)', assertSucceeds(setDoc(doc(owner, 'hospitals', H, 'invites', 'codeMGR1234567890'), { role: 'manager', title: '사무장', hospitalName: '테스트의원', createdBy: 'owner', createdAt: serverTimestamp(), expiresAt: exp })));
await t('owner 역할 초대 차단', assertFails(setDoc(doc(owner, 'hospitals', H, 'invites', 'codeOWN1234567890'), { role: 'owner', createdBy: 'owner', expiresAt: exp })));
await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'hospitals', H, 'invites', 'codeOLD1234567890'), { role: 'staff', expiresAt: Timestamp.fromMillis(Date.now() - 1000) }));

const join = (fs, uid, code, role) => setDoc(doc(fs, 'hospitals', H, 'members', uid), { uid, name: uid, title: '', role, status: 'active', joinedAt: serverTimestamp(), inviteCode: code });
await t('초대로 간호사 가입', assertSucceeds(join(nurse, 'nurse', 'codeSTAFF12345678', 'staff')));
await t('초대 역할 위조(staff 링크로 manager) 차단', assertFails(join(db('x2'), 'x2', 'codeSTAFF12345678', 'manager')));
await t('만료 초대 차단', assertFails(join(db('x3'), 'x3', 'codeOLD1234567890', 'staff')));
await t('사무장 가입', assertSucceeds(join(mgr, 'mgr', 'codeMGR1234567890', 'manager')));
await t('간호사가 초대 목록 조회 차단', assertFails(getDocs(collection(nurse, 'hospitals', H, 'invites'))));

// 3. 재고
function itemWrite(fs, uid, id, logId, data, before, after, isCreate) {
  const b = writeBatch(fs);
  b.set(doc(fs, 'hospitals', H, 'logs', logId), { itemId: id, itemName: data.name || '', before, after, byUid: uid, byName: uid, type: isCreate ? 'create' : 'set', at: serverTimestamp() });
  const payload = { ...data, qty: after, updatedAt: serverTimestamp(), updatedBy: uid, lastLogId: logId };
  if (isCreate) b.set(doc(fs, 'hospitals', H, 'items', id), payload); else b.update(doc(fs, 'hospitals', H, 'items', id), payload);
  return b.commit();
}
await t('간호사 품목 추가 차단', assertFails(itemWrite(nurse, 'nurse', 'i1', 'L0', { name: '주사기', minQty: 10 }, 0, 100, true)));
await t('사무장 품목 추가', assertSucceeds(itemWrite(mgr, 'mgr', 'i1', 'L1', { name: '주사기 3cc', spec: '', unit: '개', minQty: 20, archived: false }, 0, 100, true)));
await t('간호사 수량 100→70', assertSucceeds(itemWrite(nurse, 'nurse', 'i1', 'L2', {}, 100, 70, false)));
await t('이력 없이 수량 변경 차단', assertFails(updateDoc(doc(nurse, 'hospitals', H, 'items', 'i1'), { qty: 50, updatedAt: serverTimestamp(), updatedBy: 'nurse', lastLogId: 'L2' })));
await t('이력 수량 불일치 차단', assertFails((async () => {
  const b = writeBatch(nurse);
  b.set(doc(nurse, 'hospitals', H, 'logs', 'L3'), { itemId: 'i1', before: 70, after: 60, byUid: 'nurse', at: serverTimestamp() });
  b.update(doc(nurse, 'hospitals', H, 'items', 'i1'), { qty: 10, updatedAt: serverTimestamp(), updatedBy: 'nurse', lastLogId: 'L3' });
  return b.commit();
})()));
await t('간호사 최소수량 변경 차단', assertFails(itemWrite(nurse, 'nurse', 'i1', 'L4', { minQty: 0 }, 70, 70, false)));
await t('음수 수량 차단', assertFails(itemWrite(nurse, 'nurse', 'i1', 'L5', {}, 70, -1, false)));
await t('이력 위조(남의 이름) 차단', assertFails(setDoc(doc(nurse, 'hospitals', H, 'logs', 'L6'), { itemId: 'i1', byUid: 'owner', at: serverTimestamp() })));
await t('이력 삭제 차단', assertFails(deleteDoc(doc(owner, 'hospitals', H, 'logs', 'L2'))));
await t('품목 삭제 차단', assertFails(deleteDoc(doc(owner, 'hospitals', H, 'items', 'i1'))));
await t('외부인 재고 조회 차단', assertFails(getDoc(doc(out, 'hospitals', H, 'items', 'i1'))));

// 4. 다른 병원 격리
await t('두 번째 병원 생성', createHospital(out, H2, 'outsider'));
await t('다른 병원 원장이 1번 병원 재고 조회 차단', assertFails(getDocs(collection(out, 'hospitals', H, 'items'))));

// 5. 퇴사
await t('간호사가 자기 역할 올리기 차단', assertFails(updateDoc(doc(nurse, 'hospitals', H, 'members', 'nurse'), { role: 'manager' })));
await t('사무장이 퇴사 처리 차단', assertFails(updateDoc(doc(mgr, 'hospitals', H, 'members', 'nurse'), { status: 'left' })));
await t('원장이 간호사 퇴사 처리', assertSucceeds(updateDoc(doc(owner, 'hospitals', H, 'members', 'nurse'), { status: 'left', leftAt: serverTimestamp() })));
await t('퇴사자 재고 조회 차단', assertFails(getDoc(doc(nurse, 'hospitals', H, 'items', 'i1'))));
await t('퇴사자 같은 링크로 재가입 차단', assertFails(join(nurse, 'nurse', 'codeSTAFF12345678', 'staff')));
await t('퇴사 후에도 이력 보존(원장 조회)', (async () => { const s = await getDocs(collection(owner, 'hospitals', H, 'logs')); if (s.size < 2) throw new Error('logs ' + s.size); })());
await t('원장 자신 퇴사처리 차단', assertFails(updateDoc(doc(owner, 'hospitals', H, 'members', 'owner'), { status: 'left' })));

console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
