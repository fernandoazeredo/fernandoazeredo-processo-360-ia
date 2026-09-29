from pathlib import Path


def patch(path, old, new, count=1):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if text.count(old) < count:
        raise SystemExit(f'{path}: trecho não encontrado: {old[:120]}')
    p.write_text(text.replace(old, new, count), encoding='utf-8')

# 1) Motor B: data correta da inicial e salvaguarda defensiva da Súmula 338
patch('src/pieces.ts',
'''function applyDeterministicPieceFields(sections: PieceSection[], professionalProfile: ProfessionalProfile | undefined, currentDate: string) {
  const profile = professionalProfile || { name: '', oab: '', address: '', email: '' }
  const replacements: Array<[RegExp, string]> = [
    [/\\[(?:NOME DO )?ADVOGADO(?:\\(A\\))?\\]/gi, profile.name],
    [/\\[OAB(?:\\/UF)?\\]/gi, profile.oab],
    [/\\[ENDEREÇO (?:PROFISSIONAL|DO ADVOGADO)\\]/gi, profile.address],
    [/\\[E-?MAIL (?:PROFISSIONAL|DO ADVOGADO)\\]/gi, profile.email],
    [/\\[DATA\\]/gi, currentDate]
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
''',
'''function inferInitialFilingDate(report: AnalysisReport) {
  const filingEvent = report.timeline.find(item => {
    const context = `${item.event || ''} ${item.reference || ''}`
    return /ajuiz|distribu|protocol|propositura/i.test(context) && /^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(String(item.date || '').trim())
  })
  return filingEvent ? String(filingEvent.date).trim() : '[DATA]'
}

function applyDefenseSafeguards(sections: PieceSection[], pieceType: string) {
  if (!/contesta|defesa/i.test(pieceType)) return sections
  return cleanSections(sections.map(section => ({
    ...section,
    content: section.content
      .replace(/(?:a\\s+)?reclamada\\s+reconhece\\s+expressamente\\s+a\\s+incidência\\s+da\\s+Súmula\\s+338(?:,\\s*III)?(?:,?\\s+do\\s+TST)?/gi,
        'a Reclamada sustenta, subsidiariamente, que eventual presunção relacionada à Súmula 338, III, do TST é relativa e deve ser apreciada em conjunto com a prova produzida')
      .replace(/(?:a\\s+)?reclamada\\s+(?:admite|reconhece)\\s+a\\s+incidência\\s+da\\s+Súmula\\s+338(?:,\\s*III)?(?:,?\\s+do\\s+TST)?/gi,
        'a Reclamada sustenta, subsidiariamente, que eventual presunção relacionada à Súmula 338, III, do TST é relativa e pode ser afastada pelo conjunto probatório')
  })))
}

function applyDeterministicPieceFields(sections: PieceSection[], professionalProfile: ProfessionalProfile | undefined, pieceDate: string) {
  const profile = professionalProfile || { name: '', oab: '', address: '', email: '' }
  const replacements: Array<[RegExp, string]> = [
    [/\\[(?:NOME DO )?ADVOGADO(?:\\(A\\))?\\]/gi, profile.name],
    [/\\[OAB(?:\\/UF)?\\]/gi, profile.oab],
    [/\\[ENDEREÇO (?:PROFISSIONAL|DO ADVOGADO)\\]/gi, profile.address],
    [/\\[E-?MAIL (?:PROFISSIONAL|DO ADVOGADO)\\]/gi, profile.email],
    [/\\[DATA\\]/gi, pieceDate]
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
''')

patch('src/pieces.ts',
"  const currentDate = new Intl.DateTimeFormat('pt-BR').format(new Date())\n  const professional = professionalProfile ? JSON.stringify(professionalProfile, null, 2) : 'PROFISSIONAL NÃO CADASTRADO'",
"  const currentDate = new Intl.DateTimeFormat('pt-BR').format(new Date())\n  const isInitialPiece = /petição inicial/i.test(pieceType)\n  const pieceDate = isInitialPiece ? inferInitialFilingDate(report) : currentDate\n  const professional = professionalProfile ? JSON.stringify(professionalProfile, null, 2) : 'PROFISSIONAL NÃO CADASTRADO'")

patch('src/pieces.ts',
"DATA ATUAL DO SISTEMA: ${currentDate}\\n\\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]",
"DATA ATUAL DO SISTEMA: ${currentDate}\\nDATA A UTILIZAR NA PEÇA: ${pieceDate}\\nREGRA DE DATA: em Petição Inicial, use a data de ajuizamento/distribuição expressamente identificada; se ela não estiver identificada, preserve [DATA]. Nunca use a data atual como se fosse a data histórica de ajuizamento.\\n\\n[DADOS_PROFISSIONAIS_DO_ADVOGADO]",
3)

