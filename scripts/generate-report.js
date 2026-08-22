// scripts/generate-report.js
// 구조: Step1 웹검색(기사+영상)으로 실제 데이터 수집 → Step2 JSON 생성(3분할) → HTML 저장
// v4: OpenAI API(Responses API) 기반. 화이트모드(눈이 덜 피로한 톤), 4개 축
//     (이슈/기술/근무방식/HRD) 브리핑 레이아웃, 기술 섹션은 서브그룹+타임라인으로
//     심화(최근 2주 데이터 우선), 문구 단위 출처 태깅(기사·영상·학술연구·공공발표 포함),
//     출처 다양성·정부-민간 균형 규칙, PDF 저장 버튼. '다음 호 예고'는 없음.
//
// ⚠️ OpenAI Responses API는 계속 진화 중입니다 — 이 스크립트가 오래됐다면 아래를
//    실행 전에 https://platform.openai.com/docs/api-reference/responses 에서
//    MODEL과 웹 검색 툴 타입(WEB_SEARCH_TOOL_TYPE)이 여전히 유효한지 확인하세요.

const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

// 웹 검색이 가능한 모델과 OpenAI 호스팅 웹 검색 툴 타입을 한 곳에서 관리합니다.
// (openai SDK 7.x 기준 유효한 툴 타입: "web_search" 또는 "web_search_preview")
const MODEL = "gpt-4.1";
const WEB_SEARCH_TOOL_TYPE = "web_search";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────
// 날짜/주차 계산
// ─────────────────────────────────────────────────────────
function getWeekNumber() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
}
function getKoreanDate() {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d} (${days[now.getDay()]})`;
}
// 발행일(날짜 단위)과 별개로, "이 실행이 실제로 언제 생성됐는지"를 분·초 단위로
// 페이지 하단에 남겨 배포가 최신인지 바로 확인할 수 있게 합니다.
function getKoreanDateTime() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${y}.${m}.${d} ${hh}:${mm} KST`;
}

const VOL = getWeekNumber();
const DATE = getKoreanDate();
const GENERATED_AT = getKoreanDateTime();
const YEAR = new Date().getFullYear();
const MON = new Date().getMonth() + 1;
const TOPIC = `${YEAR}년 ${MON}월 ${VOL}주차 HR 트렌드 (채용·평가·보상 / HR 기술 / 일하는 방식)`;

// ─────────────────────────────────────────────────────────
// 재시도 유틸
// ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT_WAIT_MS = Number(process.env.RATE_LIMIT_WAIT_MS) || 65000; // 분당 토큰 한도 방지 대기
const RETRYABLE = new Set([429, 500, 502, 503]);

async function withRetry(fn, label) {
  const MAX = 4;
  for (let i = 0; i <= MAX; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status || err?.statusCode || 0;
      const isRetry = RETRYABLE.has(status) || (err.message || "").includes("overloaded");
      if (!isRetry || i === MAX) throw err;
      const delay = 8000 * Math.pow(2, i);
      console.log(`   ⏳ ${label} 재시도 ${i + 1}/${MAX} (${delay / 1000}s 후)...`);
      await sleep(delay);
    }
  }
}

// ─────────────────────────────────────────────────────────
// STEP 1: 웹검색 agentic loop → 원문 수집 (기사 + 유튜브 영상)
// ─────────────────────────────────────────────────────────
const SEARCH_SYSTEM = `당신은 HR 리서처입니다.
웹 검색을 10회 이상 실행해 "최근 1~2주 이내"에 나온 HR 관련 최신 데이터를 국내외 균형 있게 수집하세요.

출처 다양성 원칙 (중요):
- 특정 매체·채널·블로그 하나에 지나치게 의존하지 마세요. 최종적으로 서로 다른 도메인(매체/기관) 8곳 이상에서 자료를 확보하는 것을 목표로 하세요.
- 같은 주제라도 검색어를 바꿔가며 여러 매체를 교차 검색하세요 (예: 특정 블로그 1곳의 트렌드 글만으로 여러 섹션을 채우지 말 것).
- 단순 뉴스 기사·웹문서만으로는 최신 트렌드를 따라가기 어려우므로, 반드시 유튜브 영상도 함께 검색하세요
  (검색어에 "유튜브" 또는 "site:youtube.com"을 포함해 최소 2회 이상 검색).
- 국내 이슈를 다룰 때는 반드시 정부·공공기관 발표 자료(고용노동부, 통계청, 한국노동연구원(KLI), KDI, 정책브리핑(korea.kr) 등)를 최소 2건 이상 확보하고, 민간 기업·컨설팅·언론의 분석과 나란히 놓아 비교할 수 있게 하세요 — 정부 발표 지표와 민간 시각이 다르게 해석될 수 있는 지점을 의식적으로 찾으세요.
- HR 기술(AI) 관련 자료는 뉴스·기업 블로그에만 의존하지 말고, 학술 논문·연구도 최소 1~2건 검색하세요 (검색어 예: "AI hiring bias study", "algorithmic hiring research paper", "site:arxiv.org AI recruitment", 대학 연구소·학회·저널, 한국노동연구원·KDI 등 연구기관 리포트 등).

검색 주제 (각각 1회 이상, 최근 1~2주 발생 이슈 우선):
1. 국내 채용·평가·보상 이슈 (채용 트렌드, 임금 인상률, 성과급, 임금체계 개편)
2. 글로벌 채용·보상 이슈 (해외 채용 동향, pay transparency, AI 채용 규제)
3. HR 기술 도입 현황 — 최근 2주 이내 뉴스 우선 (AI 채용솔루션, AI 에이전트, HR테크 도입률)
4. HR 기술의 리스크·반발 — 최근 2주 이내 뉴스 우선, 최소 2건 이상. 기술 도입에 대한 긍정적인 수치만 모으지 말고 비판·우려·반발 보도를 의식적으로 함께 찾을 것 (AI 편향, 오탈락, 노동계 반발, 감원 명분화 논란, 규제 이슈)
5. HR·AI 관련 유튜브 영상 (국내외 채용/HR 전문가 리뷰, 뉴스 리포트, 컨퍼런스 영상) — 최소 2건
6. HR·AI 관련 학술 연구·저널 (대학 연구소, 학회 논문, arXiv, 노동/경제 연구기관 리포트) — 최소 1~2건, 특히 AI 채용·평가의 공정성·편향·효과성을 다룬 연구 우선
7. 국내 정부·공공기관 발표 (고용노동부, 통계청, 한국노동연구원, KDI, 정책브리핑 등 공식 통계·연구·정책) — 최소 2건
8. 근무 방식·직무 변화 (주4.5일제, 하이브리드/원격근무, 리스킬링)
9. 감원·구조조정 동향 (빅테크 감원, AI발 구조조정, 그 배경에 대한 회의적 시각 포함)
10. HRD·교육개발 (리스킬링·업스킬링 우선순위, 기업 교육 예산, AI 교육/LXP 도입, 사내 교육 트렌드)

수집 완료 후 아래 형식으로 요약하세요. 각 항목에는 반드시 실제 검색된 제목, 출처명(매체명 또는 채널명·기관명), URL, 날짜(가능한 경우 YYYY.MM.DD)를 포함하고, 유튜브 영상은 항목 앞에 "[영상]"을, 학술 논문/연구기관 자료는 "[연구]"를, 정부·공공기관 발표는 "[공공]"을 붙이세요.

## 수집된 HR 트렌드 데이터

### 국내 채용·평가·보상
- 항목 (출처명, URL, 날짜)

### 글로벌 채용·보상
- 항목 (출처명, URL, 날짜)

### HR 기술 도입 (최근 2주 우선)
- 항목 (출처명, URL, 날짜)

### HR 기술 리스크·반발 (최근 2주 우선, 필수)
- 항목 (출처명, URL, 날짜)

### HR·AI 관련 유튜브 영상 (필수, [영상] 표시)
- [영상] 항목 (채널명, URL, 게시일)

### HR·AI 관련 학술 연구·저널 (필수, [연구] 표시)
- [연구] 항목 (연구기관/저널명, URL, 발표일)

### 국내 정부·공공기관 발표 (필수, [공공] 표시)
- [공공] 항목 (부처/기관명, URL, 발표일)

### 근무 방식·직무 변화
- 항목 (출처명, URL, 날짜)

### 감원·구조조정
- 항목 (출처명, URL, 날짜)

### HRD·교육개발
- 항목 (출처명, URL, 날짜)

출처 URL은 반드시 실제 검색된 URL만 기재하세요.`;

