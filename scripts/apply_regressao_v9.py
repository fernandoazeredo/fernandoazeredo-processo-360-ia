from pathlib import Path


def patch(path, old, new, count=1):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if text.count(old) < count:
        raise SystemExit(f'{path}: trecho não encontrado: {old[:140]}')
    p.write_text(text.replace(old, new, count), encoding='utf-8')

# 1) Cadastro profissional: e-mail não pode herdar o login automaticamente.
patch('src/App.tsx',
"const [professionalProfile, setProfessionalProfile] = useState<ProfessionalProfile>({ name: '', oab: '', address: '', email: user.email || '' })",
"const [professionalProfile, setProfessionalProfile] = useState<ProfessionalProfile>({ name: '', oab: '', address: '', email: '' })")
patch('src/App.tsx',
"email: String(data.email || user.email || '')",
"email: String(data.email || '')")

# 2) Motor B local v5 deve prevalecer sobre versões antigas publicadas.
p = Path('src/pieces.ts')
text = p.read_text(encoding='utf-8')
text = text.replace('const MOTOR_B_LOCAL_VERSION = 4', 'const MOTOR_B_LOCAL_VERSION = 5')
text = text.replace("source: 'firestore' | 'local-v4'", "source: 'firestore' | 'local-v5'")
text = text.replace("source: 'local-v4'", "source: 'local-v5'")
text = text.replace('Motor B local v4', 'Motor B local v5')
text = text.replace('MOTOR B V4.', 'MOTOR B V5.')
text = text.replace('motor-b-v4:', 'motor-b-v5:')
p.write_text(text, encoding='utf-8')

# 3) Contestação: aproveitar teses defensivas reais e fechar hipersuficiência, dano moral e sobreaviso.
p = Path('src/piecePrompts.ts')
text = p.read_text(encoding='utf-8')
anchor = "PROVAS: use todas as provas relevantes já identificadas no processo, inclusive as desfavoráveis. Não escreva que a empresa está 'levantando', 'providenciando' ou 'juntará' documento que já consta dos insumos."
addition = """PROVAS: use todas as provas relevantes já identificadas no processo, inclusive as desfavoráveis. Não escreva que a empresa está 'levantando', 'providenciando' ou 'juntará' documento que já consta dos insumos.

TESES DEFENSIVAS JÁ DOCUMENTADAS: antes de concluir a contestação, procure nos dados consolidados argumentos, aditivos, cláusulas, percentuais e pedidos subsidiários que já tenham sido formulados pela defesa real ou estejam documentalmente sustentados. Não omita uma tese defensiva material apenas por já existir uma tese genérica sobre o mesmo pedido. Preserve valores e percentuais literais, sem criar cálculo novo.

HIPERSUFICIÊNCIA / ART. 444, PARÁGRAFO ÚNICO, DA CLT: se os dados demonstrarem os requisitos fáticos pertinentes e houver aditivo/negociação individual relevante, enfrente expressamente a validade e o alcance da negociação individual à luz do art. 444, parágrafo único, da CLT. Se o processo trouxer literalmente aumento remuneratório ligado ao aditivo — por exemplo, percentual de 42,9% — use esse dado como elemento defensivo, sem recalculá-lo nem presumir requisito não comprovado. Se os requisitos legais não estiverem demonstrados, trate a tese como dependente de prova e não afirme hipersuficiência como fato.

DANO MORAL — TESE SUBSIDIÁRIA DE QUANTUM: além da improcedência, verifique se a defesa ou os documentos fornecem pedido subsidiário expresso de limitação/redução do valor. Quando houver limite literal — inclusive R$ 5.000,00 no caso concreto, se esse valor constar dos dados — reproduza-o como pedido subsidiário. Nunca invente teto monetário ausente dos insumos.

SOBREAVISO × HORAS EXTRAS: confronte os intervalos horários de cada pedido. Se houver sobreposição temporal entre período postulado como sobreaviso e período simultaneamente postulado como efetivo trabalho extraordinário, impugne a cumulação pelo mesmo intervalo e peça, subsidiariamente, que não haja pagamento duplicado, com dedução/adequação do período efetivamente trabalhado conforme os fatos e provas. Não trate automaticamente todo o sobreaviso como hora extra e não invente horários."""
if anchor not in text:
    raise SystemExit('piecePrompts: âncora PROVAS não encontrada')
text = text.replace(anchor, addition, 1)

# Revisor deve detectar omissões dessas teses quando suportadas pelo relatório.
review_anchor = "- em contestação trabalhista com cartões uniformes/invariáveis, o TEXTO DA PEÇA cita expressamente a Súmula 338, III, do TST e apresenta a defesa probatória possível;"
review_add = """- em contestação trabalhista com cartões uniformes/invariáveis, o TEXTO DA PEÇA cita expressamente a Súmula 338, III, do TST e apresenta a defesa probatória possível;
- se os dados sustentarem hipersuficiência/aditivo, a contestação enfrenta expressamente o art. 444, parágrafo único, da CLT e preserva eventual vantagem remuneratória literal relevante;
- se houver pedido subsidiário de limitação do dano moral nos dados, a contestação o reproduz com o valor literal, sem inventar quantum;
- se sobreaviso e horas extras ocuparem o mesmo intervalo, a contestação enfrenta expressamente o risco de duplicidade/cumulação pelo mesmo período;"""
if review_anchor not in text:
    raise SystemExit('piecePrompts: âncora do revisor não encontrada')
text = text.replace(review_anchor, review_add, 1)
p.write_text(text, encoding='utf-8')

# 4) Motor A/Reclamante: FGTS deve aparecer como tópico específico sempre que estiver em discussão.
p = Path('functions/prompts/02_Trabalhista_Favor_Reclamante.txt')
text = p.read_text(encoding='utf-8')
old = 'FGTS: conferir extrato competência por competência e enumerar todas as lacunas não prescritas; não alegar falta onde houver depósito comprovado e não omitir mês de fronteira como março quando o extrato o indicar sem depósito.'
new = 'FGTS: conferir extrato competência por competência e enumerar todas as lacunas não prescritas; não alegar falta onde houver depósito comprovado e não omitir mês de fronteira. SEMPRE que FGTS estiver entre os pedidos ou documentos relevantes, o resumo executivo e a análise jurídica global devem conter menção específica a FGTS, indicando separadamente competências prescritas, não prescritas, depositadas e sem depósito conforme os dados. Não deixe o tratamento do FGTS implícito apenas dentro da prescrição geral.'
if old not in text:
    raise SystemExit('prompt reclamante: regra FGTS não encontrada')
text = text.replace(old, new, 1)
p.write_text(text, encoding='utf-8')

# 5) Republicação do Motor A Reclamante/Reclamada para nova sourceVersion.
p = Path('functions/scripts/publish-reclamada-v2.mjs')
text = p.read_text(encoding='utf-8')
text = text.replace('2026-09-29-trabalhista-reclamada-v6', '2026-09-29-trabalhista-reclamada-v7')
text = text.replace('2026-09-29-trabalhista-reclamante-v6', '2026-09-29-trabalhista-reclamante-v7')
text = text.replace('Análise jurídica global v6', 'Análise jurídica global v7')
p.write_text(text, encoding='utf-8')

# Remove temporários do commit final.
Path('scripts/apply_regressao_v9.py').unlink(missing_ok=True)
Path('.github/workflows/apply-regressao-v9.yml').unlink(missing_ok=True)
