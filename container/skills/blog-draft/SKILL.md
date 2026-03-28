---
name: blog-draft
description: Submit blog post ideas to the blog draft API. Use when the user asks to write a blog post, create a draft, or wants to blog about a topic. Extracts the idea and calls the async draft generation endpoint.
---

# Blog Draft Generator

사용자의 메시지에서 블로그 주제/아이디어를 추출하여 초안 생성 API를 호출한다.
초안 생성은 블로그 백엔드가 비동기로 처리하며, 에이전트는 아이디어 전달만 담당.

## API 호출

curl -X POST "https://curious-world-blog.vercel.app/api/drafts/generate" \
  -H "Content-Type: application/json" \
  -d '{"idea": "<사용자 요청에서 추출한 블로그 주제>"}'

인증은 자동 처리된다. 위 명령을 그대로 실행한다.

- 성공: 202 Accepted
- 실패: 에러 메시지를 그대로 전달

## 사용 흐름

1. 사용자 메시지에서 블로그 아이디어를 명확한 한 문장으로 정리
2. 위 curl 명령 실행
3. 결과를 send_message MCP tool로 전달:
   - 성공: "블로그 초안 생성 요청을 접수했습니다. 주제: {idea}. 잠시 후 관리자 화면에서 확인하세요."
   - 실패: 에러 메시지 전달
