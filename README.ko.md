# jlcpcb-skill-mcp

[English](README.md) | **한국어** | [📖 문서 사이트](https://hulryung.github.io/jlcpcb-skill-mcp/)

KiCad 회로에서 곧바로 JLCPCB/LCSC 부품을 찾아 **조립 비용까지 고려해 추천**하는 MCP 서버 + Claude 스킬.

단순 검색이 아니라 부품 **선정**을 자동화합니다:

- **Basic > Preferred > Extended 티어 우선** — Extended는 부품 종류당 $3 로딩피가 붙습니다 (Basic 무료, Preferred Extended는 Economic PCBA에서 면제)
- **재고 리스크 평가** — 필요 수량의 5~10배 재고 확보 여부 검사
- **수량별 가격** — 주문 수량 구간의 실제 단가로 계산
- **KiCad 통합** — `.kicad_sch` 회로도/BOM CSV를 직접 파싱해서 LCSC 부품번호로 매칭
- **패키지 통합 힌트** — 같은 값이 0603/0805로 흩어져 있으면 릴 교체 절약 제안

데이터는 [jlcsearch](https://github.com/tscircuit/jlcsearch) (tscircuit)의 공개 API를 사용합니다.

## 데모

명령 하나로 예제 ESP32-C3 보드가 회로도에서 티어·비용이 계산된 BOM으로 (라이브 데이터):

![데모 — 예제 ESP32-C3 보드의 JLCPCB 부품 추천](docs/demo.gif)

([MP4](docs/demo.mp4)로도 제공. 재녹화는 `vhs docs/demo.tape`.)

## 빠른 시작

```bash
npm install
npm run build
```

이 저장소에는 `.mcp.json`이 포함되어 있어 Claude Code로 이 디렉토리를 열면 서버가 자동 등록됩니다.

부품 선정 노하우가 담긴 스킬(`.claude/skills/jlcpcb-parts/`)도 함께 로드됩니다 — "이 회로에 맞는 부품 골라줘"라고 하면 스킬이 티어/재고/가격 규칙에 따라 도구들을 순서대로 호출합니다.

## 다른 프로젝트·전역에서 사용하기

**가장 쉬운 방법 — 플러그인 설치** (스킬+MCP 한 번에, 클론/빌드 불필요):

```
/plugin marketplace add hulryung/jlcpcb-skill-mcp
/plugin install jlcpcb-parts@jlcpcb-tools
```

플러그인으로 설치했다면 아래 1)·2)의 수동 등록은 필요 없습니다. 로컬 체크아웃으로 개발하면서 쓰고 싶을 때만 해당됩니다.

**1) MCP 서버를 user 스코프로 등록** — 모든 프로젝트에 적용:

```bash
claude mcp add --scope user jlcpcb-parts -- node /path/to/jlcpcb-skill-mcp/dist/index.js
claude mcp list   # "✔ Connected" 확인
```

해제는 `claude mcp remove jlcpcb-parts -s user`. (이 저장소 안에서는 프로젝트 스코프 `.mcp.json`이 함께 잡혀 중복 경고가 뜨는데, 같은 서버라 무해합니다.)

**2) 스킬을 전역(personal)으로 설치** — 심링크라 저장소를 업데이트하면 자동 반영:

```bash
ln -sfn /path/to/jlcpcb-skill-mcp/.claude/skills/jlcpcb-parts ~/.claude/skills/jlcpcb-parts
```

**3) KiCad와 함께 쓰는 워크플로우** — KiCad 자체는 MCP 클라이언트가 아니므로 통합은 "터미널을 옆에 두는" 방식입니다:

```bash
cd ~/dev/my-board          # .kicad_sch가 있는 프로젝트
claude
> 이 회로에 맞는 부품 골라줘. 50장 생산 기준으로.
```

