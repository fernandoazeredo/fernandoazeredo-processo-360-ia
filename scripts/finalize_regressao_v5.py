from pathlib import Path

def replace(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'{path}: trecho não encontrado: {old[:80]}')
    p.write_text(text.replace(old, new), encoding='utf-8')

replace('src/gemini.ts', "const CONSOLIDATION_MODELS = [\n  CONSOLIDATION_MODEL,\n  'gemini-3.5-flash',\n  EXTRACTION_MODEL\n] as const", "const CONSOLIDATION_MODELS = [\n  CONSOLIDATION_MODEL,\n  'gemini-3.5-flash',\n  'gemini-3.5-flash-lite'\n] as const")
replace('src/pieces.ts', '// V3 local é o piso de qualidade. Prompt publicado só substitui quando for v3 ou superior.', '// V4 local é o piso de qualidade. Prompt publicado só substitui quando for v4 ou superior.')
replace('src/pieces.ts', "'PROCESSO 360 IA — MOTOR B V3.'", "'PROCESSO 360 IA — MOTOR B V4.'")
replace('src/pieces.ts', '`motor-b-v3:base-${basePromptDoc.source}-v${basePromptDoc.version}`', '`motor-b-v4:base-${basePromptDoc.source}-v${basePromptDoc.version}`')
replace('src/piecePrompts.ts', '6. Antes de redigir, identifique a FASE PROCESSUAL. Se o processo já estiver ajuizado, não trate manifestação posterior do reclamante como nova petição inicial. Se o tipo solicitado for incompatível com a fase, sinalize [TIPO DE PEÇA A CONFIRMAR] e não invente número de vara/processo para uma inicial pré-processual.', '6. Antes de redigir, identifique a FASE PROCESSUAL. Para manifestações posteriores, respeite os atos já praticados. EXCEÇÃO CONTROLADA: se o usuário selecionar expressamente PETIÇÃO INICIAL, gere uma minuta inicial completa/autônoma a partir dos fatos e pedidos disponíveis, sem convertê-la em aditamento e sem inventar Vara ou número de processo.')
Path('.github/workflows/finalize-regressao-v5.yml').unlink(missing_ok=True)
Path('scripts/finalize_regressao_v5.py').unlink(missing_ok=True)
