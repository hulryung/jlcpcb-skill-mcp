# VHS tape — records a REAL Claude Code session using the jlcpcb-parts plugin
# Re-record with: vhs docs/demo-claude.tape   (run from repo root; needs
# ~/dev/esp32c3-demo prepared with the example schematic + trusted workspace)
Output docs/demo-claude.mp4

Set Shell bash
Set FontSize 14
Set Width 1400
Set Height 920
Set Padding 14
Set TypingSpeed 45ms
Set Framerate 12

Type "cd ~/dev/esp32c3-demo && claude"
Enter
Wait+Screen@90s /Fable/
Sleep 3s

Type "부품을 검색해보고, 적절한 부품을 지정해줘. 20장 생산 기준으로."
Sleep 1.5s
Enter

Wait+Screen@20m /DONE-MAPPED/
Sleep 10s

Type "/exit"
Sleep 1s
Enter
Sleep 2s
