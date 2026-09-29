from pathlib import Path


def patch(path, old, new, count=1):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    found = text.count(old)
    if found < count:
        raise SystemExit(f'{path}: trecho não encontrado ({found} < {count})')
    p.write_text(text.replace(old, new, count), encoding='utf-8')


# MOTOR A: modelo de extração de maior qualidade e cache v5
patch('src/gemini.ts', "export const EXTRACTION_MODEL = 'gemini-3.5-flash-lite'", "export const EXTRACTION_MODEL = 'gemini-3.8-flash'")
patch('src/gemini.ts', "const EXTRACTION_MODELS = [\n  EXTRACTION_MODEL,\n  CONSOLIDATION_MODEL,\n  'gemini-3.5-flash'\n] as const", "const EXTRACTION_MODELS = [\n  EXTRACTION_MODEL,\n  'gemini-3.5-flash',\n  'gemini-3.5-flash-lite'\n] as const")
patch('src/gemini.ts', "const ARCHITECTURE_VERSION = 'blaze-browser-lots-v4-quality-prompts'", "const ARCHITECTURE_VERSION = 'blaze-browser-lots-v5-factual-identity-money'")

# Qualificação estruturada no Motor A
patch('src/gemini.ts', "export type GeminiAnalysisReport = {\n  processNumber: string\n  processNumberWarning?: string\n  executiveSummary: string", "export type GeminiAnalysisReport = {\n  processNumber: string\n  processNumberWarning?: string\n  parties: Array<{ role: string; name: string; cpfCnpj: string; address: string; lawyerName: string; lawyerOab: string }>\n  executiveSummary: string")
patch('src/gemini.ts', "  monetaryValues: string[]\n  proceduralIssues: string[]", "  monetaryValues: string[]\n  qualifications: Array<{ role: string; name: string; cpfCnpj: string; address: string; lawyerName: string; lawyerOab: string }>\n  proceduralIssues: string[]")
patch('src/gemini.ts', "    monetaryValues: Schema.array({ items: Schema.string() }),\n    proceduralIssues: Schema.array({ items: Schema.string() }),", "    monetaryValues: Schema.array({ items: Schema.string() }),\n    qualifications: Schema.array({ items: Schema.object({ properties: {\n      role: Schema.string(), name: Schema.string(), cpfCnpj: Schema.string(), address: Schema.string(), lawyerName: Schema.string(), lawyerOab: Schema.string()\n    } }) }),\n    proceduralIssues: Schema.array({ items: Schema.string() }),")
patch('src/gemini.ts', "    processNumber: Schema.string(),\n    executiveSummary: Schema.string(),", "    processNumber: Schema.string(),\n    parties: Schema.array({ items: Schema.object({ properties: {\n      role: Schema.string(), name: Schema.string(), cpfCnpj: Schema.string(), address: Schema.string(), lawyerName: Schema.string(), lawyerOab: Schema.string()\n    } }) }),\n    executiveSummary: Schema.string(),")
patch('src/gemini.ts', "    Array.isArray(value.monetaryValues) &&\n    Array.isArray(value.proceduralIssues) &&", "    Array.isArray(value.monetaryValues) &&\n    Array.isArray(value.qualifications) &&\n    Array.isArray(value.proceduralIssues) &&")
patch('src/gemini.ts', "    typeof value.processNumber === 'string' &&\n    typeof value.executiveSummary === 'string' &&", "    typeof value.processNumber === 'string' &&\n    Array.isArray(value.parties) &&\n    typeof value.executiveSummary === 'string' &&")

