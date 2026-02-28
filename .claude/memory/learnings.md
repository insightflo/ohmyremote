# Learnings

## 2026-02-28: 프로젝트 초기화 및 Git 설정

**문제**:
새 프로젝트를 GitHub에 연결하고 초기 커밋을 생성해야 했음

**원인**:
- Git 저장소가 초기화되지 않음
- Remote URL이 설정되지 않음

**해결**:
```bash
git init
git remote add origin https://github.com/insightflo/ohmyremote.git
git add .
git commit -m "Initial commit: ohmyremote project setup"
git push -u origin main
```

**교훈**:
- 새 프로젝트 시작 시 즉시 Git 초기화 및 커밋
- GitHub remote 연결을 자동화 스크립트로 만들면 효율적

---

## 2026-02-28: Korean README 번역 및 저장

**문제**:
프로젝트를 한국어 사용자에게 노출하기 위해 README를 한국어로 번역해야 했음

**원인**:
- 기존 README는 영어로 작성됨
- 한국어 문서 필요

**해결**:
- README.md를 읽어 전체 내용 분석
- 한국어로 번역한 내용을 README_ko.md로 저장
- 모든 기능 설명, 설정 가이드, 아키텍처 설명을 포함

**교훈**:
- 다국어 지원을 위해 기본 파일과 번역본 별도 저장 권장
- 한국어 번역 시 기술 용어 일관성 유지 중요

---

## 2026-02-28: 메모리 시스템 초기화

**문제**:
세션 간 지식 지속을 위한 메모리 시스템이 필요함

**원인**:
- 프로젝트 컨텍스트를 매 세션마다 새로 설명해야 함
- 이전 결정과 패턴을 잊어버릴 위험

**해결**:
```
.claude/memory/
├── project.md      # 프로젝트 정보
├── preferences.md  # 사용자 스타일
├── patterns.md     # 코드 패턴
├── decisions.md    # 아키텍처 결정
└── learnings.md    # 학습 기록
```

**교훈**:
- 메모리 시스템은 프로젝트 시작 시 즉시 초기화
- Markdown 파일로 구조화하여 버전 관리 가능
- Git에 커밋하여 팀원과 공유
