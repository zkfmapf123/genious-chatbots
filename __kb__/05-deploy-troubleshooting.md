# 배포 문제 해결

> 샘플 문서: 챗봇 RAG 테스트용으로 만든 가상의 사내 문서다. 일반적인 쿠버네티스 증상을 정리했다.

## 새 파드가 계속 Pending이다

`kubectl describe pod <이름>`의 Events를 본다.

- `Insufficient cpu/memory`: 노드 자원이 부족하다. requests를 줄이거나 노드를 늘린다.
- `no nodes available to schedule`: nodeSelector, taint/toleration이 맞지 않는다.

## ImagePullBackOff

- 이미지 태그 오타 또는 CI가 푸시를 끝내기 전에 배포한 경우가 많다. 레지스트리에 태그가 있는지 먼저 본다.
- 프라이빗 레지스트리면 `imagePullSecrets` 설정과 자격증명 만료를 확인한다.

## CrashLoopBackOff

1. `kubectl logs <파드> --previous`로 직전 컨테이너가 죽을 때의 로그를 본다.
2. 환경변수나 시크릿이 빠진 경우가 가장 흔하다. 새 버전이 새 환경변수를 요구하는지 확인한다.
3. liveness probe가 너무 빡빡해서 시작 중에 죽이는 경우도 있다. `initialDelaySeconds`를 늘려 본다.
4. 메모리 한도 초과(`OOMKilled`)면 `kubectl describe pod`의 Last State에 나온다.

## 배포는 성공했는데 502/503이 난다

- readiness probe 경로가 실제 앱의 헬스 엔드포인트와 맞는지 확인한다.
- 롤링 중에 종료되는 파드로 요청이 가는 경우: `preStop` 훅으로 몇 초 대기하고 `terminationGracePeriodSeconds`를 충분히 둔다.
- 로드밸런서의 idle timeout보다 앱의 keep-alive 시간이 짧으면 연결이 끊긴다.

## 롤아웃이 멈춰 있다

`kubectl rollout status`가 끝나지 않으면 새 파드가 Ready가 안 되는 것이다. `progressDeadlineSeconds`가 지나면 실패로 표시된다. 위 증상 중 하나를 확인하고, 급하면 `kubectl rollout undo`로 되돌린다.
