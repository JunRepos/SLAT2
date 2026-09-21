# SLAT 기록장

학교주도활동(SLAT) 주제 탐구 프로젝트의 **팀별 차시 기록**을 학생이 작성하고 담당 교사가 검토하는 웹앱입니다.
서버 없이 정적 파일(`public/`) + **Firebase (Authentication · Firestore)** 로 동작합니다.

- 사이트: https://junrepos.github.io/SLAT2/ (`main`에 푸시하면 GitHub Actions가 `public/`을 Pages로 배포)
- Firebase 프로젝트: `slat-9f875` (기존 SLAT 신청서 앱과 같은 프로젝트 — `firestore.rules`에 두 앱 규칙이 함께 있음)
- 보안 규칙 배포: `npx firebase-tools deploy --only firestore:rules`

## 기능

**학생** — 학번 + 접속코드로 로그인
- 우리 팀 차시 목록: 계획서상 활동, 기록 상태, 기한 지남/오늘 차시 표시
- 차시 기록: 참여자, 오늘 한 활동, 개인별 역할·기여, 결과·산출물, 어려운 점, 다음 계획, 참고자료·출처
- 임시저장(팀원끼리 공유) → 제출. 교사가 [확인 완료]하면 잠김, [보완 요청]이면 피드백 보고 다시 제출
- 두 팀원이 동시에 고치면 뒤에 저장한 쪽에 경고 (덮어쓰기 방지)

**교사** — 이메일 + 비밀번호로 로그인
- 대시보드: 팀 × 차시 현황표, 확인 대기·기한 지난 미제출 목록
- 기록 검토: 피드백, 확인 완료 / 보완 요청 / 검토 취소
- 계획서 편집: 팀명·주제·팀원·접속코드·차시 계획·실험 계획·예산, 팀 추가
- 접속코드 인쇄용 목록, 전체 기록 CSV(엑셀) 내보내기

## Firebase 설정 (처음 한 번)

1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성 (Analytics 불필요)
2. **Authentication → 로그인 방법**에서 `이메일/비밀번호`와 `익명` 사용 설정
3. **Authentication → 사용자 → 사용자 추가**로 교사 계정(이메일·비밀번호) 생성
4. **Firestore Database → 데이터베이스 만들기** (위치: `asia-northeast3 (서울)`, 프로덕션 모드)
5. **프로젝트 설정 → 내 앱 → 웹 앱 추가** 후 표시되는 설정값을 [`public/firebase-config.js`](public/firebase-config.js)에 붙여 넣기
6. [`firestore.rules`](firestore.rules)의 `teacher@example.com`을 3번의 교사 이메일로 바꾸기
7. 규칙과 사이트 배포

   ```bash
   npx firebase-tools login
   npx firebase-tools use --add
   npm run deploy
   ```

   배포가 끝나면 `https://<프로젝트ID>.web.app` 주소가 나옵니다.
   (규칙만 콘솔 **Firestore → 규칙** 탭에 붙여 넣고, `public/` 폴더는 GitHub Pages 등 다른 곳에 올려도 됩니다.)
8. 교사로 로그인 → **[계획서 3개 불러오기]** → 각 팀 **[계획서 편집]**에서 실명으로 수정 → **[접속코드]** 메뉴에서 인쇄해 배부

## 로컬 테스트 (에뮬레이터)

Java 11 이상이 필요합니다. 실제 Firebase 프로젝트 없이 테스트할 수 있습니다.

```bash
npm run emulator
```

- `http://localhost:5000/?emulator` 로 접속
- 교사 계정은 에뮬레이터에 직접 만들어야 합니다 (이메일 `teacher@example.com`):

  ```bash
  curl -X POST "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key" -H "Content-Type: application/json" -d "{\"email\":\"teacher@example.com\",\"password\":\"test1234\"}"
  ```

## 데이터 구조 (Firestore)

| 경로 | 내용 | 권한 |
|---|---|---|
| `teams/{teamId}` | 계획서 (주제, 팀원, 차시, 예산) | 교사 쓰기 · 팀원 읽기 |
| `teams/{teamId}/logs/{차시}` | 차시 기록, 교사 피드백 | 팀원 작성 · 교사 검토 |
| `roster/{학번}` | 이름, 소속 팀 | 교사 쓰기 · 본인 읽기 |
| `pins/{학번}` | 접속코드 | 교사만 |
| `links/{uid}` | 로그인한 학생 기기 ↔ 학번 | 본인 |

학생은 익명 로그인 후 `links/{uid}`에 학번과 접속코드를 적고, 보안 규칙이 `pins/{학번}`과 대조해 해당 팀 권한만 줍니다.
교사가 접속코드를 바꾸면 그 학생의 기존 로그인은 즉시 무효가 됩니다.

## 개인정보

- 이 저장소의 [`public/seed.js`](public/seed.js)는 이름 가운데 글자를 `0`으로 가렸고 전화번호는 넣지 않았습니다.
- 실명은 교사가 앱에서 입력하며 Firestore에만 저장됩니다.
- `firebase-config.js`의 값은 공개되어도 되는 식별자입니다. 데이터 보호는 `firestore.rules`가 담당합니다.