patch('src/pieces.ts',
"Use a DATA ATUAL DO SISTEMA no fecho e os DADOS PROFISSIONAIS no bloco de assinatura; não substitua dados existentes por placeholders.",
"Use a DATA A UTILIZAR NA PEÇA no fecho e os DADOS PROFISSIONAIS no bloco de assinatura; em Petição Inicial nunca substitua a data histórica de ajuizamento pela data atual. Não substitua dados existentes por placeholders.")

patch('src/pieces.ts',
"  const safeSections = applyDeterministicPieceFields(hardenCorrectedSections(reviewed, claims), professionalProfile, currentDate)",
"  const safeSections = applyDeterministicPieceFields(applyDefenseSafeguards(hardenCorrectedSections(reviewed, claims), pieceType), professionalProfile, pieceDate)")

# 2) Prompts Motor B: não admitir incidência como confissão e não usar hoje na inicial
p = Path('src/piecePrompts.ts')
text = p.read_text(encoding='utf-8')
text = text.replace('PROCESSO 360 IA — MOTOR B V4', 'PROCESSO 360 IA — MOTOR B V5')
text = text.replace(
"7. Use integralmente a qualificação das partes existente nos insumos, procurando nome, CPF/CNPJ e endereço em TODAS as seções do relatório antes de usar marcador. Nunca substitua dado disponível por [CNPJ] ou [ENDEREÇO]. Para assinatura e fecho, use DADOS_PROFISSIONAIS_DO_ADVOGADO e DATA ATUAL DO SISTEMA fornecidos pelo aplicativo. Só use marcador curto para dado realmente ausente.",
"7. Use integralmente a qualificação das partes existente nos insumos, procurando nome, CPF/CNPJ e endereço em TODAS as seções do relatório antes de usar marcador. Nunca substitua dado disponível por [CNPJ] ou [ENDEREÇO]. Para assinatura e fecho, use DADOS_PROFISSIONAIS_DO_ADVOGADO e DATA A UTILIZAR NA PEÇA fornecidos pelo aplicativo. Em PETIÇÃO INICIAL, a data atual do sistema NÃO pode substituir a data histórica de ajuizamento/distribuição; se a data histórica não estiver expressamente identificada, mantenha [DATA]. Só use marcador curto para dado realmente ausente."
)
text = text.replace(
"CARTÕES DE PONTO / SÚMULA 338: quando houver horários uniformes ou invariáveis, a CONTESTAÇÃO DEVE CITAR EXPRESSAMENTE 'Súmula 338, III, do TST', explicar a presunção relativa decorrente dos horários uniformes e construir a defesa probatória possível com os demais elementos dos autos. Não omita a Súmula apenas porque ela é desfavorável: enfrente-a e indique como a reclamada pode elidir a presunção com prova em contrário. A mera ausência de assinatura do empregado, isoladamente, não invalida o cartão.",
"CARTÕES DE PONTO / SÚMULA 338: quando houver horários uniformes ou invariáveis, a CONTESTAÇÃO DEVE CITAR EXPRESSAMENTE 'Súmula 338, III, do TST', mas NUNCA escrever que a Reclamada 'reconhece', 'admite', 'confessa' ou 'aceita a incidência' da Súmula ou a invalidade dos controles. Redija defensivamente: registre que a parte autora poderá invocar o item III e sustente, de forma subsidiária, que a presunção é relativa e pode ser afastada por prova em contrário/conjunto probatório. Enfrente o risco sem produzir confissão desnecessária. A mera ausência de assinatura do empregado, isoladamente, não invalida o cartão."
)
text = text.replace(
"VALORES: não usar 'a arbitrar' quando o tipo de pedido exigir indicação de valor e os insumos permitirem apontar a pendência. Se não houver base de cálculo suficiente, use [VALOR] e registre a pendência para o advogado.",
"VALORES: não usar 'a arbitrar' quando o tipo de pedido exigir indicação de valor. Se o PDF trouxer valor literal do pedido, reproduza-o exatamente. Se não houver valor literal/base suficiente, use [VALOR] e registre claramente nos pontos pendentes que o advogado deve preencher o valor antes do protocolo; não invente nem calcule o montante."
)
text = text.replace(
"FASE PROCESSUAL: jamais inserir número de processo ou Vara numa inicial por inferência.",
"DATA DA INICIAL: use a data histórica de ajuizamento/distribuição quando expressamente identificada nos dados consolidados. Se não estiver identificada, mantenha [DATA]. É proibido usar a data atual do sistema como se fosse a data histórica de ajuizamento.\\n\\nFASE PROCESSUAL: jamais inserir número de processo ou Vara numa inicial por inferência."
)
p.write_text(text, encoding='utf-8')