async function collectSearchData() {
  console.log("   web_search 시작 (기사 + 유튜브)...");
  // OpenAI Responses API의 호스팅 웹 검색 툴은 서버 측에서 검색 라운드를 자체
  // 진행하고 최종 텍스트를 돌려줍니다 — Anthropic처럼 tool_use/tool_result를
  // 클라이언트가 직접 주고받는 수동 루프가 필요 없습니다.
  const response = await withRetry(() =>
    client.responses.create({
      model: MODEL,
      instructions: SEARCH_SYSTEM,
      input: `${TOPIC} 관련 최신 데이터를 웹 검색으로 수집해주세요. 오늘 날짜: ${DATE}. 반드시 최근 1~2주 이내 보도를 우선하고(특히 HR 기술 항목), 기술 변화에 대해서는 긍정적 도입 사례뿐 아니라 리스크·반발 보도도 함께 모아 균형을 맞추고, 유튜브 영상도 최소 2건 이상 찾아주세요. 특정 매체 하나에 몰리지 않도록 서로 다른 도메인 8곳 이상에서 수집하고, 국내 이슈는 정부·공공기관 발표를 최소 2건, HR 기술 관련은 학술 논문·연구기관 자료를 최소 1~2건 반드시 포함해주세요.`,
      tools: [{ type: WEB_SEARCH_TOOL_TYPE }],
      max_output_tokens: 6000, // 검색 호출 자체는 별도 과금, 이건 마지막 요약 텍스트의 상한
    }), "검색"
  );

  const searchCalls = (response.output || []).filter((b) => b.type === "web_search_call").length;
  const text = (response.output_text || "").trim();

  console.log(`   ✅ 검색 완료 — ${text.length}자 수집, 검색 호출 ${searchCalls}회`);
  return text;
}

// ─────────────────────────────────────────────────────────
// 공통 JSON 스키마 규칙 (3개 파트 공용)
// ─────────────────────────────────────────────────────────
const COMMON_RULES = `당신은 HR 보고서 JSON 생성기입니다.
제공된 실제 검색 데이터를 바탕으로 JSON만 출력하세요.
마크다운 코드블록 없이 순수 JSON만 출력. 설명 문장 절대 금지.
문자열 안에 줄바꿈 금지. 작은따옴표 금지. 역슬래시 금지.
출처 URL은 검색 데이터에 있는 실제 URL만 사용하고, 없으면 해당 자료가 실린 매체/채널의 공식 홈페이지 URL을 사용하세요.
검색 데이터에 [영상] 표시가 있는 유튜브 항목, [연구] 표시가 있는 학술/연구기관 항목, [공공] 표시가 있는 정부·공공기관 항목이 있으면 관련 있는 claim에 적극적으로 srcUrl로 사용하세요 — 기사(웹문서)·영상·학술연구·공공발표를 균형 있게 섞어 쓰세요.
같은 매체·채널의 출처를 여러 섹션·카드에 반복 사용하지 마세요. 특정 출처 하나가 전체 인용의 상당 비중을 차지하지 않도록, 서로 다른 srcName을 최대한 다양하게 쓰세요.
국내 이슈(채용·보상·근무방식)를 다룰 때는 카드 안에 정부·공공기관 발표([공공] 표시) 출처를 최소 1개는 포함해 민간 기업·언론의 시각과 나란히 제시하세요 — 가능하면 두 시각이 다르게 해석되는 지점을 문장으로 드러내세요(예: "정부 발표로는 ~한 반면, 민간에서는 ~로 본다").
HR 기술(tech) 관련 claims에는 학술 논문·연구기관 자료([연구] 표시) 출처를 최소 1개는 포함하세요.
톤은 최대한 중립적으로 작성하세요 — 특히 기술(AI) 관련 내용은 도입·효율 등 긍정적 측면과 편향·반발·감원 명분화 등 우려되는 측면을 같은 비중으로 다루세요.
claims(문구)는 반드시 검색 데이터에 있는 구체적 사실·수치 문장으로 작성하고, 그 문구 바로 옆에 실제로 그 내용을 다룬 자료의 srcName(매체/채널명 + 제목 요약)과 srcUrl을 붙이세요. 근거가 불확실한 문구는 만들지 마세요.
insight(시사점) 필드는 claims를 바탕으로 한 편집자의 해석이므로 출처를 붙이지 않습니다.`;

