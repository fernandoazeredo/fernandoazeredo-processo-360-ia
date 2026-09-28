# Processo 360 IA — Motor A/B v3 — Handoff técnico

Data: 28/09/2026
Branch: `fix-motor-b-auditoria-2026-09-28`
PR: #14

## Teste de regressão
Usar `processo_teste_trabalhista.pdf` (8 páginas) quando disponível ao testador. O arquivo contém erros plantados de propósito.

## Problemas que esta branch endereça
- `piece-vfallback`: Motor B local v3 passa a ser piso de qualidade; prompt Firestore só substitui quando versão >= 3.
- Peças poluídas por `[lote X | página Y]`, `[fl. X]`, avisos internos e divergências extensas: limpeza defensiva pós-geração e rastreabilidade mantida em `claims/sourceReference`.
- Marcador longo de informação ausente: substituição por `[DADO A CONFIRMAR]` e orientação para marcadores curtos específicos.
- Fase processual: inferência antes da peça e inclusão de `Réplica / Manifestação` nas opções.
- Trabalhista/Reclamada: checks explícitos de FGTS por competência, prescrição, art. 477, pedido sem valor, cartão britânico, atividade externa x ponto, intervalo e dano moral/BO.
- Trabalhista/Reclamante: checks equivalentes e proibição de inventar Vara/número em inicial pré-processual.
- `\\n\\n` literal no relatório: normalização recursiva em `src/ai.ts`.
- Saldo zero do administrador: `src/ai.ts` também chama quote/charge para o e-mail administrador antes do Gemini, permitindo testar a mesma regra comercial aplicada ao usuário.
- Motor A: prompts 01 e 02 v3 passam a exigir fase processual, qualificação das partes/advogados, matriz pedido x prova, contradições e prescrição por competência.
- Publicação: `functions/scripts/publish-reclamada-v2.mjs` agora publica as duas perspectivas Trabalhistas v3 no Firestore durante o deploy de produção.

## Critérios de regressão jurídica
1. FGTS: não aceitar janeiro-junho se extrato provar depósitos em abril-junho; avaliar prescrição por competência.
2. Art. 477: separar pagamento e entrega de guias.
3. Pedido de dano moral sem valor: identificar questão formal quando aplicável.
4. Cartões 8h-17h idênticos: registrar fragilidade/risco; não tratar como prova robusta sem ressalva.
5. Não sustentar atividade externa contraditória com controle de ponto/jornada fixa sem enfrentar a contradição.
6. Não transformar celular pessoal em corporativo.
7. Intervalo de 20 min: não pedir/tratar como supressão integral de 1h automaticamente.
8. Processo já ajuizado: não gerar nova inicial como próxima peça sem alerta de cabimento/fase.
9. Qualificação existente no PDF deve chegar ao relatório consolidado e ao Motor B.
10. Word/PDF da peça não deve conter referências internas de lote/página, status de validação ou aviso técnico do Motor B.

## Ainda verificar antes do merge
- CI/build da cabeça final da branch.
- Preview Firebase da cabeça final.
- Repetir o PDF de 8 páginas e comparar Motor A, Contestação e peça do Reclamante.
- Confirmar que a publicação v3 no Firestore ocorre no workflow de produção após merge.
- Verificar cobrança da geração de peça para conta administradora: o frontend ainda possui bypass `if (!isAdmin) await chargePiece()`; decidir se o administrador também deve consumir saldo em peças, como passou a ocorrer na análise.
- Cadastro persistente do advogado/escritório ainda não foi implementado nesta branch; a extração de OAB/qualificação do próprio processo foi reforçada no Motor A.