스킬이 자동 트리거되어 `analyze_kicad` → `suggest_bom_parts` → 리뷰 라인 해결 → 비용 산출까지 진행하고, 회로도의 LCSC 필드/풋프린트 수정을 요청하면 파일을 직접 고쳐줍니다. **회로도를 고친 뒤에는 KiCad에서 F8(Update PCB from Schematic)로 PCB에 반영**하는 것만 잊지 마세요. 계층 회로도(hierarchical sheets)는 루트 파일만 넘기면 하위 시트를 자동 추적합니다.

**4) Claude Desktop / 다른 MCP 클라이언트에서** — stdio 서버라 어디든 붙습니다. Claude Desktop은 `~/Library/Application Support/Claude/claude_desktop_config.json`에:

```json
{
  "mcpServers": {
    "jlcpcb-parts": {
      "command": "node",
      "args": ["/path/to/jlcpcb-skill-mcp/dist/index.js"]
    }
  }
}
```

저장 후 Desktop 앱을 완전히 종료했다가 재시작하면 적용됩니다. (단, 스킬은 Claude Code 전용이므로 Desktop에서는 도구만 쓸 수 있습니다.)

**업데이트 시**: `git pull && npm install && npm run build` — 등록은 `dist/index.js` 경로를 가리키므로 재등록이 필요 없습니다.

## 팀 배포: GitHub·npm·원격 서버

로컬 경로 없이 배포하는 방법 세 가지입니다.

**A) Claude Code 플러그인 (권장 — 스킬+MCP를 한 번에)**

이 저장소는 플러그인 겸 마켓플레이스로 구성돼 있습니다(`.claude-plugin/plugin.json` + `marketplace.json`, 의존성 포함 단일 번들 `dist-plugin/index.mjs` 커밋). 팀원은 클론·빌드 없이:

```
/plugin marketplace add hulryung/jlcpcb-skill-mcp
/plugin install jlcpcb-parts@jlcpcb-tools
```

스킬과 MCP 서버가 함께 설치되고, `/plugin` 메뉴에서 업데이트/제거할 수 있습니다. 서버 코드를 고치면 `npm run bundle`로 번들을 갱신해 커밋해야 반영됩니다. 단일 플러그인을 마켓플레이스 없이 직접 설치하는 방식은 지원되지 않아 marketplace.json이 필수입니다(이미 포함).

**B) npm 배포 (MCP만)**

```bash
npm publish           # 이후 사용자는:
claude mcp add jlcpcb-parts -- npx -y jlcpcb-parts-mcp
```

npx가 캐시하므로 세션마다 재설치하지 않습니다. 스킬은 별도로 배포해야 하므로(A안이 해결) MCP만 필요할 때 적합합니다. `npx github:owner/repo` 형태의 GitHub 직접 실행은 지원되지 않습니다.

**C) 원격 HTTP 서버 (설치 제로)**

현재 서버는 stdio 전용이지만, MCP SDK의 StreamableHTTP 트랜스포트를 붙여 서버(자체 서버, Cloudflare Workers 등)에 올리면 팀 전체가 Node 설치 없이 URL만으로 씁니다:

```bash
claude mcp add --transport http jlcpcb-parts https://jlcpcb-mcp.example.com/mcp
```

사내 공유에 가장 편하지만 호스팅 운영이 필요하고, 스킬은 역시 별도 배포(A안 병행)입니다. 필요 시 HTTP 트랜스포트 추가는 작은 작업입니다.

## MCP 도구 (7종)

| 도구 | 역할 |
|---|---|
| `search_parts` | 자유 텍스트 검색 (패키지·티어·최소재고 필터) |
| `search_passives` | R/C 파라메트릭 검색 — `"10k"`, `"4k7"`, `"100nF"` 표기 인식 |
| `get_part` | LCSC 번호로 상세 조회 (수량별 가격, 속성 포함) |
| `find_alternatives` | 동일 스펙 대체품 탐색 (티어/재고/가격 순 랭킹) |
| `analyze_kicad` | `.kicad_sch` / BOM CSV → BOM 라인 추출 (DNP·LCSC 필드 인식) |
| `suggest_bom_parts` | BOM 전체 일괄 매칭 + 랭킹 + 비용 계산 (핵심 도구) |
| `estimate_assembly_cost` | 선택된 부품 목록의 부품비 + 로딩피 산출 |