const CARD_SCHEMA = `{
  "tag": "짧은 분류 태그",
  "title": "카드 제목",
  "claims": [
    { "text": "구체적 사실 문장", "srcName": "매체/채널명 · 제목 요약", "srcUrl": "https://실제URL" }
  ]
}`;

const PILLAR_TAIL_SCHEMA = `"insight": "이 섹션의 시사점 1~2문장(출처 불필요)",
  "deepDive": { "title": "심층 제목", "paragraphs": [ { "text": "문단", "srcName": "매체명", "srcUrl": "https://실제URL" } ] },
  "keywords": ["키워드1", "키워드2", "키워드3", "키워드4"]`;

// ─────────────────────────────────────────────────────────
// STEP 2A: meta + stats + pillar "issue" (채용·평가·보상)
// ─────────────────────────────────────────────────────────
const PART_A_SYSTEM = `${COMMON_RULES}

출력 스키마:
{
  "meta": {
    "headline": "이번 보고서 헤드라인 한 줄(중립적 톤, 20자 내외로 짧게 — 긴 문장은 제목에서 단어가 어색하게 줄바꿈될 수 있으니 피할 것)",
    "subheadline": "핵심 요약 2문장. 최근 1~2주 이슈를 다룬다는 점과, 기술 변화의 성과·우려를 함께 짚는다는 점을 포함"
  },
  "stats": [
    { "num": "실제수치", "desc": "지표명", "change": "변화 설명(가능하면 날짜 포함)", "srcName": "매체명", "srcUrl": "https://실제URL", "color": "issue" },
    { "num": "실제수치", "desc": "지표명", "change": "변화 설명", "srcName": "매체명", "srcUrl": "https://실제URL", "color": "tech" },
    { "num": "실제수치", "desc": "지표명", "change": "변화 설명", "srcName": "매체명", "srcUrl": "https://실제URL", "color": "work" },
    { "num": "실제수치", "desc": "지표명", "change": "변화 설명", "srcName": "매체명", "srcUrl": "https://실제URL", "color": "issue" },
    { "num": "실제수치", "desc": "지표명", "change": "변화 설명", "srcName": "매체명", "srcUrl": "https://실제URL", "color": "work" }
  ],
  "pillar": {
    "id": "issue", "color": "issue", "eyebrow": "PILLAR 01 · ISSUE BRIEFING", "icon": "🧭",
    "title": "최근 1~2주 HR 이슈 — 채용·평가·보상",
    "framing": "이 섹션을 관통하는 흐름 1~2문장",
    "cards": [${CARD_SCHEMA}, ${CARD_SCHEMA}, ${CARD_SCHEMA}],
    ${PILLAR_TAIL_SCHEMA}
  }
}

stats 정확히 5개(색상은 issue/tech/work/hrd 중에서 섞어서 배분 — 4가지 색을 고르게 쓸 것), cards 2~3개(각 2~3개 claims), deepDive는 없으면 null 가능.
stats나 cards에 자연스럽게 넣을 수 있다면 유튜브 영상 출처를 1개 이상 포함하세요.`;

// ─────────────────────────────────────────────────────────
// STEP 2B: pillar "tech" (HR 기술 변화 — 서브그룹+타임라인, 균형·최신성 필수)
// ─────────────────────────────────────────────────────────
const PART_B_SYSTEM = `${COMMON_RULES}

출력 스키마:
{
  "pillar": {
    "id": "tech", "color": "tech", "eyebrow": "PILLAR 02 · TECH REVIEW", "icon": "🤖",
    "title": "HR 기술 변화 리뷰",
    "framing": "이 섹션은 최근 2주 발표 자료 중심이라는 점을 밝히는 1~2문장(중립적으로)",
    "timeline": [
      { "date": "MM.DD 형식", "text": "최근 2주 내 실제 사건/발표 한 문장", "srcName": "매체/채널명", "srcUrl": "https://실제URL" }
    ],
    "groups": [
      { "label": "도입 · 자동화", "cards": [${CARD_SCHEMA}, ${CARD_SCHEMA}] },
      { "label": "리스크 · 반발", "cards": [${CARD_SCHEMA}] },
      { "label": "규제 · 거버넌스", "cards": [${CARD_SCHEMA}] }
    ],
    "chart": {
      "title": "차트 제목",
      "bars": [
        { "label": "지표명", "value": 00, "srcName": "매체명", "srcUrl": "https://실제URL" }
      ]
    },
    ${PILLAR_TAIL_SCHEMA}
  }
}

규칙:
- timeline은 반드시 검색 데이터에서 날짜가 확인되는(가능한 최근 2주 이내) 항목 3~5개로 구성하세요. 날짜를 알 수 없는 항목은 timeline에 넣지 마세요.
- groups는 정확히 3개("도입 · 자동화", "리스크 · 반발", "규제 · 거버넌스")이며, "리스크 · 반발" 그룹은 반드시 채워야 합니다(편향, 오탈락, 노동계 반발, 청년 고용 위축, 감원 명분화 비판 등).
- claims 전체에서 최소 1개 이상은 유튜브 영상(srcUrl에 youtube.com 또는 youtu.be 포함) 출처를 사용하세요.
- 긍정/우려 비중이 한쪽으로 치우치지 않게 하세요.
- chart.bars는 3~4개, 없으면 빈 배열로.`;

