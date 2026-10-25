# Issue #165 – gemeinsamer `dependsOn`-Reader

## Ziel

- `metadata.dependsOn` wird durch genau einen DOM-freien Reader ausgewertet.
- Core und relationale Plugins nutzen denselben über den Plugin-Contract exportierten Reader.
- Das bestehende asymmetrische Trim-Verhalten und der gebaute Relation-Graph bleiben unverändert.

## Offene Punkte

- [x] `src/dependsOn.ts` und fokussierte Tests für Listen-, String-, fehlende und ungültige Werte anlegen.
- [x] `dependsOnOf` über `src/pluginHost/api.ts` exportieren.
- [x] `src/buildItems.ts` auf `dependsOnOf(raw)` umstellen und `extractDependsOn` löschen.
- [x] Construction-Kopie und zugehörige Konventionshinweise entfernen.
- [x] Sprints-Inline-Reader und zugehörige Konventionshinweise entfernen.
- [x] Gezielte und vollständige Tests, Typecheck sowie verfügbare statische Checks ausführen.
- [x] Plugin-Isolation und Server-Bundle prüfen.
- [x] Diff auf unveränderte Dependency-Map-Semantik und restlos entfernte Copy-Kommentare prüfen.
- [x] Änderungen mit Conventional Commit committen.
