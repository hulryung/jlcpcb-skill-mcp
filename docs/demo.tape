# VHS tape — renders docs/demo.gif and docs/demo.mp4
# Re-render with: vhs docs/demo.tape   (run from repo root)
Output docs/demo.gif
Output docs/demo.mp4

Set Shell bash
Set FontSize 13
Set Width 1300
Set Height 1000
Set Padding 16
Set TypingSpeed 35ms

Type "# jlcpcb-skill-mcp — KiCad BOM -> JLCPCB parts, with assembly cost in mind"
Enter
Sleep 1.5s

Type "npm run demo -- examples/esp32c3-sensor/esp32c3-sensor.kicad_sch --qty 20"
Enter
Sleep 14s

Type "# passives land on basic-tier parts (no loading fee); uncertain matches are flagged needs_review"
Enter
Sleep 5s