patch('src/gemini.ts', "- Em monetaryValues, capture de forma individualizada todos os valores expressamente identificados, especialmente valor da causa, valor de cada pedido, condenação, acordo, depósito, custas, honorários e demais quantias relevantes. Para cada valor, informe sua natureza, a parte ou pedido relacionado e a referência de página/peça quando identificável. Não some, estime ou complete valores que não estejam expressos.", "- Em monetaryValues, TRANSCREVA literalmente todos os valores expressamente identificados, especialmente TRCT/verbas rescisórias, valor da causa e valor de cada pedido. Confira dígito por dígito antes de responder. Para cada valor, informe natureza e referência. NÃO some, subtraia, estime, arredonde, complete nem crie 'diferença' entre dois valores. Uma diferença monetária só pode entrar em claims se estiver expressamente formulada como pedido/alegação no documento. Se a leitura de um algarismo estiver duvidosa, registre a dúvida em unresolvedQuestions em vez de escolher um valor.\n- Em qualifications, extraia e preserve separadamente a qualificação encontrada de cada parte e advogado: papel processual, nome, CPF/CNPJ, endereço, nome do advogado e OAB. Não descarte esses dados por não serem necessários ao resumo do lote.")
patch('src/gemini.ts', "- Em claimsEvidenceDecisions, consolide separadamente o valor da causa e o valor de cada pedido quando constarem dos lotes, eliminando duplicidades e preservando a referência documental. Não estime quantias ausentes.", "- Em claimsEvidenceDecisions, consolide separadamente o valor da causa e o valor de cada pedido quando constarem dos lotes, eliminando duplicidades e preservando a referência documental. Não estime quantias ausentes. NUNCA crie pedido de diferença monetária por comparação aritmética entre TRCT, inicial ou outro documento: o pedido deve existir expressamente em claims.\n- Em parties, consolide TODAS as qualifications extraídas dos lotes, preservando nome, CPF/CNPJ, endereço e advogado/OAB. Não troque dado encontrado por 'Informação não constante'.\n- VALORES DO TRCT: trate o valor impresso no documento como transcrição documental, não como resultado de cálculo. Se lotes trouxerem valores conflitantes para o mesmo campo, exponha a divergência e não invente um terceiro valor nem uma diferença.")

# Tipo do relatório compartilhado
patch('src/ai.ts', "  processNumberWarning?: string\n  executiveSummary: string", "  processNumberWarning?: string\n  parties: Array<{ role: string; name: string; cpfCnpj: string; address: string; lawyerName: string; lawyerOab: string }>\n  executiveSummary: string")

# Motor B local v4 passa a prevalecer sobre prompts Firestore v3 antigos
patch('src/pieces.ts', 'const MOTOR_B_LOCAL_VERSION = 3', 'const MOTOR_B_LOCAL_VERSION = 4')
patch('src/pieces.ts', "type LoadedPrompt = { content: string; version: number; source: 'firestore' | 'local-v3' }", "type LoadedPrompt = { content: string; version: number; source: 'firestore' | 'local-v4' }")
patch('src/pieces.ts', "return { content: localPrompt, version: MOTOR_B_LOCAL_VERSION, source: 'local-v3' }", "return { content: localPrompt, version: MOTOR_B_LOCAL_VERSION, source: 'local-v4' }", 3)
patch('src/pieces.ts', 'Prompt publicado indisponível; usando Motor B local v3.', 'Prompt publicado indisponível; usando Motor B local v4.')
patch('src/pieces.ts', "    processNumberWarning: report.processNumberWarning,\n    executiveSummary: report.executiveSummary,", "    processNumberWarning: report.processNumberWarning,\n    parties: report.parties,\n    executiveSummary: report.executiveSummary,")

