# dsh-auto-compact

**대화의 컨텍스트가 지정한 수준에 도달하면 자동으로 컴팩트해 주는** DeepSeek Harness 플러그인으로,
`/auto-compact` 명령을 추가합니다.

기본 `/compact`는 요청할 때 한 번 압축합니다. `/auto-compact`는 임계값을 유지하면서 턴이 끝난 뒤
스스로 압축하므로, 긴 세션을 수동 작업 없이 관리할 수 있습니다.

기본값 **500,000** 토큰 · 허용 범위 **100,000 – 1,000,000**.

[English document](README.md)

## 설치

이 저장소는 DSH 번들입니다(`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`).
GitHub에서 바로 설치합니다:

```
plugin_manager install_bundle target=github:Kachchi3739/dsh-auto-compact#main
```

릴리스 버전으로 고정하려면:

```
plugin_manager install_bundle target=github:Kachchi3739/dsh-auto-compact#v1.0.0
```

로컬 개발용으로는 체크아웃 디렉터리에서 설치합니다:

```
plugin_manager install_bundle target=<이 디렉터리의 절대 경로>
```

번들은 호스트 플레인 행 `auto-compact`(패키지 `@local/auto-compact`)를 등록합니다.
명령은 살아 있는 에이전트에 붙기 때문에 기존 세션에서도 새 세션에서도 동작합니다.

## 사용법

| 입력 | 결과 |
|---|---|
| `/auto-compact` | 현재 상태, 임계값, 측정된 컨텍스트 표시 |
| `/auto-compact 500k` | 임계값을 500,000 토큰으로 설정하고 자동 컴팩트 켜기 |
| `/auto-compact on` / `off` | 임계값은 그대로 두고 자동 컴팩트만 켜기/끄기 |
| `/auto-compact reset` | 기본값(500,000)으로 복원하고 자동 컴팩트 켜기 |
| `/auto-compact status` | 인자 없는 형태와 동일 |

임계값은 일반 숫자(`500000`) 또는 `k`/`m` 접미사(`500k`, `0.5m`, `1M`)로 지정하며, 쉼표·밑줄·공백
구분자를 허용합니다. **100,000 – 1,000,000** 범위를 벗어나면 가까운 한계로 클램프하고 그 사실을
알려 줍니다.

## 동작 방식

- **트리거.** 턴이 끝나 에이전트가 `idle`이 되면, 해당 세션의 요청+서피스 컨텍스트를
  `ctx.tokenMeter.measure()`로 측정해 임계값 이상이면 압축합니다. idle 전환마다 한 번만 시도하며
  같은 유휴 구간에서 반복하지 않습니다.
- **엔진.** `/compact`가 쓰는 것과 동일한 수동 컴팩트 경로인
  `compaction.compactNow(agent, signal)`를 호출합니다. 따라서 체크포인트와 대체된 히스토리
  레코드가 수동 압축과 같고, 어떤 컴팩션 백엔드와도 동작합니다.
- **사용자를 지연시키지 않음.** 다음 메시지가 먼저 턴을 시작하면 이번 체크를 건너뛰고, 다음 idle
  전환에서 다시 시도합니다.
- **실패는 로그로.** 자동 압축 오류는 UI 오류가 아니라 호스트 로그 진단(`auto-compact: …`)으로
  남습니다. 세션 로그에는 실패한 컴팩션 시도가 이미 기록됩니다.
- **모델에 노출되지 않음.** 모델 히스토리에 들어가는 것은 없습니다. 압축이 성공하면 백엔드의 요약
  체크포인트로 이전 히스토리가 대체됩니다.

## 배치

**호스트 플레인** 플러그인입니다. Web 표면은 호스트 플레인의 `compaction-basic`과
`command-compact` 행을 비활성화하고 각 에이전트 프리셋의 격리된 `cordis:group` 안에 마운트하므로,
호스트 행은 `compaction` 서비스를 `inject`할 수 없습니다. 그래서 이 플러그인은

- 각 에이전트의 컨텍스트(`agent.ctx.commands.register`)를 통해 **에이전트 스코프**의
  `/auto-compact` 명령을 등록합니다. 명령은 정확히 그 에이전트에 속합니다.
- 프리셋 격리 영역 안의 서비스에 접근하는 공식 통로인
  `ctx.agentPresets.serviceFor(agent, 'compaction')`으로 엔진을 찾고, 프리셋이 없는 구성(CLI/TUI)
  에서는 호스트 플레인의 `compaction` 서비스로 폴백합니다.
- 스코프가 없는 호스트 플레인에서 `agent/created`, `agent/status`, `agent/disposed`를 관찰하므로
  프리셋과 무관하게 모든 에이전트를 대상으로 동작합니다.

필요 서비스: `agents`, `commands`, `tokenMeter`.

## 저장

선택한 임계값은 활성 프로필 아래 플러그인 전용 파일에 저장됩니다:

```text
<profile>/.auto-compact/state.json
```

```json
{ "version": 1, "enabled": true, "thresholdTokens": 500000 }
```

쓰기는 원자적(임시 파일 + rename)이며 직렬화됩니다. 파일이 없으면 행 config 기본값을 쓰고,
읽을 수 없거나 잘못된 파일은 활성화를 실패시키지 않고 로그만 남기고 무시합니다. 프로필 컨텍스트가
없으면 `$DSH_HOME/auto-compact/state.json`으로 폴백합니다. 행 config(`enabled`,
`thresholdTokens`)는 폴백 기본값일 뿐이며 활성화 시 엄격하게 검증합니다.

## 참고

- 임계값은 세션별이 아니라 **프로필 단위**입니다. 이 플러그인이 서비스하는 모든 에이전트가 하나의
  임계값을 공유합니다.
- 서브에이전트와 팀원 에이전트도 살아 있는 에이전트이므로 같은 방식으로 측정됩니다.
- 임계값은 절대 토큰 수입니다. 모델의 컨텍스트 윈도가 임계값보다 작으면 기본 제공되는 윈도 80%
  압력 컴팩션이 먼저 요청을 보호하며, 이 순서에 해당하면 상태 출력이 경고합니다.
- 측정은 리플레이 기반이며 프로바이더가 과금하지 않은 텍스트에는 휴리스틱이므로, 트리거 지점은
  정확한 과금 수치가 아니라 대략 그 수준입니다.

## 개발

```sh
npm test          # node --test --test-isolation=none "test/**/*.test.mjs"
```

`policy.js`는 import가 없는 순수 계층(파싱, 범위, 검증, 포매팅, 상태 문서)입니다. `index.js`는
이를 에이전트 레지스트리, 에이전트별 명령 레지스트리, 프리셋 스코프 컴팩션 연결부, 프로필 상태
파일에 연결합니다.

## 라이선스

MIT
