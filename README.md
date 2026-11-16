# SOBUMO 재고한눈에

소모품 부족 모니터링 — 재고 · 입고 · 발주 · 매입관리, by ALLAI GROUP

병의원 직원들이 각자 폰·PC에서 같은 병원 재고를 실시간으로 함께 관리하는 무료 서비스.

## 구성
| 파일 | 역할 |
|---|---|
| `index.html`, `style.css` | 첫 화면 + 앱 화면 (우리연차 스타일) |
| `app.js` | 화면 동작 |
| `data.js` | Firebase 연동 / 데모 모드(`?demo=owner` · `?demo=manager` · `?demo=staff`) |
| `firebase-config.js` | Firebase 웹 앱 설정값 (여기에 붙여넣기) |
| `firestore.rules` | 보안 규칙 — 병원 간 차단, 역할별 권한, 이력 필수·삭제 불가 |
| `tests/rules.test.mjs` | 보안 규칙 테스트 (Firebase 에뮬레이터) |

빌드 과정 없음. Vercel에 그대로 정적 배포.

## 처음 설정 (1회)
1. Firebase 콘솔 → 프로젝트 추가 (예: `sobumo`)
2. 빌드 → Authentication → 시작하기 → 로그인 방법 → **Google** 사용 설정
3. 빌드 → Firestore Database → 데이터베이스 만들기 (위치 `asia-northeast3` 서울, 프로덕션 모드)
4. Firestore → **규칙** 탭에 `firestore.rules` 내용을 붙여넣고 게시
5. 프로젝트 설정 → 내 앱 → 웹 앱 추가 → 나오는 `firebaseConfig`를 `firebase-config.js`에 붙여넣기
6. Authentication → 설정 → **승인된 도메인**에 `sobumo.vercel.app` (및 사용할 도메인) 추가

## 데이터 구조
```
users/{uid}                       { hospitalId }
hospitals/{hid}                   { name, ownerUid, createdAt }
  members/{uid}                   { name, title, role: owner|manager|staff, status: active|left, joinedAt }
  invites/{code}                  { role, title, hospitalName, expiresAt(7일) }
  items/{id}                      { name, spec, unit, qty, minQty, archived, lastLogId }
  logs/{id}                       { itemId, itemName, before, after, delta, type, memo, byUid, byName, at }
```
- 수량 변경은 항상 이력과 한 묶음으로 저장되며(규칙으로 강제), 이력은 수정·삭제 불가.
- +/− 버튼은 변화량으로, 숫자 직접 입력은 최종 수량으로 저장 → 동시 수정에도 덮어쓰기 없음.
- 퇴사 처리 시 즉시 접근 차단, 과거 기록은 보존.

## 규칙 테스트
```
npm i -D firebase-tools @firebase/rules-unit-testing firebase
npx firebase emulators:exec --only firestore --project demo-sobumo "node tests/rules.test.mjs"
```

## 다음 단계
3. 거래명세서 AI 인식(Gemini Flash) → 자동 입고 · 매입액 계산 (사진은 저장하지 않음)
4. 통합 발주 · 도매상 연락처
5. 월별 매입 · 결제 현황