# 3) Motor A: proibir cálculo derivado de honorários e explicitar prescrição por competência também para o reclamante
for path in ['functions/prompts/01_Trabalhista_Favor_Reclamada.txt', 'functions/prompts/02_Trabalhista_Favor_Reclamante.txt']:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    text = text.replace('PROCESSO 360 IA — MOTOR A V3', 'PROCESSO 360 IA — MOTOR A V4')
    marker = 'TRCT E VALORES RESCISÓRIOS:'
    rule = "VALORES DERIVADOS / HONORÁRIOS: não calcular, projetar ou exibir valor em reais que não esteja literalmente escrito nos documentos/lotes. Se houver apenas percentual de honorários (ex.: 15%), preserve somente o percentual e a base jurídica/documental disponível; NÃO transforme o percentual em R$ por multiplicação do valor da causa, condenação ou qualquer outra base. Todo valor em R$ do relatório deve corresponder a valor literal extraído do processo.\\n"
    if rule not in text:
        text = text.replace(marker, rule + marker)
    p.write_text(text, encoding='utf-8')

p = Path('functions/prompts/02_Trabalhista_Favor_Reclamante.txt')
text = p.read_text(encoding='utf-8')
text = text.replace(
'PRESCRIÇÃO: verificar bienal e quinquenal quando houver datas suficientes; individualizar competências atingidas.',
'PRESCRIÇÃO: verificar bienal e quinquenal quando houver datas suficientes; individualizar competências atingidas MESMO NA PERSPECTIVA DO RECLAMANTE, porque a prescrição é fragilidade relevante que não pode ser ocultada. Calcule a data de corte a partir da data de ajuizamento expressamente identificada e classifique cada competência periódica em prescrita/não prescrita. Se janeiro e fevereiro estiverem antes do corte e março depois, registre expressamente essa diferença, sem agregar os três meses.'
)
p.write_text(text, encoding='utf-8')

# 4) Consolidação Motor A: qualquer R$ precisa ser literal; sem cálculo de honorários
patch('src/gemini.ts',
"- VALORES DO TRCT: trate o valor impresso no documento como transcrição documental, não como resultado de cálculo. Se lotes trouxerem valores conflitantes para o mesmo campo, exponha a divergência e não invente um terceiro valor nem uma diferença.",
"- VALORES DO TRCT: trate o valor impresso no documento como transcrição documental, não como resultado de cálculo. Se lotes trouxerem valores conflitantes para o mesmo campo, exponha a divergência e não invente um terceiro valor nem uma diferença.\\n- VALORES DERIVADOS: é proibido criar qualquer novo valor em R$ por cálculo, percentual, soma, subtração, projeção ou estimativa. Em especial, se os lotes trouxerem apenas percentual de honorários, preserve o percentual sem convertê-lo em R$. Todo valor monetário em R$ exibido no relatório final deve estar literalmente presente nos lotes extraídos."
)
patch('src/gemini.ts', "const ARCHITECTURE_VERSION = 'blaze-browser-lots-v5-factual-identity-money'", "const ARCHITECTURE_VERSION = 'blaze-browser-lots-v6-legal-finish'")

# 5) Tela: remover ID/Build do relatório e os três selos inferiores
patch('src/App.tsx', '      <span><b>ID:</b> {report.analysisId}</span>\n      <span><b>Build:</b> {APP_BUILD.slice(0,12)}</span>\n', '')
patch('src/App.tsx', '''        <section className="trust-row">
          <span><ShieldCheck/> Rastreabilidade documental</span>
          <span><LockKeyhole/> Prompts protegidos</span>
          <span><BrainCircuit/> Diagnóstico somente após leitura integral</span>
        </section>
''', '')

# Mantém APP_BUILD internamente para controle de versão/exportação, apenas não o mostra na tela.

# Forçar publicação de novos prompts trabalhistas
p = Path('functions/scripts/publish-reclamada-v2.mjs')
text = p.read_text(encoding='utf-8')
text = text.replace('2026-09-29-trabalhista-reclamada-v5', '2026-09-29-trabalhista-reclamada-v6')
text = text.replace('2026-09-29-trabalhista-reclamante-v5', '2026-09-29-trabalhista-reclamante-v6')
text = text.replace('Análise jurídica global v5', 'Análise jurídica global v6')
p.write_text(text, encoding='utf-8')

# Remove temporários do commit final
Path('scripts/apply_regressao_v6.py').unlink(missing_ok=True)
Path('.github/workflows/apply-regressao-v6.yml').unlink(missing_ok=True)