## 실행 예시 (실제 출력)

예제 회로 `examples/esp32c3-sensor`(ESP32-C3 + AMS1117 + USB-C + 수동부품 15개)를 20장 생산 기준으로:

```bash
npm run demo
```

| Refs | Qty | Value | Pkg | LCSC | Tier | Stock | Unit | Status |
|---|---|---|---|---|---|---|---|---|
| J1 | 1 | USB-C | — | C165948 | extended | 336,394 | $0.16 | preassigned |
| U2 | 1 | AMS1117-3.3 | SOT-223 | C6186 | **basic** | 1,490,681 | $0.15 | preassigned |
| U1 | 1 | ESP32-C3 | QFN-32 | C2838500 | extended | 8,750 | $1.55 | needs_review |
| R1 R2 | 2 | 10k | 0603 | C25804 | **basic** | 37,165,617 | $0.0008 | matched |
| R3 R4 | 2 | 5.1k | 0603 | C23186 | **basic** | 7,571,904 | $0.0009 | matched |
| C1 C2 | 2 | 100nF | 0603 | C14663 | **basic** | 81,299,425 | $0.0022 | matched |
| … | | | | | | | | |

```
Components $39.05 + Loading fees $9.00 (extended 3종 × $3) = $48.05  ($2.40/board)
needs review: U1 (IC 텍스트 매칭 — 풋프린트 확인), SW1 (스위치 텍스트 매칭)
```

수동부품은 전부 재고 수백만 개의 basic 파트로 매칭되고, 확신이 부족한 매칭(IC 텍스트 검색, 패키지 prefix 일치)은 자동 승인 대신 `needs_review`로 표시됩니다.

## 부품 선정 규칙 (엔진 + 스킬에 인코딩)

1. **하드 필터**: 재고 0 제외, 저항 ±0.5% / 커패시턴스 ±5% 값 일치, 패키지 일치(수동부품은 정확일치, IC류는 prefix 허용 + 리뷰 flag), 공차 요구치 이하
2. **점수**: 티어(basic +100 / preferred +60 / extended +0) → 재고 적정성(+25 + 심도 보너스) → 가격(+15) → 공차(+3)
3. **비용**: 로딩피는 고유 extended 부품당 1회만 계산 (여러 라인에서 같은 부품 사용 시 중복 없음)

## 한계와 주의

- jlcsearch는 JLCPCB의 **비공식** 미러 데이터입니다. 재고·가격은 스냅샷이므로 **주문 직전 `get_part`로 재확인**하세요.
- IC/커넥터의 텍스트 매칭은 편의 기능입니다 — MPN과 데이터시트를 반드시 확인하세요 (`needs_review`가 그 신호입니다).
- KiCad 6~9 `.kicad_sch`와 일반적인 BOM CSV 내보내기 형식을 지원합니다.

## 개발

```bash
npm test          # 전체 테스트 (vitest)
npm run demo      # 라이브 E2E 데모
node scripts/smoke-mcp.mjs  # 빌드된 서버 stdio 스모크 테스트
```

구조: `src/kicad`(파서) · `src/jlc`(API 클라이언트) · `src/engine`(랭킹/비용) · `src/tools`(MCP 도구) — 모듈 계약은 `CONTRACTS.md`, API 실측 노트는 `docs/jlcsearch-api-notes.md`.

## 크레딧

- 데이터: [tscircuit/jlcsearch](https://github.com/tscircuit/jlcsearch), 원천 데이터 파이프라인 [yaqwsx/jlcparts](https://github.com/yaqwsx/jlcparts)
- JLCPCB/LCSC와 무관한 비공식 프로젝트입니다.

MIT License
