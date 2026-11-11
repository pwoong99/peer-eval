# 📝 산출물 동료평가

학생들이 산출물(영상·발표·글·코딩 등)을 올리고, 친구들의 산출물에 별점과 코멘트로 평가하며 서로 배우는 웹앱입니다.

- 화면: GitHub Pages (무료 호스팅)
- 데이터: Firebase Firestore + Authentication, 사진: Firebase Storage (Blaze 요금제)
- 만든이 : 푸르이든

## 파일 구성

```
index.html              화면 전체 (디자인·동작)
js/main.js              시작 파일 (Firebase 연결)
js/api.js               기능 모음 (산출물·평가·프로젝트·학생 관리 등)
js/store.js             Firestore / Storage / 로그인 도우미
js/firebase-config.js   ★ 내 Firebase 값으로 바꿔야 하는 파일
firestore.rules         ★ Firebase 콘솔 > Firestore > 규칙 에 붙여 넣을 내용
storage.rules           ★ Firebase 콘솔 > Storage > 규칙 에 붙여 넣을 내용
```

## 처음 설치하기

1. Firebase 프로젝트 만들기 → **Blaze 요금제**로 업그레이드 (예산 알림 꼭 설정)
2. **Authentication**: 익명 + 이메일/비밀번호 사용 설정, 교사 계정 추가
3. **Firestore**(서울 asia-northeast3, 프로덕션 모드) → 규칙 탭에 `firestore.rules` 붙여 넣고 게시
4. **Storage**(서울) → 규칙 탭에 `storage.rules` 붙여 넣고 게시 (Firestore 접근 권한 부여 창이 나오면 허용)
5. 웹 앱 등록 → `firebaseConfig` 값을 `js/firebase-config.js` 에 붙여 넣기
6. 교사 이메일을 **세 곳에 똑같이**: `js/firebase-config.js`, `firestore.rules`, `storage.rules`
7. GitHub 저장소에 올리고 **Settings → Pages** → Branch `main` / `(root)`

> `index.html` 을 내 컴퓨터에서 더블클릭해서 열면 동작하지 않습니다. 꼭 GitHub Pages 주소로 여세요.

## 첫 사용
- 교사 로그인 → **👥 학생 관리**
  - 예전 앱(앱스 스크립트) 기록이 있으면 **📥 예전 앱에서 기록 가져오기**
  - 처음이면 **📝 학생 명단 등록**에 `1 김하늘` 처럼 붙여 넣기 (비밀번호는 63+번호)
- **📁 프로젝트** 탭에서 새 프로젝트 만들기 (개인/모둠, 활동 유형별 문항 불러오기)

## 알아 두면 좋은 점
- 학생 비밀번호는 4자리 숫자라 학급 활동용 보안 수준입니다. 학생은 비밀번호를 읽을 수 없고, 남의 산출물을 고치거나 자기 작품을 평가하는 것은 보안 규칙에서 막힙니다.
- `firebase-config.js` 의 apiKey 는 공개되어도 괜찮은 값입니다. 데이터 보호는 보안 규칙이 담당합니다.
- 친구가 산출물을 올리거나 평가를 남기면 화면에 곧바로 반영됩니다.
- 예전 앱에서 옮겨 온 사진은 구글 드라이브 주소 그대로 보입니다.

## 버전 기록
- v2.00 (2026-11) Firebase + GitHub로 옮김 — 빠른 화면, 교사 이메일 로그인, 학생 명단 등록, 예전 기록 가져오기
- v1.x (2026-09~11) 구글 앱스 스크립트 버전 (자세한 기록은 앱 오른쪽 아래 버전 표시를 누르면 볼 수 있어요)