# Preenchimento determinístico do cadastro profissional e data depois do revisor
insertion = r'''
function applyDeterministicPieceFields(sections: PieceSection[], professionalProfile: ProfessionalProfile | undefined, currentDate: string) {
  const profile = professionalProfile || { name: '', oab: '', address: '', email: '' }
  const replacements: Array<[RegExp, string]> = [
    [/\[(?:NOME DO )?ADVOGADO(?:\(A\))?\]/gi, profile.name],
    [/\[OAB(?:\/UF)?\]/gi, profile.oab],
    [/\[ENDEREÇO (?:PROFISSIONAL|DO ADVOGADO)\]/gi, profile.address],
    [/\[E-?MAIL (?:PROFISSIONAL|DO ADVOGADO)\]/gi, profile.email],
    [/\[DATA\]/gi, currentDate]
  ]
  return cleanSections(sections.map(section => {
    let title = section.title
    let content = section.content
    for (const [pattern, value] of replacements) {
      if (!value) continue
      title = title.replace(pattern, value)
      content = content.replace(pattern, value)
    }
    return { title, content }
  }))
}

'''
patch('src/pieces.ts', 'export async function generateLegalPiece(report: AnalysisReport, pieceType: string, professionalProfile?: ProfessionalProfile): Promise<LegalPieceDraft> {', insertion + 'export async function generateLegalPiece(report: AnalysisReport, pieceType: string, professionalProfile?: ProfessionalProfile): Promise<LegalPieceDraft> {')
patch('src/pieces.ts', "  const validationPrompt = `${validatorPromptDoc.content}\\n\\nFASE PROCESSUAL INFERIDA: ${phase}\\n\\n[DADOS_CONSOLIDADOS_DO_PROCESSO]", "  const validationPrompt = `${validatorPromptDoc.content}\\n\\nFASE PROCESSUAL INFERIDA: ${phase}\\nDATA ATUAL DO SISTEMA: ${currentDate}\\n\\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]\\n${professional}\\n\\n[DADOS_CONSOLIDADOS_DO_PROCESSO]")
patch('src/pieces.ts', "  const reviewPrompt = `${reviewerPromptDoc.content}\\n\\nÁREA: ${report.area}\\nPERSPECTIVA: ${report.perspective}\\nTIPO: ${pieceType}\\nFASE: ${phase}\\n\\n[DADOS_CONSOLIDADOS_DO_PROCESSO]", "  const reviewPrompt = `${reviewerPromptDoc.content}\\n\\nÁREA: ${report.area}\\nPERSPECTIVA: ${report.perspective}\\nTIPO: ${pieceType}\\nFASE: ${phase}\\nDATA ATUAL DO SISTEMA: ${currentDate}\\n\\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]\\n${professional}\\n\\n[DADOS_CONSOLIDADOS_DO_PROCESSO]")
patch('src/pieces.ts', '  const safeSections = hardenCorrectedSections(reviewed, claims)', '  const safeSections = applyDeterministicPieceFields(hardenCorrectedSections(reviewed, claims), professionalProfile, currentDate)')

# Prompts Motor B v4
p = Path('src/piecePrompts.ts')
text = p.read_text(encoding='utf-8').replace('MOTOR B V3', 'MOTOR B V4')
text = text.replace("CARTÕES DE PONTO / SÚMULA 338: quando houver horários uniformes ou invariáveis, enfrente expressamente a Súmula 338, III, do TST e o efeito probatório pertinente. A mera ausência de assinatura do empregado, isoladamente, não deve ser tratada como causa automática de invalidade do cartão.", "CARTÕES DE PONTO / SÚMULA 338: quando houver horários uniformes ou invariáveis, a CONTESTAÇÃO DEVE CITAR EXPRESSAMENTE 'Súmula 338, III, do TST', explicar a presunção relativa decorrente dos horários uniformes e construir a defesa probatória possível com os demais elementos dos autos. Não omita a Súmula apenas porque ela é desfavorável: enfrente-a e indique como a reclamada pode elidir a presunção com prova em contrário. A mera ausência de assinatura do empregado, isoladamente, não invalida o cartão.")
text = text.replace("Primeiro determine a fase processual. Se ainda não houver ação ajuizada e os dados permitirem, produza PETIÇÃO INICIAL. Se já houver processo e a atuação solicitada for posterior à defesa, não crie nova inicial: sinalize [TIPO DE PEÇA A CONFIRMAR] e indique no conteúdo que a peça compatível pode ser réplica/manifestação, conforme os atos existentes.", "Primeiro determine a fase processual. Se o TIPO SOLICITADO for PETIÇÃO INICIAL, produza uma PETIÇÃO INICIAL COMPLETA com fatos, fundamentos, pedidos individualizados, provas e requerimentos a partir dos dados fornecidos. Mesmo que o PDF seja de processo já ajuizado, não converta a petição inicial solicitada em aditamento: trate-a como minuta autônoma/reconstruída para edição, sem inventar número de processo ou Vara. Se o tipo solicitado for manifestação posterior, respeite a fase e os atos existentes.")
text = text.replace("FASE PROCESSUAL: jamais inserir número de processo ou Vara numa inicial pré-processual por inferência. Em processo já existente, não gerar nova inicial como se o ajuizamento ainda fosse ocorrer.", "FASE PROCESSUAL: jamais inserir número de processo ou Vara numa inicial por inferência. Quando PETIÇÃO INICIAL for expressamente solicitada, gere a inicial completa como minuta autônoma/reconstruída e NÃO a transforme em aditamento, ainda que o material de origem venha de processo já ajuizado. Para manifestações posteriores, respeite a fase existente.")
text = text.replace('- cartões de ponto uniformes/invariáveis foram confrontados com a Súmula 338, III, do TST quando pertinente;', '- em contestação trabalhista com cartões uniformes/invariáveis, o TEXTO DA PEÇA cita expressamente a Súmula 338, III, do TST e apresenta a defesa probatória possível;')
text = text.replace('- linguagem é profissional, concisa e sem aparência de texto de IA.', '- linguagem é profissional, concisa e sem aparência de texto de IA;\n- se o tipo solicitado for Petição Inicial, a peça é completa (fatos, fundamentos, pedidos, provas e requerimentos) e não foi convertida em aditamento;\n- DADOS_PROFISSIONAIS_DO_ADVOGADO e DATA ATUAL DO SISTEMA foram preservados no texto final, sem [ADVOGADO], [OAB/UF] ou [DATA] quando esses dados foram fornecidos.')
p.write_text(text, encoding='utf-8')