// ─────────────────────────────────────────────────────────
// STEP 2C: pillar "work" + pillar "hrd" + overallReview
// ─────────────────────────────────────────────────────────
const PART_C_SYSTEM = `${COMMON_RULES}

출력 스키마:
{
  "pillars": {
    "work": {
      "id": "work", "color": "work", "eyebrow": "PILLAR 03 · WORK REVIEW", "icon": "🧭",
      "title": "직무 · 일하는 방식 변화 리뷰",
      "framing": "이 섹션을 관통하는 흐름 1~2문장",
      "cards": [${CARD_SCHEMA}, ${CARD_SCHEMA}, ${CARD_SCHEMA}],
      ${PILLAR_TAIL_SCHEMA}
    },
    "hrd": {
      "id": "hrd", "color": "hrd", "eyebrow": "PILLAR 04 · HRD REVIEW", "icon": "🎓",
      "title": "HRD · 교육개발 변화 리뷰",
      "framing": "이 섹션을 관통하는 흐름 1~2문장 (교육 예산·리스킬링·AI 교육 등)",
      "cards": [${CARD_SCHEMA}, ${CARD_SCHEMA}, ${CARD_SCHEMA}],
      ${PILLAR_TAIL_SCHEMA}
    }
  },
  "overallReview": "전체 리뷰 3~4문장. 반드시 '최근 1~2주' 기간을 명시하며 이슈·기술·근무방식·HRD 네 축을 요약하고, 기술 변화에 대해 성과와 우려를 함께 언급해 중립적 톤을 유지할 것. 도출된 시사점으로 마무리."
}

work 섹션 cards 중 최소 1개는 감원·구조조정·임금 불만 등 근무 변화의 부담이 되는 측면도 함께 다루세요.
hrd 섹션은 리스킬링·업스킬링 우선순위, 기업 교육 예산 전망, AI 교육/LXP 도입 등 검색 데이터의 "HRD·교육개발" 항목을 바탕으로 작성하세요. deepDive는 없으면 null로 두세요.
overallReview는 필수입니다. "다음 호 예고" 같은 필드는 만들지 마세요.`;

