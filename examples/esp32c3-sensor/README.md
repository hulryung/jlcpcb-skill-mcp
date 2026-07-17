# ESP32-C3 센서 노드 예제

`analyze_kicad` / `suggest_bom_parts` 도구 시연용 최소 KiCad 8 회로도 예제입니다.
ESP32-C3(QFN-32), AMS1117-3.3 레귤레이터, USB-C 커넥터, 0603 저항/커패시터, LED, 택트 스위치 등 약 15개 부품으로 구성되어 있습니다.
J1(USB-C)에는 `LCSC`, U2(AMS1117-3.3)에는 `LCSC Part #` 필드로 LCSC 부품 번호가 미리 지정되어 있고, R6은 DNP(미실장) 테스트용입니다.
MCP 서버의 `analyze_kicad` 도구에 이 파일 경로를 넘기면 BOM 라인이 추출됩니다.