# Motor A: TRCT não pode gerar diferença aritmética inventada
for path in ['functions/prompts/01_Trabalhista_Favor_Reclamada.txt', 'functions/prompts/02_Trabalhista_Favor_Reclamante.txt']:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    anchor = 'TESTES JURÍDICO-FACTUAIS OBRIGATÓRIOS' if '01_' in path else 'TESTES OBRIGATÓRIOS'
    pos = text.find(anchor)
    if pos < 0:
        raise SystemExit(f'{path}: âncora TRCT não encontrada')
    line_end = text.find('\n', pos)
    rule = "\nTRCT E VALORES RESCISÓRIOS: transcrever o valor impresso exatamente, dígito por dígito. Não calcular nem criar diferença entre TRCT e outro valor. Só existe pedido de diferença rescisória se ele estiver expressamente formulado na petição/alegação; uma diferença aritmética inferida pelo modelo NÃO é pedido. Em dúvida de leitura, registrar a divergência e não escolher valor por cálculo.\n"
    text = text[:line_end+1] + rule + text[line_end+1:]
    p.write_text(text, encoding='utf-8')

# Republicar Motor A v5
p = Path('functions/scripts/publish-reclamada-v2.mjs')
text = p.read_text(encoding='utf-8')
text = text.replace('2026-09-29-trabalhista-reclamada-v4', '2026-09-29-trabalhista-reclamada-v5')
text = text.replace('2026-09-29-trabalhista-reclamante-v4', '2026-09-29-trabalhista-reclamante-v5')
text = text.replace('Análise jurídica global v4', 'Análise jurídica global v5')
p.write_text(text, encoding='utf-8')

# Interface: retirar cinco rótulos/textos técnicos sem remover funções nem o aviso único de revisão
patch('src/App.tsx', '          <span className="eyebrow"><FilePenLine size={16}/> Módulo opcional</span>\n', '')
patch('src/App.tsx', '          <p>O Motor B usa somente o relatório consolidado. O PDF original não será reprocessado.</p>\n', '')
patch('src/App.tsx', '            <span className="eyebrow">Minuta validada</span>\n', '')
patch('src/App.tsx', '            <small>Tipo: {piece.pieceType} · Prompt: {piece.promptVersion} · Modelo: {piece.model}</small>\n', '')
patch('src/App.tsx', '          <h3>Validação factual automática</h3>\n', '')

# Remove arquivos temporários do commit final
Path('.github/workflows/apply-regressao-v5.yml').unlink(missing_ok=True)
Path('scripts/apply_regressao_v5.py').unlink(missing_ok=True)