// ─────────────────────────────────────────────────────────
// JSON 파서 (5단계 fallback)
// ─────────────────────────────────────────────────────────
function parseJSON(raw) {
  let s = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("JSON 블록 없음");
  s = s.slice(a, b + 1);

  try { return JSON.parse(s); } catch (_) {}
  try { return JSON.parse(s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")); } catch (_) {}
  try {
    const f = s.replace(/"((?:[^"\\]|\\.)*)"/g, (_, inner) =>
      `"${inner.replace(/\n/g, "\\n").replace(/\r/g, "").replace(/\t/g, "\\t")}"`);
    return JSON.parse(f);
  } catch (_) {}
  try {
    return JSON.parse(s
      .replace(/[‘’“”]/g, "'")
      .replace(/\\'/g, "'")
      .replace(/([^\\])\\([^"\\/bfnrtu])/g, "$1$2"));
  } catch (_) {}

  throw new Error("모든 파싱 시도 실패");
}

async function generateJSON(system, label) {
  const text = await withRetry(() =>
    client.responses.create({
      model: MODEL,
      instructions: system,
      input: `Vol: ${VOL} / 날짜: ${DATE}\n\n아래 실제 검색 데이터를 바탕으로 JSON을 생성하세요:\n\n${searchDataGlobal}`,
      // "json_object" 모드: 순수 JSON 문자열만 받도록 강제 (프롬프트에도 "JSON만 출력"을 명시)
      text: { format: { type: "json_object" } },
      max_output_tokens: 4000,
    }).then((r) => (r.output_text || "").trim()),
    label
  );
  console.log(`   ✅ ${label} 완료 (${text.length}자)`);
  try {
    const parsed = parseJSON(text);
    console.log(`   ✅ ${label} 파싱 성공`);
    return parsed;
  } catch (e) {
    console.error(`   ⚠️ ${label} 파싱 실패: ${e.message}`);
    return {};
  }
}

let searchDataGlobal = "";

// ─────────────────────────────────────────────────────────
// 렌더러 (JSON → HTML) — 화이트모드, 문구 단위 출처 태깅(기사·영상),
// 기술 섹션 서브그룹+타임라인, PDF 저장, '다음 호 예고' 없음
// ─────────────────────────────────────────────────────────
function esc(s) { return s == null ? "" : String(s); }
function isVideo(url) { return /youtube\.com|youtu\.be/i.test(url || ""); }

function src(item) {
  if (!item || !item.srcUrl) return null;
  return { name: item.srcName || "출처", url: item.srcUrl };
}

function cite(s, color) {
  if (!s) return "";
  const icon = isVideo(s.url) ? "🎥" : "🔗";
  return ` <a class="tag tag-${color}" href="${esc(s.url)}" target="_blank" rel="noopener">${icon} ${esc(s.name)}</a>`;
}

function renderClaims(claims, color) {
  return (claims || []).map((c) => `<p class="claim">${esc(c.text)}${cite(src(c), color)}</p>`).join("");
}

function renderCards(cards, color) {
  return (cards || []).map((c) => `
    <article class="card">
      <div class="card-head"><span class="card-tag card-tag-${color}">${esc(c.tag)}</span><h4>${esc(c.title)}</h4></div>
      <div class="card-body">${renderClaims(c.claims, color)}</div>
    </article>`).join("");
}

function renderGroups(groups, color) {
  if (!groups) return "";
  return groups.map((g) => `
    <div class="group">
      <div class="group-label">${esc(g.label)}</div>
      <div class="card-stack">${renderCards(g.cards, color)}</div>
    </div>`).join("");
}

function renderTimeline(items, color) {
  if (!items || !items.length) return "";
  return `
    <div class="timeline">
      <div class="timeline-title">이번 주 타임라인 · 최근 2주</div>
      <ol>
        ${items.map((t) => `
          <li>
            <span class="tl-date tl-${color}">${esc(t.date)}</span>
            <span class="tl-text">${esc(t.text)}${cite(src(t), color)}</span>
          </li>`).join("")}
      </ol>
    </div>`;
}

function renderChart(chart, color) {
  if (!chart || !(chart.bars || []).length) return "";
  return `
    <div class="chart">
      <div class="chart-title">${esc(chart.title)}</div>
      ${chart.bars.map((b) => `
        <div class="bar-row">
          <div class="bar-top">
            <span class="bar-lbl">${esc(b.label)}${cite(src(b), color)}</span>
            <span class="bar-pct">${b.value}%</span>
          </div>
          <div class="bar-track"><div class="bar-fill bar-${color}" style="width:${Math.min(Number(b.value) || 0, 100)}%"></div></div>
        </div>`).join("")}
    </div>`;
}

function renderDeepDive(dd, color) {
  if (!dd || !dd.title) return "";
  return `
    <details class="deepdive">
      <summary><span class="dd-badge dd-badge-${color}">심층</span>${esc(dd.title)}<span class="dd-chevron">▾</span></summary>
      <div class="dd-body">
        ${(dd.paragraphs || []).map((p) => `<p>${esc(p.text)}${cite(src(p), color)}</p>`).join("")}
      </div>
    </details>`;
}

function dedupeSources(p) {
  const map = new Map();
  const add = (s) => { if (s && !map.has(s.url)) map.set(s.url, s); };
  (p.cards || []).forEach((c) => (c.claims || []).forEach((cl) => add(src(cl))));
  (p.groups || []).forEach((g) => (g.cards || []).forEach((c) => (c.claims || []).forEach((cl) => add(src(cl)))));
  (p.timeline || []).forEach((t) => add(src(t)));
  ((p.chart || {}).bars || []).forEach((b) => add(src(b)));
  ((p.deepDive || {}).paragraphs || []).forEach((pp) => add(src(pp)));
  return [...map.values()];
}

function renderPillar(p) {
  if (!p || !p.id) return "";
  const cardsBlock = p.groups ? renderGroups(p.groups, p.color) : `<div class="card-stack">${renderCards(p.cards, p.color)}</div>`;
  return `
  <section class="pillar" id="${esc(p.id)}">
    <header class="pillar-head pillar-head-${p.color}">
      <span class="pillar-icon">${esc(p.icon)}</span>
      <div>
        <div class="pillar-eyebrow">${esc(p.eyebrow)}</div>
        <h2>${esc(p.title)}</h2>
      </div>
    </header>
    <p class="pillar-framing">${esc(p.framing)}</p>
    ${renderTimeline(p.timeline, p.color)}
    ${cardsBlock}
    ${renderChart(p.chart, p.color)}
    ${renderDeepDive(p.deepDive, p.color)}
    <div class="insight insight-${p.color}">
      <span class="insight-label">시사점</span>
      <p>${esc(p.insight)}</p>
    </div>
    <div class="chip-row">${(p.keywords || []).map((k) => `<span class="chip chip-${p.color}">${esc(k)}</span>`).join("")}</div>
    <div class="cite-index">
      <div class="cite-index-label">이 섹션에서 인용한 자료</div>
      <ul>${dedupeSources(p).map((s) => `<li>${isVideo(s.url) ? "🎥" : "🔗"} <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a></li>`).join("")}</ul>
    </div>
  </section>`;
}

function generateHTML(data) {
  const statsHtml = (data.stats || []).map((s) => `
    <div class="stat">
      <div class="stat-num stat-${s.color || "issue"}">${esc(s.num)}</div>
      <div class="stat-desc">${esc(s.desc)}</div>
      <div class="stat-change">${esc(s.change)}</div>
      ${src(s) ? `<a class="stat-src" href="${esc(src(s).url)}" target="_blank" rel="noopener">${esc(src(s).name)} ↗</a>` : ""}
    </div>`).join("");

  const pillars = [data.pillars?.issue, data.pillars?.tech, data.pillars?.work, data.pillars?.hrd].filter(Boolean);
  const navHtml = pillars.map((p) => `<a class="nav-pill nav-pill-${p.color}" href="#${esc(p.id)}"><span>${esc(p.icon)}</span>${esc((p.title || "").split(" — ").pop().split(" · ").pop())}</a>`).join("");
  const pillarsHtml = pillars.map(renderPillar).join("");

  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>HR 트렌드 주간 보고서 | ${YEAR} Vol.${data.meta?.vol || VOL}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=Gothic+A1:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#FAFAF8; --paper-raised:#FFFFFF; --paper-sunken:#F1F1EC; --ink:#24272C; --muted:#666B72; --divider:#E4E5E1;
  --issue:#45529A; --issue-tint:#ECEEF9; --issue-tint-strong:#D8DCF2;
  --tech:#12816E; --tech-tint:#E2F3EE; --tech-tint-strong:#C7E9DF;
  --work:#A9631E; --work-tint:#FBEEDC; --work-tint-strong:#F3DCB8;
  --hrd:#7C5295; --hrd-tint:#F0E9F5; --hrd-tint-strong:#E1D0EA;
  --chip-bg:#EFEFEB;
  --fd:"Gowun Batang",serif; --fb:"Gothic A1",sans-serif; --fm:"IBM Plex Mono",monospace;
}
*{margin:0;padding:0;box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;}
body{background:var(--paper);color:var(--ink);font-family:var(--fb);font-size:17px;line-height:1.75;font-feature-settings:"tnum" 1;word-break:keep-all;overflow-wrap:break-word;}
.wrap{max-width:820px;margin:0 auto;padding:56px 24px 120px;}
a{color:inherit;}
::selection{background:var(--issue-tint-strong);}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:40px;flex-wrap:wrap;}
.brand{font-family:var(--fm);font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);font-weight:600;}
.issue-tag{font-family:var(--fm);font-size:13px;letter-spacing:1px;color:var(--ink);background:var(--chip-bg);padding:6px 14px;border-radius:999px;}
.hero{background:var(--issue-tint);border:1px solid var(--issue-tint-strong);border-top:4px solid var(--issue);color:var(--ink);border-radius:16px;padding:44px 40px;margin-bottom:44px;}
.hero-eyebrow{font-family:var(--fm);font-size:13px;letter-spacing:3px;text-transform:uppercase;color:var(--issue);margin-bottom:18px;font-weight:600;}
.hero h1{font-family:var(--fd);font-weight:700;font-size:clamp(30px,4.6vw,46px);line-height:1.3;text-wrap:balance;margin-bottom:20px;color:var(--ink);}
.hero p{font-size:17.5px;line-height:1.85;color:#41454C;max-width:64ch;}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:20px;}
.stat{background:var(--paper-raised);border:1px solid var(--divider);border-radius:14px;padding:20px 16px;display:flex;flex-direction:column;gap:6px;}
.stat-num{font-family:var(--fd);font-weight:700;font-size:28px;line-height:1;}
.stat-issue{color:var(--issue);}.stat-tech{color:var(--tech);}.stat-work{color:var(--work);}.stat-hrd{color:var(--hrd);}
.stat-desc{font-size:13px;color:var(--muted);line-height:1.5;}
.stat-change{font-family:var(--fm);font-size:11.5px;color:var(--muted);}
.stat-src{font-family:var(--fm);font-size:11px;color:var(--muted);text-decoration:none;border-bottom:1px dotted var(--divider);margin-top:2px;width:fit-content;}
.stat-src:hover{color:var(--ink);}
.pillar-nav{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:56px;}
.nav-pill{display:flex;align-items:center;gap:8px;font-family:var(--fb);font-weight:700;font-size:14.5px;padding:12px 20px;border-radius:999px;text-decoration:none;border:1.5px solid var(--divider);}
.nav-pill span{font-size:18px;}
.nav-pill-issue{border-color:var(--issue);color:var(--issue);}
.nav-pill-tech{border-color:var(--tech);color:var(--tech);}
.nav-pill-work{border-color:var(--work);color:var(--work);}
.nav-pill-hrd{border-color:var(--hrd);color:var(--hrd);}
.pillar{margin-bottom:76px;scroll-margin-top:24px;}
.pillar-head{display:flex;align-items:center;gap:18px;padding-bottom:22px;margin-bottom:22px;border-bottom:3px solid var(--divider);}
.pillar-icon{font-size:36px;line-height:1;flex-shrink:0;}
.pillar-eyebrow{font-family:var(--fm);font-size:12.5px;letter-spacing:2.5px;text-transform:uppercase;color:var(--muted);margin-bottom:6px;}
.pillar-head h2{font-family:var(--fd);font-weight:700;font-size:clamp(24px,3.4vw,32px);text-wrap:balance;color:var(--ink);}
.pillar-head-issue .pillar-eyebrow{color:var(--issue);}
.pillar-head-tech .pillar-eyebrow{color:var(--tech);}
.pillar-head-work .pillar-eyebrow{color:var(--work);}
.pillar-head-hrd .pillar-eyebrow{color:var(--hrd);}
.pillar-framing{font-size:18px;line-height:1.85;color:var(--muted);margin-bottom:26px;max-width:66ch;}
.timeline{background:var(--paper-sunken);border:1px solid var(--divider);border-radius:16px;padding:22px 26px;margin-bottom:24px;}
.timeline-title{font-family:var(--fm);font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:16px;}
.timeline ol{list-style:none;display:flex;flex-direction:column;gap:12px;}
.timeline li{display:flex;gap:14px;align-items:baseline;}
.tl-date{font-family:var(--fm);font-size:12.5px;font-weight:700;padding:2px 9px;border-radius:6px;flex-shrink:0;white-space:nowrap;}
.tl-issue{background:var(--issue-tint-strong);color:var(--issue);}
.tl-tech{background:var(--tech-tint-strong);color:var(--tech);}
.tl-work{background:var(--work-tint-strong);color:var(--work);}
.tl-hrd{background:var(--hrd-tint-strong);color:var(--hrd);}
.tl-text{font-size:15px;line-height:1.7;color:var(--ink);}
.group{margin-bottom:22px;}
.group-label{font-family:var(--fm);font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:12px;padding-left:10px;border-left:3px solid var(--divider);}
.card-stack{display:flex;flex-direction:column;gap:16px;margin-bottom:8px;}
.card{background:var(--paper-raised);border:1px solid var(--divider);border-radius:16px;padding:24px 26px;}
.card-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px;flex-wrap:wrap;}
.card-tag{font-family:var(--fm);font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-weight:600;padding:4px 10px;border-radius:6px;}
.card-tag-issue{background:var(--issue-tint);color:var(--issue);}
.card-tag-tech{background:var(--tech-tint);color:var(--tech);}
.card-tag-work{background:var(--work-tint);color:var(--work);}
.card-tag-hrd{background:var(--hrd-tint);color:var(--hrd);}
.card-head h4{font-family:var(--fb);font-weight:800;font-size:19px;line-height:1.4;color:var(--ink);}
.card-body{display:flex;flex-direction:column;gap:10px;}
.claim{font-size:16px;line-height:1.8;color:var(--ink);}
.tag{display:inline-block;font-family:var(--fm);font-size:12px;font-weight:500;text-decoration:none;padding:2px 9px;border-radius:6px;white-space:nowrap;margin-left:2px;border-bottom:none;}
.tag-issue{background:var(--issue-tint);color:var(--issue);}
.tag-tech{background:var(--tech-tint);color:var(--tech);}
.tag-work{background:var(--work-tint);color:var(--work);}
.tag-hrd{background:var(--hrd-tint);color:var(--hrd);}
.tag:hover{background:var(--issue-tint-strong);}
.tag-tech:hover{background:var(--tech-tint-strong);}
.tag-work:hover{background:var(--work-tint-strong);}
.tag-hrd:hover{background:var(--hrd-tint-strong);}
.chart{background:var(--paper-raised);border:1px solid var(--divider);border-radius:16px;padding:24px 26px;margin-bottom:24px;}
.chart-title{font-family:var(--fm);font-size:12.5px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:20px;}
.bar-row{margin-bottom:20px;}
.bar-row:last-child{margin-bottom:0;}
.bar-top{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:9px;flex-wrap:wrap;}
.bar-lbl{font-size:14.5px;color:var(--muted);line-height:1.6;}
.bar-track{width:100%;background:var(--chip-bg);height:11px;border-radius:6px;overflow:hidden;}
.bar-fill{height:100%;border-radius:6px;}
.bar-issue{background:var(--issue);}.bar-tech{background:var(--tech);}.bar-work{background:var(--work);}.bar-hrd{background:var(--hrd);}
.bar-pct{font-family:var(--fm);font-size:14.5px;font-weight:700;color:var(--ink);flex-shrink:0;}
.deepdive{background:var(--paper-raised);border:1px solid var(--divider);border-radius:16px;margin-bottom:24px;overflow:hidden;}
.deepdive summary{list-style:none;cursor:pointer;padding:18px 26px;display:flex;align-items:center;gap:12px;font-weight:800;font-size:16px;color:var(--ink);}
.deepdive summary::-webkit-details-marker{display:none;}
.dd-badge{font-family:var(--fm);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#fff;padding:3px 10px;border-radius:6px;flex-shrink:0;}
.dd-badge-issue{background:var(--issue);}.dd-badge-tech{background:var(--tech);}.dd-badge-work{background:var(--work);}.dd-badge-hrd{background:var(--hrd);}
.dd-chevron{margin-left:auto;color:var(--muted);transition:transform .2s;font-size:14px;}
.deepdive[open] .dd-chevron{transform:rotate(180deg);}
.dd-body{padding:0 26px 22px;display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--divider);padding-top:16px;}
.dd-body p{font-size:15.5px;line-height:1.85;color:var(--ink);}
.insight{border-radius:16px;padding:22px 26px;margin-bottom:16px;display:flex;flex-direction:column;gap:10px;}
.insight-label{font-family:var(--fm);font-size:11.5px;letter-spacing:2.5px;text-transform:uppercase;font-weight:700;width:fit-content;padding:4px 12px;border-radius:999px;}
.insight p{font-family:var(--fd);font-size:18px;line-height:1.75;font-weight:700;text-wrap:balance;color:var(--ink);}
.insight-issue{background:var(--issue-tint);}
.insight-issue .insight-label{background:var(--issue);color:#fff;}
.insight-tech{background:var(--tech-tint);}
.insight-tech .insight-label{background:var(--tech);color:#fff;}
.insight-work{background:var(--work-tint);}
.insight-hrd{background:var(--hrd-tint);}
.insight-work .insight-label{background:var(--work);color:#fff;}
.insight-hrd .insight-label{background:var(--hrd);color:#fff;}
.chip-row{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:16px;}
.chip{font-family:var(--fb);font-weight:600;font-size:14px;padding:7px 16px;border-radius:999px;}
.chip-issue{background:var(--issue-tint);color:var(--issue);}
.chip-tech{background:var(--tech-tint);color:var(--tech);}
.chip-work{background:var(--work-tint);color:var(--work);}
.chip-hrd{background:var(--hrd-tint);color:var(--hrd);}
.cite-index{border-top:1px dashed var(--divider);padding-top:16px;}
.cite-index-label{font-family:var(--fm);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;}
.cite-index ul{list-style:none;display:flex;flex-direction:column;gap:5px;}
.cite-index a{font-size:13px;color:var(--muted);text-decoration:none;border-bottom:1px dotted var(--divider);}
.cite-index a:hover{color:var(--ink);}
.editor{background:var(--paper-sunken);border:1px solid var(--divider);border-top:4px solid var(--issue);border-radius:16px;padding:40px 40px;margin-bottom:28px;}
.editor-label{font-family:var(--fm);font-size:12.5px;letter-spacing:2.5px;text-transform:uppercase;color:var(--issue);margin-bottom:16px;font-weight:600;}
.editor p{font-family:var(--fd);font-size:19px;line-height:1.9;color:var(--ink);text-wrap:balance;}
.footer{margin-top:44px;padding-top:24px;border-top:1px solid var(--divider);display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;}
.footer-brand{font-family:var(--fd);font-weight:700;font-size:17px;}
.footer-meta{font-family:var(--fm);font-size:12px;color:var(--muted);text-align:right;line-height:1.7;}
@media(max-width:680px){
  .wrap{padding:32px 18px 90px;}
  .hero{padding:32px 24px;border-radius:16px;}
  .stats{grid-template-columns:repeat(2,1fr);}
  .pillar-head{align-items:flex-start;}
  .pdf-btn{right:16px;bottom:16px;padding:12px 16px;}
  .pdf-btn span{display:none;}
  .timeline li{flex-direction:column;gap:4px;}
}
.pdf-btn{position:fixed;right:28px;bottom:28px;display:flex;align-items:center;gap:8px;font-family:var(--fb);font-weight:700;font-size:14px;color:#fff;background:var(--ink);border:none;border-radius:999px;padding:13px 22px;cursor:pointer;box-shadow:0 6px 20px rgba(36,39,44,.2);}
.pdf-btn:hover{background:var(--issue);}
.pdf-btn:focus-visible{outline:2px solid var(--issue);outline-offset:3px;}
@media print{
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  @page{margin:14mm;}
  body{font-size:12.5px;orphans:3;widows:3;word-break:keep-all;overflow-wrap:break-word;}
  .no-print,.pdf-btn,.pillar-nav{display:none !important;}
  .wrap{max-width:none;padding:0;}
  .pillar{margin-bottom:34px;break-inside:auto;}
  .pillar-head{break-after:avoid;page-break-after:avoid;}
  .card,.chart,.deepdive,.timeline,.stat,.insight{break-inside:avoid;page-break-inside:avoid;}
  .card-body,.dd-body{break-inside:avoid;page-break-inside:avoid;}
  .deepdive .dd-chevron{display:none;}
  .tag::after{content:" (" attr(href) ")";font-size:9.5px;color:var(--muted);word-break:break-all;}
  a{text-decoration:none;}
}
</style></head><body>
<div class="wrap">
  <div class="masthead">
    <span class="brand">HR 트렌드 주간 보고서</span>
    <span class="issue-tag">Vol.${esc(data.meta?.vol || VOL)} · ${esc(data.meta?.date || DATE)}</span>
  </div>
  <div class="hero">
    <div class="hero-eyebrow">이번 주 핵심 메시지</div>
    <h1>${esc(data.meta?.headline)}</h1>
    <p>${esc(data.meta?.subheadline)}</p>
  </div>
  <div class="stats">${statsHtml}</div>
  <nav class="pillar-nav">${navHtml}</nav>
  ${pillarsHtml}
  <section class="editor" id="review">
    <div class="editor-label">전체 리뷰</div>
    <p>${esc(data.overallReview)}</p>
  </section>
  <div class="footer">
    <div class="footer-brand">HR 트렌드 주간 보고서</div>
    <div class="footer-meta">${YEAR} Vol.${esc(data.meta?.vol || VOL)} · Web + Video Search + AI<br>${esc(data.meta?.date || DATE)}<br>생성 시각: ${esc(data.generatedAt || GENERATED_AT)}</div>
  </div>
</div>
<button class="pdf-btn no-print" onclick="window.print()" aria-label="이 보고서를 PDF로 저장">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h9l3 3v4"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>
  <span>PDF로 저장</span>
</button>
<script>
(function(){
  window.addEventListener("beforeprint", function(){
    document.querySelectorAll("details").forEach(function(d){
      d.dataset.wasOpen = d.open ? "1" : "0";
      d.open = true;
    });
  });
  window.addEventListener("afterprint", function(){
    document.querySelectorAll("details").forEach(function(d){
      d.open = d.dataset.wasOpen === "1";
    });
  });
})();
</script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 HR 트렌드 보고서 생성 시작`);
  console.log(`   Vol.${VOL} / ${DATE} / ${TOPIC}\n`);

  console.log("🔍 Step 1: 웹검색으로 실제 데이터 수집 중 (최근 1~2주 우선, 기사+영상, 균형 수집)...");
  searchDataGlobal = await withRetry(() => collectSearchData(), "웹검색");
  console.log("");

  console.log("⏸  Rate limit 방지 대기 중 (65초)...");
  await sleep(RATE_LIMIT_WAIT_MS);
  console.log("   ✅ 대기 완료\n");

  console.log("📋 Step 2A: meta·stats·이슈 필러 생성...");
  const partA = await generateJSON(PART_A_SYSTEM, "Part A (이슈)");

  console.log("⏸  Rate limit 방지 대기 중 (65초)...");
  await sleep(RATE_LIMIT_WAIT_MS);
  console.log("   ✅ 대기 완료\n");

  console.log("📋 Step 2B: 기술 필러 생성 (타임라인·서브그룹·리스크 카드 포함)...");
  const partB = await generateJSON(PART_B_SYSTEM, "Part B (기술)");

  console.log("⏸  Rate limit 방지 대기 중 (65초)...");
  await sleep(RATE_LIMIT_WAIT_MS);
  console.log("   ✅ 대기 완료\n");

  console.log("📋 Step 2C: 근무방식·HRD 필러·전체 리뷰 생성...");
  const partC = await generateJSON(PART_C_SYSTEM, "Part C (근무방식·HRD)");

  console.log("\n🔧 JSON 병합 중...");
  const merged = {
    meta: { ...(partA.meta || {}), vol: String(VOL), date: DATE },
    stats: partA.stats || [],
    pillars: {
      issue: partA.pillar || null,
      tech: partB.pillar || null,
      work: partC.pillars?.work || null,
      hrd: partC.pillars?.hrd || null,
    },
    overallReview: partC.overallReview || "",
    // 파이프라인 전체(검색 + 3회 생성 + 대기)가 끝난 실제 완료 시각 —
    // 모듈 로드 시점(GENERATED_AT)이 아니라 지금 다시 계산해서 실제 반영 시각과
    // 최대한 가깝게 맞춥니다.
    generatedAt: getKoreanDateTime(),
  };
  const pillarCount = Object.values(merged.pillars).filter(Boolean).length;
  console.log(`   📊 필러 ${pillarCount}/4개 · 통계 ${merged.stats.length}개`);

  const html = generateHTML(merged);
  fs.writeFileSync(path.join(process.cwd(), "index.html"), html, "utf-8");
  console.log(`\n✅ 완료! index.html 저장 (${html.length}자)`);
  console.log(`   👉 https://sehoonkim75.github.io/hrtrend\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\n❌ 오류:", err.message);
    process.exit(1);
  });
}

module.exports = { generateHTML, parseJSON };
